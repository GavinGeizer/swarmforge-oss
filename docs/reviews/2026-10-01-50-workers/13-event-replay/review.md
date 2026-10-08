# SwarmForge review — durable events, SSE replay, cursors, transitions (store/http)

**Target:** `d428e0f730ed5649485732e95d39c32f5d6a8895` (branch `feature/binary-config-serve-20260930`)
**Verdict:** FINDINGS
**Reviewer:** w-4e8e705c-5065-4cc8-b33e-7fd972e27191 / task `13-event-replay`
**Checkout:** disposable detached clone at `/tmp/rv13/sw`, `git rev-parse HEAD` verified = target. `/workspace/repo` untouched at assigned baseline `5672ead`, clean.

## Scope

`src/store.ts`, `src/http.ts`, and the durable-event/cursor surfaces they feed:
`Coordinator.waitForStateChange` (`src/coordinator.ts:65-169`), `Store.events/lifecycleEvents/latestEventId`,
`GET /events` SSE replay, `get_worker_logs` pagination, `src/security.ts` redactor as used by the event path,
`src/runtime.ts:172-213` event log flush.

Out of scope (other reviewers): packaging/build, settings/config, CLI, safety, providers.

## Findings

### 1. HIGH — `GET /events` re-parses the whole worker table once per string field, blocking the single-threaded event loop

**File/line:** `src/http.ts:42-45` (call site); root cause `src/security.ts:43-50` and `src/security.ts:7`.

`redactorFor(c)` returns a `Redactor` whose `secrets` is a **thunk**, not a snapshot. `Redactor.text()` calls
`this.secrets()` on every invocation, and `redactor.value()` recurses into every string field of every event. Each
thunk evaluation runs `c.store.all()`, which is `SELECT body FROM workers` + `JSON.parse` of every row — and each
worker body embeds its full `prompt` (up to 32 000 chars, `src/domain.ts:33`).

`http.ts:45` calls `redactor.value(e)` for up to 100 events per request, and each event has 3 string fields
(`worker_id`, `type`, `data`). So one page of 100 events = 300 full table scans + 300 full JSON parses.

**Trigger:** any authenticated `GET /events` (or `?after=N`) while a non-trivial number of workers exist and the
first 100 events are pending. No unusual client behaviour — this is the documented happy path
(`docs/MCP-API.md:33`, `docs/OBSERVABILITY.md:34`), and the SSE `retry: 2000` directive makes a browser
`EventSource` poll it continuously forever.

**Consequence:** at the shipped default `SWARMFORGE_MAX_WORKERS=50` with max-size prompts (1.6 MiB of worker
bodies), one request costs **~530 ms of blocked event loop**; measured 1 s at 200 workers, 4.2 s at 200 workers
with a full 100-event page. Because Bun runs the server on one thread, this stalls every other MCP call, the
coordinator tick (`SWARMFORGE_POLL_INTERVAL_MS=2000`) and `/health`. A single well-behaved SSE consumer pins the
control plane: 6 s of reconnect-polling consumed 5.7 s of event loop (**951 % of one core**). Since
`SWARMFORGE_API_TOKEN` is optional (`src/config.ts:81`), an operator running without it exposes this to any
process that can reach the port.

**Reproduction** (Bun 1.4.2, local fakes, no network; probe `repro.ts` in the disclosed /tmp area):
```
workers=50 events=100 worker body bytes=1634620
GET /events x3 = 1588ms  (529ms per request, single-threaded)
same query WITHOUT the redactor = 0ms
store.all() calls caused by redacting one 100-event page = 300
```
Scaling probe (fresh store per N, identical synthetic bodies, 100-event page):
`N=25 → 133 ms`, `N=50 → 786 ms`, `N=100 → 2001 ms`, `N=200 → 4225 ms` — linear in retained workers × page size.
Empty page (reconnect with nothing new) costs 0–1 ms, so the cost is entirely per-delivered-event.

**Why existing guards do not prevent it:** the `?after` bounds check (`http.ts:35-41`) and the `LIMIT 100`
(`http.ts:43`) correctly bound the *query*, not the *redaction*. The `redactorFor` call at `http.ts:42` looks like
per-request construction but is lazy, so it snapshots nothing. No test exercises `/events` under worker volume —
`grep -rn '/events' tests/` returns nothing; `tests/wait.test.ts` covers the in-memory waiter and
`tests/http.test.ts` covers MCP transport/auth only.

**Recommended correction:** snapshot the secret list once per request (e.g. `new Redactor(() => snapshot)` where
`snapshot` is computed eagerly, or add a `cached`/memoized `secrets`). Cheapest correct change: in
`redactorFor`, resolve the array once and close over the array. Longer term, redact the serialized JSON string
once per event rather than walking every field, and consider an `events(worker_id, id)` index (see finding 2).

### 2. MEDIUM — `wait_for_state_change` ignores its own deadline while draining a large backlog

**File/line:** `src/coordinator.ts:119-135` (`next()`), reached from `src/coordinator.ts:139` and `:160`.

`next()` loops `lifecycleEvents(cursor, filter, 200)` until it finds a match or exhausts the log. The deadline is
only checked **after** `next()` returns (`:141`, `:160`). With a non-matching `states` filter (or a cursor far
behind), the scan runs to the end of the table regardless of `timeout_ms`.

**Trigger:** a caller passes `states` that do not match yet, plus a small/stale `cursor`. `timeout_ms=0` is
documented as "checks once" (`src/mcp.ts:296`, `docs/MCP-API.md:23`) but performs a full-table drain.

**Consequence:** the MCP handler blocks the single process for the whole drain. Measured (probe `drain.ts`,
1 worker, synthetic backlog): 100 k events → 74 ms, 400 k → 289 ms, **1.6 M → 1200 ms**, with `timeout_ms=0`.
Because the `events` table has no retention (`OBSERVABILITY.md:30` makes pruning an operator responsibility) and
no index (`PRAGMA index_list(events)` returns `[]`), the drain grows without bound over server lifetime. A
caller-supplied `cursor=0` on a mature database is the cheapest trigger.

**Why guards don't prevent it:** the 200-row batch limit bounds memory per query, not total work; the deadline is
structurally checked outside the loop. `tests/wait.test.ts:135-160` only exercises small backlogs where the drain
is sub-millisecond, so the property is untested.

**Recommended correction:** pass a deadline into `next()` and break out of the batch loop when
`Date.now() >= deadline`, returning the consumed cursor. Add `CREATE INDEX IF NOT EXISTS events_worker_id ON
events(worker_id, id)`; `metrics.ts:102/113/125` run three unindexed `WHERE worker_id=?` scans plus a temp
B-tree group-by **per worker per scrape**, which is the same missing-index problem on the metrics surface.

## Verified-correct (no defect found)

Recorded so these are not re-investigated:

- **SSE replay is correct under truncation.** 301 events paged via `Last-Event-ID`: 100/100/100/1, then empty.
  Delivered 301/301, **0 duplicates, 0 missing, strictly increasing**. `next_cursor` from a wait feeds back into
  `/events?after=` correctly, and vice versa.
- **Cursor validation** rejects `abc`, `-1`, `1.5`, `>2^53` with 400. `Number()` does accept `0x10`→16, `1e3`→1000
  and `""`→0, but these only widen/reset a replay start point, never cross a data boundary — not a defect.
- **`next_cursor` on timeout** reports the fully-consumed cursor, so a filtered wait cannot silently skip another
  filter's events; matches the documented "consumed without being returned" semantics
  (`docs/MCP-API.md:27`, asserted by `tests/wait.test.ts:109`).
- **`transition()` is idempotent per state** (`src/store.ts:160`): a same-state call patches without emitting a
  duplicate event, so duplicate completion cannot duplicate events or tokens (`docs/ARCHITECTURE.md:18`).
- **Listener lifecycle** is clean: `unsubscribe()` in `finally`, `stopWaiters`/`aborted` removed on every exit
  path; `listenerCount` returns to 0 in every probe.
- **`/events` never serves live.** The body is a finite 200 with `content-length`; the server closes in ~2 ms and
  relies on client reconnect. That matches the documented "bounded SSE replay" + `Last-Event-ID` model
  (`docs/OBSERVABILITY.md:34`) — noted, not a defect.
- Event payloads carry no prompt: `worker.requested` stores `{}`, transitions store `{}`, `result.received` stores
  only `{run_id, status}` (`src/store.ts:287`). Confirmed by reading raw SSE frames.

## Tests run

Toolchain: official **Bun 1.4.2** unpacked to `/tmp/rv13/bun142/bun-linux-x64/bun` (snapshot Bun 1.3.14 cannot
read `lockfileVersion: 2`; the lockfile was **not** modified). `bun install --frozen-lockfile` into the /tmp clone.

| Command | Exit | Result |
|---|---|---|
| `bun test tests/wait.test.ts tests/http.test.ts tests/api.test.ts tests/restart.test.ts` | 0 | 22 pass, 0 fail, 114 expect() |
| `bun test` (full suite) | not run | out of scope — whole-suite reviewer's responsibility |

Reviewer probes (all under `/tmp/rv13/probe`, outside the checkout; disclosed): `sse.ts`, `sse2.ts`, `sse3.ts`,
`replay.ts`, `cursem.ts`, `stream.ts`, `drain.ts`, `block.ts`, `idx.ts`, `idx2.ts`, `scan.ts`, `sparse.ts`,
`noidx.ts`, `perf.ts`, `perf2.ts`, `scal.ts`, `scal2.ts`, `defcfg.ts`, `count.ts`, `mcpamp.ts`, `mtr.ts`,
`repro.ts`, `waitdepth.ts`, `deadline.ts`. All use local fakes (`tests/helpers.ts` `FakeProvider`/`FakeAgent`)
and `:memory:`/tmpdir SQLite. No real provider, VM, model endpoint, or cloud call. No credentials used or emitted.

Logs: `/workspace/.swarmforge/logs/rv13-targeted.log`, `/workspace/.swarmforge/logs/rv13-probes.log`.

## Limitations

- Timings are from one container on shared CPU; absolute ms will differ, but the linear scaling in retained
  workers × page size and the 300-`store.all()`-per-page count are deterministic.
- Finding 1's worst case assumes large prompts. With short prompts the cost is much smaller but still linear
  (N=50, 200 B prompts → 57 ms/request).
- Finding 2's growth depends on how large the operator's `events` table becomes; the 1.6 M-event figure is a
  synthetic upper bound, not a measured production backlog.
- Metrics indexing is cited from `EXPLAIN QUERY PLAN` and a 200 k-event render (15 ms); I did not measure
  `/metrics` under a realistic long-lived backlog.
- No concurrency test of the waiter against a busy coordinator tick was run; the listener/notify design read as
  correct and existing tests cover the abort/stop paths.
- `src/files.ts:109-145` (`get_worker_logs`) shares the redactor pattern but with a ≤100-event, single-worker
  payload; measured 14 ms at 50 workers. Reported as part of finding 1's root cause, not separately.
