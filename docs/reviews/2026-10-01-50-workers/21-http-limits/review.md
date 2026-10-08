# Reviewer report (bounded scope)

- Target: `d428e0f730ed5649485732e95d39c32f5d6a8895`
- Published branch: `feature/binary-config-serve-20260930`
- Assigned branch (untouched baseline): `5672ead2a526e07fea9ed11e58b3725e42013527`
- Verdict: **INCOMPLETE** — 6 findings, 5 reproduced locally, 1 code-evidenced with a partial probe; one confirming probe was cut off by the review deadline.
- Scope: request size/concurrency bounds, malformed JSON, connection lifecycle, resource exhaustion, error status semantics.
- Detached disposable checkout: `/tmp/swarm-rev` (probes only; `/workspace/repo` never modified).

## Findings

### F1 — MEDIUM: request idle timeout is shorter than the composed control-operation bound
- File/line at target: `src/serve.ts:175` (`idleTimeout: 60`), composed bound at `src/coordinator.ts:725-745` (`quiesce`), `src/coordinator.ts:875-906` (`applyControl` cancel).
- Trigger: a provider or OpenCode call that consumes the full `SWARMFORGE_API_TIMEOUT_MS` (default 30000) budget. `quiesce` chains up to four such calls in sequence (`agent.abort`, `provider.exec`, `provider.pauseWorker`, `vmMissing`), and cancelling a paused worker first adds `resumeWorker`. The composed worst case is roughly 120-150s against a 60s connection idle timeout.
- Consequence: Bun closes the socket while the handler is still awaiting. The client receives a transport-level `TypeError: The socket connection was closed unexpectedly` instead of an MCP result, even though the durable operation continues and completes. A lead cannot distinguish "cancel failed" from "cancel succeeded but the reply was lost", and `destroy_worker`/`cancel_worker` retries then hit `Another worker control operation is pending` (see `src/coordinator.ts:828`).
- Reproduction (bounded, local fake providers only): `/tmp/probe/cancel.ts` with a provider whose `exec` and agent `abort` hang past the API bound. Observed `cancel_worker` returning only after **60021 ms**, at the exact `idleTimeout` boundary. `/tmp/probe/idle2.ts` isolates the mechanism: `Bun.serve({idleTimeout: 3})` with a 12s handler fails the client after **4002 ms**. `/tmp/probe/idle.ts` with `idleTimeout: 2` and 5s of handler work reproduces the same client error.
- Deeper 4x25s chained case (`/tmp/probe/cancel3.ts`) was started and **not completed** — the review deadline ended the run. Treat the 120s figure as code-derived from the call chain, not measured.
- Why existing guards do not prevent it: `src/serve.ts` sets one flat `idleTimeout` for all routes. Nothing composes the route's worst-case internal budget into the connection budget, and `docs/SERVE.md` only states the general limitation ("in-flight HTTP requests are drained only to the extent the coordinator tracks them"). No test asserts a tool call's composed bound against the idle timeout.
- Recommendation: derive the server idle timeout from the composed budget (for example `SWARMFORGE_API_TIMEOUT_MS * 5 + margin`), or bound each mutating tool call as a whole so no single request can exceed the connection budget. Prefer a bound expressed in the same units as the timeout so the two cannot drift.

### F2 — MEDIUM: `/metrics` render is unbounded per scrape and the metrics listener has no access check
- File/line at target: `src/serve.ts:177-190` (listener, no bearer/host check, unlike `src/http.ts:9-29`), `src/metrics.ts:74-131` (per-worker and per-dispatch SQL).
- Trigger: any GET to `/metrics` on `SWARMFORGE_METRICS_PORT`. `Metrics.render` iterates every retained worker and issues `store.tokens`, a `GROUP BY` events query, a `min(at)` query, and one query per completed dispatch. Nothing bounds worker count or scrape rate.
- Consequence: scrape cost grows superlinearly with retention. Reproduced: **50 ms** at 200 retained workers, **731 ms** at 1000, **5125 ms** at 3000; `store.all()` alone was **192 ms** at 3000. A scrape loop against a long-lived deployment pins the server event loop. Because the metrics listener skips the host allowlist and bearer check that `src/http.ts` applies, any client that can reach the metrics port can trigger this.
- Reproduction: `/tmp/probe/scale.ts` (temporary SQLite file, real `Store`/`Metrics`, fake provider) — counts above.
- Why existing guards do not prevent it: `SWARMFORGE_MAX_WORKERS` (50) and `SWARMFORGE_MAX_QUEUE` (1000) bound *active* work, not retained rows; nothing prunes the `workers` table (`grep` for `DELETE FROM` in `src/` returns nothing). No test covers metrics render cost or metrics authentication.
- Recommendation: cache or incrementally pre-aggregate metrics instead of re-deriving from SQLite on every scrape, apply the same bearer/host check to the metrics listener, and add a scrape concurrency guard.

### F3 — MEDIUM: `/events` cost scales with total retained workers per request
- File/line at target: `src/http.ts:34-52`, `src/security.ts:43-50` (`redactorFor` reads `c.store.all()`), `src/security.ts:5-23` (`text` loops every secret across 3 variants).
- Trigger: one authenticated GET `/events?after=0`. The handler calls `redactorFor(c)`, whose secret set is 3 deployment secrets plus one `server_password` per retained worker, then redacts up to 100 events against every one of those secrets in raw, percent-encoded and base64 form.
- Consequence: **1981 ms** for a single 15.8 KiB replay at 1000 retained workers (measured, twice). Repeated `/events` polling from a lead is a straightforward event-loop stall.
- Reproduction: `/tmp/probe/fanout.ts` (1000 workers, 4000-char prompts) — two consecutive `/events` rounds at 1981 ms and 1986 ms. `/tmp/probe/redact.ts` isolates the scaling of `redactorFor(...).text(...)`: 0.30 ms at 10 retained, 0.96 ms at 100, 3.52 ms at 400, **9.11 ms** at 1000.
- Why existing guards do not prevent it: the replay is bounded to 100 events, but the per-event redaction secret set is not bounded by anything, and there is no retention prune.
- Recommendation: build the secret set once per response rather than per event, and bound or index the per-worker secret contribution.

### F4 — MEDIUM: no server-side concurrency cap; one batched request can hold 1000 store listeners
- File/line at target: `src/http.ts:87-99` (one MCP server per POST, no admission control), `src/mcp.ts:294-317` (`wait_for_state_change`), `src/store.ts:42-56` (`subscribe`/`notify`).
- Trigger: a JSON-RPC batch inside a single POST under the 128 KiB request cap. The cap bounds bytes, not calls: 1000 `wait_for_state_change` invocations fit in **123891 bytes**.
- Consequence: reproduced **1000 store listeners registered from one connection** (`pendingRequests: 1`). Each durable event then schedules a `queueMicrotask` fan-out to all of them, and each woken waiter runs a 200-row SQL scan. Measured fan-out cost for one event with 256 concurrent waiters was **101 ms** of synchronous work; 2000 waiters took 48 s to settle. Bun's own `pendingRequests` ceiling was observed at 256, which is a transport limit, not an admission policy.
- Reproduction: `/tmp/probe/batch.ts` (1000-call batch, 123891 bytes, 1000 listeners on one connection); `/tmp/probe/cap.ts` (1200 concurrent requests, 256 listeners held, `pendingRequests: 256`); `/tmp/probe/fanout.ts` (2000 waiters, 48 s settle).
- Why existing guards do not prevent it: `maxRequestBodySize: 131072` and the 413 check at `src/http.ts:63-79` bound size only. `timeout_ms` is capped at 25000 but the number of concurrent waiters is uncapped. `store.listenerCount` is exposed for tests (`src/store.ts:38-40`) but nothing enforces a maximum.
- Note: clean teardown works — client abort released its listener (1 → 0) and listeners returned to 0 after every batch, so this is a resource-exhaustion finding, not a leak.
- Recommendation: cap concurrent in-flight requests and concurrent `wait_for_state_change` waiters with an explicit limit and a 503/429 refusal, independent of request byte size.

### F5 — LOW: transport-level failures collapse into a silent, undiagnosable 500
- File/line at target: `src/http.ts:92-99`.
- Trigger: any throw out of `server.connect` or `transport.handleRequest`.
- Consequence: the catch discards the error object entirely and returns a bare `MCP request failed` with no log line, no request correlation and no redacted detail. Genuine internal faults (a closed database during shutdown, a client disconnect surfacing as a throw) are indistinguishable from each other in the field.
- Reproduction: code trace; not separately probed.
- Why existing guards do not prevent it: the `finally` at `src/http.ts:97-99` closes the server correctly, so this is purely a lost-diagnostic problem. No test asserts that an internal transport throw is reported.
- Recommendation: log the redacted error (the redactor at `src/security.ts` is already in scope in this handler) before returning the 500.

### F6 — LOW (verified good, recorded as scope coverage): malformed JSON and oversize bodies are handled correctly
- File/line at target: `src/http.ts:63-85`.
- Reproduced outcomes, all as intended: empty body → 400 `Invalid JSON`; `{oops}` and a truncated object → 400 `Invalid JSON`; `null`, `5`, `"hi"` and `[1,2,3]` → 400 with JSON-RPC `-32700`; declared-short `content-length` with a 200 KB body → 413; chunked oversize body → 413; a 298891-byte batch → 413. `/tmp/probe/http-probe.ts`.
- No defect. Listed so the coverage is auditable.

## Tests actually executed

- `bun test tests/http.test.ts tests/wait.test.ts tests/serve.test.ts` with official Bun **1.4.2** (snapshot Bun is 1.3.14 and cannot read `lockfileVersion: 2`; the lockfile was not rewritten). Result: **33 pass, 0 fail**, 189 expect() calls, exit 0.
- `bun install --frozen-lockfile` under Bun 1.4.2 succeeded (125 packages).
- Custom probes (all under `/tmp/probe`, outside the checkout, fake providers only, no cloud or model calls): `http-probe.ts`, `conc.ts`, `fanout.ts`, `redact.ts`, `scale.ts`, `lifecycle.ts`, `cap.ts`, `batch.ts`, `idle.ts`, `idle2.ts`, `slowbody.ts`, `destroy.ts`, `cancel.ts`, `cancel2.ts`. All completed with exit 0 except `cancel3.ts` (killed by the deadline) and `cap.ts` on its first run (exceeded a shell timeout, re-run at a smaller N).
- No full suite run (out of scope for this reviewer) and no compile/`check` run.

## Limitations

- One planned probe (`cancel3.ts`, the 4x25s chained quiesce case) was cut off by the 30-minute review deadline; F1's worst-case figure is code-derived, not measured.
- F3, F4 and F2 costs are measured against synthetic retention on local SQLite. Real deployments with a Freestyle-backed provider would have different absolute timings; the *shape* (unbounded in retained rows) is what is reproduced.
- `bun test` was scoped to three files; the other 17 test files were not run.
- No real cloud, model provider or infrastructure smoke was performed, and no credentials were used.