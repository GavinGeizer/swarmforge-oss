# SwarmForge review — scope: schema/migrations, query indexes, growing events/results/history, pagination cost and retention at scale

- **Exact target reviewed:** `d428e0f730ed5649485732e95d39c32f5d6a8895` (branch `feature/binary-config-serve-20260930`), verified with `git rev-parse HEAD` in a disposable detached clone at `/tmp/rev12/repo`.
- **Assigned branch `/workspace/repo`** is at baseline `5672ead` and was left untouched/clean (baseline ≠ target).
- **Verdict:** FINDINGS (2 HIGH, 3 MEDIUM, 3 LOW)
- **Mode:** read-only review. No source changes, no commits/pushes, no provider/infra calls.
- **Probes (disclosed, outside the checkout):** `/tmp/rev12/probe/*` — synthetic SQLite databases created with the target DDL plus standalone Bun scripts that import the *real* `src/store.ts` and `src/security.ts` from the target clone. No repo dependencies were installed and no cloud/VM/model endpoint was contacted. Logs: `/workspace/.swarmforge/logs/rev12-probes.log`, scripts copied to `/workspace/.swarmforge/logs/probe*.ts`.

## What the schema looks like at target

`src/store.ts:22-32` creates the whole schema with `CREATE TABLE/INDEX IF NOT EXISTS` on every open: `teams`, `tasks`, `workers`, `events`, `dispatches`, `usage`, `settings`, plus indexes `workers_state(state)` and `dispatch_worker(worker_id)`. `PRAGMA user_version` is 0 (no migration ledger). Every worker field is stored twice: as columns and inside the JSON `body`. Verified via `sqlite_master` that no index exists on `events(worker_id)`, `events(type)`, or `usage(worker_id)` beyond the `usage` primary key autoindex.

---

## F1 — HIGH — `/metrics` render is O(retained workers × retained events): one scrape stalls the whole control plane

**Where:** `src/metrics.ts:74` (`store.all()`), `:84` (`store.tokens({worker_id})`), `:100-104` (`GROUP BY type` per worker), `:110-115` (`min(at)` per worker), `:121-127` (one `json_extract` event scan **per dispatch**).

**Trigger:** any scrape of `/metrics` (`src/serve.ts:178-190` calls `metrics.render()` synchronously on the shared Bun event loop) on a database that has accumulated history. It is unbounded in retained workers because nothing is ever deleted (see F4).

**Code trace:** `render()` loops over *every* retained worker row (`store.all()`), and for each one issues 2 full-table `events` scans plus one `usage` aggregate, and for each of that worker's dispatches another full `events` scan with `json_extract(data,'$.run_id')`. `events` has no index on `worker_id`, so each is `SCAN events` (confirmed with `EXPLAIN QUERY PLAN`).

**Consequence:** the single-threaded server is blocked for the whole render, so MCP tool calls, the coordinator tick (`coordinator.ts:286-289`, default 2000 ms) and the event-log flush all stall behind it. Histograms/counters are reconstructed from scratch on every scrape instead of being maintained incrementally.

**Reproduction (reproduced, local sqlite3 + real SQL text from `metrics.ts`):**
- 200 workers / 8 000 events → one metrics render's statement set: **0.525 s**
- 800 workers / 80 000 events → same workload: **27.55 s** (10× the rows → ~52× the time, i.e. quadratic)
- 5 000 workers / 250 000 events / 100 000 usage rows → **150.8 ms for a single worker** (measured through the real `Store`), extrapolating to minutes per scrape.

**Why existing guards/tests don't prevent it:** `tests/api.test.ts:134` and `tests/excerpt.test.ts:145` render metrics on a harness with a handful of workers, so the quadratic factor is invisible. Nothing bounds the number of workers `render()` visits, and no index exists to make the per-worker scans cheap.

**Recommendation:** (a) add `CREATE INDEX IF NOT EXISTS events_worker_id_id ON events(worker_id, id)` and `events_worker_id_type ON events(worker_id, type, at)` as idempotent DDL in the constructor; (b) replace the per-worker event queries with set-based aggregates, e.g. `SELECT worker_id, type, count(*) FROM events GROUP BY worker_id, type` and `SELECT worker_id, min(at) FROM events WHERE type='worker.ready' GROUP BY worker_id`, or persist running counters at transition time; (c) restrict the histogram loops to workers whose dispatch history is still relevant; (d) consider serving metrics from a cached snapshot updated by the tick instead of per scrape.

---

## F2 — HIGH — `Store.tokens()` full-scans `usage` because of the `? IS NULL OR col=?` idiom, and it is on the 2-second poll path

**Where:** `src/store.ts:326-336` (query text), called from `src/coordinator.ts:614-616` (every poll per active worker, enabled by default via `SWARMFORGE_TOKEN_IDLE_TIMEOUT_SECONDS=300`, `src/config.ts:87`), `src/store.ts:261` (`claimDispatch`, every dispatch claim), `src/security.ts:145` (`publicWorker`, every worker-view tool response) and `src/metrics.ts:84`.

**Trigger:** any running dispatch. Every poll calls `tokens({worker_id})` to detect token progress; the aggregate is computed over the *entire* `usage` table even though it asks for one worker.

**Code trace / plan:** the `WHERE (? IS NULL OR worker_id=?) AND (? IS NULL OR team_id=?) AND (? IS NULL OR task_id=?)` form makes the `worker_id` predicate opaque to the planner, so the plan is `SCAN usage` + `SEARCH workers`, instead of `SEARCH usage USING sqlite_autoindex_usage_1 (worker_id=?)` — which the same query uses when the predicate is a plain `worker_id=?`.

**Reproduction (reproduced, real `Store.tokens`, 5 000 workers / 250 000 events / 100 000 usage rows):**
- `tokens({worker_id:"w-000001"})` as implemented: **7.9 ms**; the identical aggregate with a plain predicate: **0.1 ms** (≈80× slower, and it grows linearly with total messages ever recorded).
- With 50 concurrently running workers this is ~0.4 s of blocking CPU per 2 s tick, before any MCP traffic.

**Why existing guards/tests don't prevent it:** `recordProgress`/`claimDispatch` are covered by behaviour tests with a handful of usage rows; nothing asserts a query plan or bounds the `usage` table, and `usage` rows are never pruned (F4).

**Recommendation:** keep the `usage` PK but stop hiding predicates behind the nullable-parameter OR. Use two static statements (unfiltered and filtered), or build the `WHERE` fragment from the provided filters at call time, so `worker_id=?` becomes an index seek.

---

## F3 — MEDIUM — worker-scoped event pagination degrades to a full-table scan; no index backs `events(worker_id)`

**Where:** `src/store.ts:176-182` (`events()`), `src/store.ts:191-212` (`lifecycleEvents()`, backing `wait_for_state_change`), schema at `src/store.ts:27`.

**Trigger:** `get_worker_logs` (`src/mcp.ts:172-182`, `after` defaults to 0) or `wait_for_state_change` replaying from an old cursor for a worker whose events sit deep in the table.

**Consequence:** with `after=0` and a worker-filtered read, the `(? IS NULL OR worker_id=?)` term cannot be indexed, so SQLite only uses the `id>?` rowid seek and filters every later row. Measured **20.4 ms** for a single 100-row page at 250 000 events (mid-table worker) versus **0.1 ms** unfiltered; `lifecycleEvents(0,{worker_id},200)` **18.8 ms**. Cost grows with total history, not with page size, so paging a worker's own history degrades as the database grows.

**Reproduction / validation:** after adding `CREATE INDEX ev_worker ON events(worker_id, id)` to the probe database, the plan became `SEARCH events USING INDEX ev_worker (worker_id=? AND id>?)` and the same page dropped from ~9-27 ms to **0.2 ms** (45-135×). Note the OR-guarded form still chose the rowid seek even with the index present, so both the index and the predicate rewrite are needed.

**Why existing guards/tests don't prevent it:** `tests/wait.test.ts` and log tests run against a nearly empty `events` table; `limit` is capped at 100 by the MCP schema, so the cost is in the scan, not the page size.

**Recommendation:** add `events(worker_id, id)` (and `events(worker_id, type, at)` for the metrics queries in F1), and rewrite `events()`/`lifecycleEvents()`/`tokens()` to use explicit filtered/unfiltered statements instead of the nullable-parameter OR idiom.

---

## F4 — MEDIUM — nothing is ever deleted: history grows without bound and every read path is O(history)

**Where:** whole `src/store.ts` (no `DELETE`, no pruning, no retention setting) — schema at `:22-32`; consequences in `src/coordinator.ts:316` and `:363` (`store.all()` twice per tick and twice per reconcile), `src/security.ts:48` (`store.all()` per redactor construction), `src/metrics.ts:74`, `src/mcp.ts:96-113` (`list_workers` scans everything and slices in JS).

**Trigger:** normal operation over time. `destroy_worker` only transitions a worker to `destroyed` (`src/coordinator.ts:969`); its events, dispatches (with up to 60 KiB results each, bounded by `resultSchema` in `src/domain.ts:44-79`), usage rows and worker body remain forever.

**Consequence (reproduced):**
- `store.all()` = **5.9 ms** at 5 000 retained workers (JSON-parses every body), called at least twice per 2 s tick and twice per 30 s reconcile.
- `redactorFor` (`src/security.ts:44-49`) loads every worker and then runs `replaceAll` for **3 variants of every retained worker's `server_password`** over every MCP response (`src/mcp.ts:14,40`): **13-16 ms per tool response** at 5 000 workers, growing linearly with retention (secret-list building is a defence-in-depth cost worth paying; the per-response rescan is not).
- `list_workers` does `store.all()` + JS filter + slice, so `limit` does not reduce database or parse work at all (`src/mcp.ts:96-113`).
- `dispatch()`/`result()`/`publicWorker` re-read every dispatch of a worker, including completed ones (F5).

**Why existing guards/tests don't prevent it:** `docs/OBSERVABILITY.md:30` explicitly delegates backup/retention of the SQLite file to the operator, and `docs/ARCHITECTURE.md:30` states no automatic destruction occurs — so growth is by design, but the design ships no pruning hook and every reader pays for the history. Tests all use small databases.

**Recommendation:** add an idempotent retention pass (e.g. on startup and in the reconcile branch of `runTick`) that prunes `events`/`usage`/`dispatches` for destroyed/cancelled workers older than a configurable window, plus `PRAGMA wal_checkpoint`/`incremental_vacuum`; push `team_id`/`task_id`/`state` filtering down into SQL for `list_workers`/`get_task`/`get_team_status`; and build the redactor's secret set once per request from a targeted query instead of re-reading and re-deriving it for every payload.

---

## F5 — MEDIUM — unbounded completed-dispatch history per worker is re-parsed on every poll and every tool response

**Where:** `src/store.ts:229-235` (`dispatches()` loads every row), `:236-240` (`dispatch()`), `:300-306` (`result()`); callers `src/coordinator.ts:215` (queue-full check), `:793`, `:933`, `:949`, and `src/security.ts:146-148` (`pending_messages`).

**Trigger:** a worker reused for many follow-up turns (`send_worker_message` on a `failed`/`recovery_required` worker, or repeated turns after `finish` → `ready`). Only *non-terminal* dispatches are capped at 100 (`src/coordinator.ts:215-217`); completed dispatches accumulate without limit, each holding a result body of up to 60 KiB.

**Reproduction (reproduced, 20 workers × 300 completed dispatches, 78 MB database):**
- `dispatch(worker)` **8.1 ms**, `result(worker)` **8.3 ms**, one `publicWorker`'s store work **8.8 ms**
- `list_workers(limit=20)` equivalent (20 × `tokens` + `dispatches`) **95.2 ms** of synchronous JSON parsing on the event loop.

This is reached in the 2 s poll loop per active worker and on every MCP response that includes a worker view, and it grows with both the number of listed workers and each worker's turn count.

**Why existing guards/tests don't prevent it:** the 100-message cap bounds only the pending queue; nothing bounds or indexes completed history, and tests exercise 1-2 turns per worker.

**Recommendation:** query only what each caller needs — `WHERE worker_id=? AND state NOT IN ('completed','cancelled')` for the pending-queue check and `pending_messages` (ideally `SELECT count(*)`), and fetch a result by `run_id`/latest with a targeted indexed query instead of loading and parsing the worker's whole dispatch history.

---

## F6 — LOW — the `workers_state` index is dead weight; the `state` column is never read by a query

**Where:** `src/store.ts:26` (`CREATE INDEX IF NOT EXISTS workers_state ON workers(state)`); `state` is written at `src/store.ts:149` and only ever filtered in JavaScript (`src/mcp.ts:100-106`, `:263`, `:277`; `src/metrics.ts:75-83`; `src/coordinator.ts:172-185, 316-345`).

**Consequence:** every `patch()` maintains an index that no query uses, adding write cost to the hottest write path (every transition) and to `store.all()`/`teams()` planning, while the state-based queries that exist stay full scans. Verified by grepping all SQL in `src/`: the only `state=` occurrences are the `UPDATE ... SET state=?` at `store.ts:149` and `store.ts:243`.

**Recommendation:** either push state filtering into SQL (`WHERE state IN (...)`, which then uses the index, including inside `list_workers`) or drop the index.

---

## F7 — LOW — event-log cursor is persisted once per event instead of once per flush (write amplification)

**Where:** `src/runtime.ts:210` inside the `for` loop of `eventLogger` (`:177-212`), flushed every 1000 ms by `src/serve.ts:193` with up to 100 events per pass.

**Trigger:** any event burst. `Store.setting()` (`src/store.ts:57-63`) is its own autocommit transaction, and `PRAGMA synchronous` is 2 (FULL, verified on a target-created database), so each of up to 100 iterations performs a separate WAL commit + fsync.

**Consequence:** up to ~100 fsynced transactions per second under load, and a crash can leave the cursor advanced for only part of a batch (harmless for correctness — the cursor only moves forward and the loop is idempotent per event — but it multiplies fsyncs for no benefit).

**Recommendation:** record `after` once after the loop completes (the value already persists across restarts via `setting("logged_event")`).

---

## F8 — LOW — no schema-version ledger; positional inserts make the first future column addition a runtime break

**Where:** `src/store.ts:22-32` (DDL only, `PRAGMA user_version` = 0 verified), `src/store.ts:118` (`INSERT INTO workers VALUES(?,?,?,?,?,?)`), `src/store.ts:225` (`INSERT INTO dispatches VALUES(?,?,?,?,?)`).

**Trigger:** the first release that adds or reorders a column in `workers`/`dispatches`. `CREATE TABLE IF NOT EXISTS` is a no-op on an existing database, so the positional insert would fail at runtime against every retained production database instead of being migrated.

**Status:** latent, not currently triggerable — the DDL is byte-identical across every commit that touched `src/store.ts` (`9ee8fea`, `96e556c`, `3e54f90`, `b99de22`, `d428e0f`), so no upgrade path has been needed yet. Because retention is permanent (F4), this becomes more likely over time.

**Recommendation:** set and check `PRAGMA user_version`, apply ordered `ALTER TABLE` migrations in the constructor, and name columns explicitly in the two positional inserts.

---

## Tests, probes and limitations

- **Executed (all local, all outside the source checkout):** 7 Bun 1.3.14 scripts importing the target's real `src/store.ts` / `src/security.ts` (no `bun install`, no dependency resolution, so the lockfile was never rewritten), plus `sqlite3` 3.45.1 statement batches built from the target's own SQL text. Every probe exited 0; counts and timings are in `/workspace/.swarmforge/logs/rev12-probes.log`.
- **Not run:** the repository test suite (`bun test`) and `bun run check`. Reasons: this scope needs only store/query-level evidence, the whole-suite role belongs to another reviewer, and the snapshot's Bun 1.3.14 may not read this lockfile (`lockfileVersion 2`) so `bun install` would have required fetching Bun 1.4.2. No test failures are claimed or hidden.
- **Synthetic data only:** probe databases were built from the target DDL with placeholder strings; no real credentials, cloud accounts, VMs, or model endpoints were used, and no repository `.env` or secret file was read.
- **Extrapolations, not measurements:** the "minutes per scrape" and per-tick CPU figures for 5 000+ retained workers scale linearly/quadratically from measured points (150.8 ms per worker; 0.525 s → 27.55 s for 10× rows). Real event payload sizes and dispatch-result sizes were approximated within the schema's own limits (prompt ≤ 32 000 chars, result ≤ 60 KiB).
- **Out of scope here** (other reviewers): token-accounting semantics of the `usage` max-upsert (`store.ts:319`), coordinator/provider lifecycle races, Git handoff, packaging/config. `events`/`dispatches` correctness semantics were read but produced no defects beyond the pagination cost above.