# SwarmForge reviewer report — 50/400-worker operational limits

- **Exact target:** `d428e0f730ed5649485732e95d39c32f5d6a8895` (branch `feature/binary-config-serve-20260930`)
- **Verified:** `git rev-parse HEAD` = `d428e0f730ed5649485732e95d39c32f5d6a8895` in a disposable detached clone at `/tmp/sfrev/tmprepo`.
- **Assigned workspace** `/workspace/repo` left at baseline `5672ead2a526e07fea9ed11e58b3725e42013527`, clean, unmodified.
- **Reviewer scope (exclusive):** cross-system review for 50/400-worker operational limits — scheduler complexity, provider/model backpressure, per-worker locks, event loop / resource bottlenecks. No real providers, no real VMs, no real credentials.
- **Verdict:** FINDINGS (1 HIGH + 1 HIGH + 3 MEDIUM + 1 LOW).
- **Toolchain:** Bun 1.4.2 installed to `/tmp/bun142` (snapshot ships 1.3.14, which cannot read `lockfileVersion: 2`). Lockfile never rewritten.

## Method

Read `README.md`, `.agents/skills/using-swarmforge/SKILL.md`, `docs/ARCHITECTURE.md`, and the full source at target. Six bounded local probes were run **outside the source checkout** in `/tmp/sfrev/probe`, importing target modules by absolute path and using only fake `WorkerProvider`/`CodingAgent` doubles plus a real SQLite file under `/tmp`. No network calls to any provider, no VM created, no smoke test.

Probe scripts (disclosed, disposable): `p1-redactor.ts`, `p2-redact-payload.ts`, `p3-metrics.ts`, `p4-tick.ts`, `p5-recover.ts`, `p6-wait.ts`.

Targeted repo tests run: `bun test tests/core.test.ts tests/lifecycle.test.ts` → 44 pass, 0 fail, exit 0. This confirms the toolchain and coordinator behaviour are as read; the suite itself uses `SWARMFORGE_MAX_WORKERS=2` (`tests/helpers.ts:20`), so it exercises none of the scale paths below.

---

## F1 — HIGH — Redactor re-reads the entire worker table and rescans every string once per secret

**File/line at target:** `src/security.ts:5` (`Redactor.text`), `src/security.ts:43-50` (`redactorFor`), `src/security.ts:24-37` (`value` recursion). Hot callers: `src/coordinator.ts:650-651`, `src/coordinator.ts:707`, `src/runtime.ts:185,198`, `src/mcp.ts:40`, `src/http.ts:42`, `src/files.ts:70,103,135`.

**Trigger.** `redactorFor` returns `new Redactor(() => [... c.store.all().map(w => w.server_password)])` — a *lazy* closure. `text()` calls `this.secrets()` on **every invocation**, so every redacted string performs a full `SELECT body FROM workers` scan plus a `JSON.parse` per row, then runs `(3 + workers) × 3` = 1209 `String.replaceAll` passes at 400 workers. `value()` recurses per field, so an N-field response triggers N full scans.

**Consequence.** Large synchronous event-loop blocks. SwarmForge is single-process/single-threaded: coordinator stepping, the 2 s poll timer, the 1 s event-log flush, `/metrics` and all MCP requests share the loop, so these stalls delay provisioning, deadline/token-idle enforcement and every request.

**Reproduction (Bun 1.4.2, real SQLite, fake provider/agent):**

| measurement | 50 workers | 200 | 400 |
|---|---|---|---|
| `list_workers` page of 100, response redaction only | 79.4 ms | 474.9 ms | **1013.5 ms** |
| one `coordinator.tick()` (5 assistant msgs/snapshot, stable excerpt text) | 33.7 ms | 268.7 ms | **821.3 ms** |
| `eventLogger` first flush (1600 pending events, 100/pass) | — | — | **1291.5 ms** |

Tick scaling (33.7 → 68.5 → 268.7 → 821.3 ms for 50/100/200/400 workers) is superlinear, consistent with N redactions × O(N) table scan. The event-log flush is scheduled by `setInterval(flush, 1000)` (`src/serve.ts:193`), so at 400 workers a single flush exceeds its own interval.

**Why existing guards/tests do not prevent it.** `tests/helpers.ts:20` sets `SWARMFORGE_MAX_WORKERS: "2"`, so no test ever builds a list longer than 2 and the per-secret loop is never exercised at scale. `tests/api.test.ts:142` asserts redaction *correctness*, not cost; `tests/excerpt.test.ts` passes its own `redact` callback and never reaches `Redactor`. There is no timeout or cost assertion anywhere on the MCP or flush paths.

**Recommendation.** Materialize the secret list once (a `Set<string>` refreshed on worker create / config load) and pass it into `text()`; or replace the 3-variant `replaceAll` loop with a single alternation regex built once per secret-set. At minimum, hoist `this.secrets()` out of `text()` into `value()` so one response costs one scan, not N.

---

## F2 — HIGH — `/metrics` render is O(workers × events); `events.worker_id` is not indexed

**File/line at target:** `src/metrics.ts:100-104` (per-worker `GROUP BY type` scan), `src/metrics.ts:111-115` (`min(at)` scan), `src/metrics.ts:121-129` (per-completed-dispatch `json_extract` scan), loop opening at `src/metrics.ts:81`. Schema: `src/store.ts:27` declares no index on `events.worker_id` (only `workers_state` at `:26` and `dispatch_worker` at `:29`).

**Trigger.** Any scrape of `http://host:9090/metrics`. The `for (const w of all)` loop issues three full-table `events` scans per worker per scrape.

**Consequence.** Synchronous event-loop stall on every scrape, scaling with the product of worker count and lifetime event count — both of which grow monotonically in a long-lived deployment.

**Reproduction.** `EXPLAIN QUERY PLAN` for the `GROUP BY type` query at target returns `["SCAN events", "USE TEMP B-TREE FOR GROUP BY"]` — confirming no index use. Measured `Metrics.render()`:

| workers | events rows | usage rows | render time |
|---|---|---|---|
| 50 | 250 | 1000 | 9.1 ms |
| 200 | 1000 | 4000 | 67.9 ms |
| 400 | 2000 | 8000 | **253.6 ms** |

This used only 5 events per worker; a long-running 400-worker deployment accumulates tens of events per worker, so the same code path grows linearly from here.

**Why existing guards/tests do not prevent it.** No test builds more than 2 workers (`tests/helpers.ts:20`), so the three-scan-per-worker shape is never run at scale. There is no metrics-render budget assertion.

**Recommendation.** Add `CREATE INDEX IF NOT EXISTS events_worker_type ON events(worker_id,type,at)` to the schema in `src/store.ts`, and replace the per-worker loop with per-team `GROUP BY worker_id`/`GROUP BY team_id` aggregations. Store `run_id` as a column on the `result.received` event rather than filtering with `json_extract(data,'$.run_id')`.

---

## F3 — MEDIUM — No concurrency cap on provider/agent fan-out

**File/line at target:** `src/coordinator.ts:340-352` (`Promise.allSettled` over every non-terminal, non-paused, non-queued worker on each 2 s poll), `src/coordinator.ts:397-400` (`Promise.all` over every worker with a `vm_id` on each 30 s reconcile and at startup).

**Trigger.** Default configuration with `SWARMFORGE_MAX_WORKERS` raised to the documented scale (the config schema imposes only `positive()`, no upper bound — `src/config.ts` `SWARMFORGE_MAX_WORKERS`).

**Consequence.** Hundreds of simultaneous outbound TLS connections to the Freestyle API and to each worker's OpenCode endpoint. There is no client-side semaphore, retry budget or 429 handling; `FreestyleProvider` (`src/providers/freestyle.ts:20-24`) only attaches a per-request timeout. Provider-side rate limiting or socket exhaustion becomes the failure mode, and a slow provider holds the whole fan-out until `SWARMFORGE_API_TIMEOUT_MS` (30 s default) expires.

**Reproduction.** `Coordinator.recover()` with 400 workers and a fake provider instrumented for concurrency returned `provider_getWorker_calls: 400`, `peak_concurrent_provider_requests: 400`.

**Why existing guards/tests do not prevent it.** `exclusive(id, fn)` (`src/coordinator.ts:266-271`) serializes per worker ID only; it imposes no cross-worker bound. Tests run at `SWARMFORGE_MAX_WORKERS=2`, so peak concurrency of 2 is indistinguishable from correct behaviour.

**Recommendation.** Route provider/agent calls in `runTick` and `runRecover` through a bounded pool (e.g. 16–32 concurrent), and treat provider 429/5xx as backpressure (skip this tick) rather than an error that lands in the worker's `error` field.

---

## F4 — MEDIUM — Full session history is refetched every poll and re-upserted message-by-message

**File/line at target:** `src/providers/opencode.ts:116-129` (`while (page.length === 100)` walks all older pages on every `inspect()`), `src/coordinator.ts:544-554` (one `store.usage()` UPSERT per assistant message in the snapshot, every poll).

**Trigger.** Any worker in `running`/`waiting` with more than one page of session history — i.e. any long-running session.

**Consequence.** `ceil(history / 100)` **sequential** HTTP round trips per worker per `SWARMFORGE_POLL_INTERVAL_MS`, and a history-proportional volume of synchronous SQLite UPSERTs per tick. At 400 workers with a 250-message session that is 1200 requests per 2 s tick plus 100k UPSERTs, on top of F1.

**Reproduction.** `coordinator.tick()` at 400 workers × 60 assistant messages per snapshot: `tick_ms: 359.5` of SQLite bookkeeping alone with the excerpt path disabled; enabling the excerpt redaction path (5 messages, 2000-char text) raised the same tick to `821.3 ms`. Fan-out of HTTP pages itself was not exercised (fake agent returns the snapshot directly), so the request-count half is code-evidenced only.

**Why existing guards/tests do not prevent it.** `tests/session-status.test.ts` and `tests/token-idle.test.ts` use short fake sessions; no test exercises multi-page history or a session large enough to make the per-poll write volume visible.

**Recommendation.** Fetch only messages newer than the highest message id already recorded for the worker, or bound `inspect()` to the current dispatch's message subtree. Skip the `usage()` write when the stored row already holds equal or greater totals instead of relying on the `max()` upsert to be a no-op.

---

## F5 — LOW — `store.all()` full scans repeated within one tick and per spawn

**File/line at target:** `src/coordinator.ts:172` (`spawn`), `src/coordinator.ts:316` and `src/coordinator.ts:363` (two full scans inside a single `runTick`), `src/coordinator.ts:397`, `src/metrics.ts:74`, `src/mcp.ts:262,277`.

`all()` is `SELECT body FROM workers ORDER BY rowid` with a `JSON.parse` per row. One tick calls it twice; `spawn` calls it once per spawn to compute queue depth and the `request_id` retry check. Measured in isolation: 0.35 ms at 50 rows, 1.68 ms at 400 rows. Individually minor — the finding matters because it is the multiplier inside F1 and F3.

**Recommendation.** Project only the columns each caller needs, reuse a single snapshot per tick, and compute queue depth / capacity in SQL (`SELECT count(*) FROM workers WHERE state='queued'`).

---

## F6 — LOW — `runRecover` does an O(VMs × workers) linear scan

**File/line at target:** `src/coordinator.ts:373-377` — `all.find((w) => w.vm_id === vm.id)` runs inside the loop over every provider VM. At 400 VMs and 400 workers that is 160 000 comparisons every 30 s reconcile. The same function already builds a `byId` Map for the fallback lookup one line later, so the shape is an oversight rather than a constraint.

**Recommendation.** Build a `Map<vm_id, worker_id>` alongside `byId` and use it for both lookups.

---

## Not reported

- F6-style synchronous event scan in `waitForStateChange` (`src/coordinator.ts:78-95`) was probed and measured benign (2.8 ms for 800 event rows with an unmatched filter), so it is not reported as a defect.
- Per-worker lock semantics (`exclusive`, `tearingDown`, `intent`) and lifecycle correctness were read but not exercised; those belong to the lifecycle reviewers' scope and I found no scale-specific defect in them.

## Limitations

- No real cloud/model provider was contacted and no VM was created; all provider/agent behaviour is faked. Request-count and TLS-cost consequences in F3 are therefore inferred from code plus a fake-provider concurrency count, not observed against a real API.
- Probe timings are from one container with an in-memory/tmpmount SQLite file and a warm page cache; absolute milliseconds will differ on production hardware. The *ratios* between worker counts, and the `EXPLAIN QUERY PLAN` output, are the load-bearing evidence.
- The 400-worker figures were produced by direct construction of 400 worker rows, not by spawning 400 workers through the MCP surface; the scheduler's own admission control (`SWARMFORGE_MAX_WORKERS`, `SWARMFORGE_MAX_QUEUE`) was not exercised.
- I did not review packaging/build, settings/config-serving, Git handoff or CLI scopes, and did not run the full test suite.