# SwarmForge reviewer report — SQLite transactions & atomic invariants

- **Target (exact)**: `d428e0f730ed5649485732e95d39c32f5d6a8895`
- **Published branch**: `feature/binary-config-serve-20260930` (`GavinGeizer/swarmforge-oss`)
- **Assigned baseline (workspace, untouched)**: `5672ead2a526e07fea9ed11e58b3725e42013527`
- **Scope**: `src/store.ts` — SQLite transactions, atomic invariants, error rollback, concurrent
  control mutations. Call-site reachability traced in `src/coordinator.ts`, `src/security.ts`,
  `src/cli/overview.ts`, `src/runtime.ts`, `src/mcp.ts`.
- **Verdict**: FINDINGS (3 LOW / LOW-MEDIUM). No CRITICAL/HIGH found; core transaction machinery is sound.
- **Reviewer experiments**: all under `/tmp/rev11/` (disposable clone at target + probe scripts).
  `/workspace/repo` left clean and unmodified on its assigned branch.

## Note: store.ts is unchanged between baseline and target

`git diff --stat 5672ead d428e0f -- src/store.ts src/domain.ts` is empty; `git log -- src/store.ts`
shows its last touch was `3e54f90`. This review therefore assesses pre-existing code, not the
branch delta, as instructed.

---

## Finding 1 — Stale `error` survives `finish()`'s re-arm of a failed worker to `ready`

**Severity**: LOW (durable state-coherence defect; impact is display/observability only)
**File/line at target**: `src/store.ts:296-297` (re-arm), source of the stale value at `src/store.ts:294`
**Confidence**: high — reproduced end-to-end

### Defect
`Store.finish()` commits the turn outcome and the re-arm in one transaction, but the re-arm
transition passes only `completed_at`:

```ts
// src/store.ts:291-297
this.transition(id, result.status, {
  completed_at: Date.now(),
  deadline_at: null,
  error: result.status === "failed" ? result.summary : null,   // :294
});
if (this.dispatch(id))
  this.store.transition(id, "ready", { completed_at: null });  // :297  <- error not cleared
```

`transition()` merges the supplied fields over the stored worker (`src/store.ts:146-152`), so the
failure summary written at `:294` persists through the re-arm. A `failed` turn with a queued
follow-up therefore commits a worker that is `ready` (an *active* worker) while still carrying the
previous turn's terminal failure text.

### Trigger
1. Worker reaches `running` with dispatch `d1` in flight.
2. Caller sends a follow-up (`Coordinator.message` → `queueMessage`), which for a non-terminal worker
   only enqueues (`src/coordinator.ts:225-243`), so `d2` is `pending`.
3. Turn 1 settles with a structured result `{status:"failed", summary:"..."}` (accepted by
   `resultSchema`, `src/domain.ts:38-49`; produced at `src/coordinator.ts:588-593` or via the
   `result.json` fallback at `:604`).
4. `complete()` → `store.finish()`.

### Consequence
`publicWorker()` returns `state:"ready"` together with `error:"<previous failure>"`
(`src/security.ts:146`). `cli/overview.ts:232` prints `ERROR <text>` and `runtime.ts:94` appends it to
the log line. An operator inspecting a healthy, actively re-armed worker is shown a stale failure.
Grepping all `worker.error` consumers confirms **display only** — no control-flow branch reads it, so
there is no state-machine or data-loss consequence, which is why this is rated LOW.

### Reproduction (local fake provider/agent, `tests/helpers` harness)
```
worker in running; message(follow-up); agent.complete({status:"failed", summary:"lint gate failed"});
await tick();
=> state = ready, error = "lint gate failed", completed_at = null
publicWorker(...) => { state: "ready", error: "lint gate failed" }
```
(`/tmp/rev11/probe/p8.ts`, `/tmp/rev11/probe/p12.ts`; both exit 0 and assert the above.)

### Why existing guards/tests do not prevent it
- `tests/lifecycle.test.ts:229-246` ("persisting a completion atomically makes queued follow-ups
  runnable after restart") exercises the re-arm path but only with `status:"completed"`, for which
  `error` is already `null` at `:294`.
- No test asserts `error === null` for a re-armed worker.
- The sibling path shows the intended contract: `queueMessage` re-arming a terminal worker passes
  `error: null` explicitly (`src/coordinator.ts:239-243`). `finish()` omits it, so the two re-arm
  paths disagree — a consistency defect rather than a deliberate design choice.

### Recommended correction
Clear terminal-only fields on the re-arm, e.g.
`this.transition(id, "ready", { completed_at: null, error: null })`. Applying the same cleanup in
`transition()` whenever the target state is non-terminal would prevent the whole class.

---

## Finding 2 — `cancelDispatches()` is the only multi-row mutation in `store.ts` with no transaction

**Severity**: LOW
**File/line at target**: `src/store.ts:246-250`
**Confidence**: high for the atomicity gap (reproduced); medium for real-world impact

### Defect
```ts
// src/store.ts:246-250
cancelDispatches(id: string) {
  for (const d of this.dispatches(id))
    if (!["completed", "cancelled"].includes(d.state))
      this.saveDispatch({ ...d, state: "cancelled" });
}
```
Each `saveDispatch` (`:241-245`) is its own implicit transaction, so N dispatches are N separate
commits. Every other multi-statement invariant in this file wraps `this.db.transaction(...)`:
`create` (`:71`), `transition` (`:158`), `claimDispatch` (`:252`), `finish` (`:278`). `cancelDispatches`
is the outlier.

Compounding it, `Coordinator` always pairs it with a *separate* `transition`, so the
"every dispatch is cancelled **and** the worker is terminal" invariant is never a single commit:
`src/coordinator.ts:799-804` (`failed`/`recovery_required`), `:894-905` (`cancelled`),
`:935-958` and `:968-975` (`recovery_required`/`destroyed`), `:411-418`, `:489-495`, `:775-783`.
The two statements are synchronous and adjacent with no `await` between them, so there is no
JS-level interleaving window and a crash window requires killing the process mid-window.

### Trigger
Any error raised while updating one dispatch row — e.g. `SQLITE_BUSY`/`SQLITE_FULL`, or an injected
failure — aborts the loop partway.

### Consequence
Partial cancellation: some dispatches become `cancelled`, others stay `pending`/`sending`. Combined
with the missing pairing transaction, a crash between `cancelDispatches()` and the terminal
`transition()` leaves a worker in `running`/`waiting` whose dispatches are all cancelled. On the next
tick `monitor()` finds no dispatch and transitions to `waiting` (`src/coordinator.ts:536-539`), so
the worker idles until `deadline_at` (set at `claimDispatch`, `src/store.ts:256`) trips the timeout
check at `src/coordinator.ts:452-455` and it fails. Bounded and self-healing, hence LOW.

### Reproduction
Injected a throw on the 2nd `saveDispatch` inside `cancelDispatches`:
`states after partial cancel: [ "cancelled", "pending", "pending" ]` (`/tmp/rev11/probe/p7.ts`, exit 0).

### Why existing guards/tests do not prevent it
No test simulates a mid-loop failure, and no test asserts that `cancelDispatches` is atomic. The
process lock (`acquireProcessLock`, `src/runtime.ts:145-172`) and `busy_timeout=5000`
(`src/store.ts:22`) reduce the chance of a mid-loop SQLite error but do not make the loop atomic;
`ARCHITECTURE.md`'s "store.ts owns atomic SQLite mutations" is not upheld for this method.

### Recommended correction
Wrap the loop: `this.db.transaction(() => { ... })()`. Better, expose a single store method that
cancels dispatches **and** applies the terminal transition in one transaction, and have the
coordinator call that instead of the current `cancelDispatches(...)` + `transition(...)` pairs.

---

## Finding 3 — `request_id` retry idempotency depends on the config-resolved default timeout

**Severity**: LOW
**File/line at target**: `src/store.ts:72-82`
**Confidence**: high — reproduced

### Defect
`create()` fingerprints the **resolved** spawn object:
```ts
// src/store.ts:72-74
const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
```
`input` is the object built by `Coordinator.spawn`, which fills `timeout_seconds` from
`config.SWARMFORGE_DEFAULT_TIMEOUT_SECONDS` when the caller omits it
(`src/coordinator.ts:185-190`). The stored `request_fingerprint` therefore encodes an operator
setting, not just the caller's arguments, and `:81-82` throws
`"request_id already used with different arguments"` on any mismatch.

### Trigger
A caller omits `timeout_seconds` and retries with the same `request_id` after the default changed
(env edit, container restart with new config, or a `--default-timeout`-style deployment change) —
even if the retry is byte-identical to the original request.

### Consequence
The documented contract "use request_id for safe retries" (`src/mcp.ts:73`;
`ARCHITECTURE.md`: "Creation can be deduplicated with a caller-supplied request_id scoped to a team")
breaks: the retry returns an error instead of the original `worker_id`. A caller that reacts by
retrying *without* `request_id` spawns a duplicate worker (bounded only by
`SWARMFORGE_MAX_QUEUE`, `src/coordinator.ts:179-184`).

### Reproduction
Two `Coordinator` instances over one `Store`, differing only in
`SWARMFORGE_DEFAULT_TIMEOUT_SECONDS` (3600 → 1800), same `request_id` and same body:
```
original worker: w-…  timeout_seconds: 3600
RETRY REJECTED -> request_id already used with different arguments
```
(`/tmp/rev11/probe/p11.ts`, exit 0.)

### Why existing guards/tests do not prevent it
- `tests/lifecycle.test.ts:13-17` and `tests/core.test.ts:88-120` retry with an unchanged config, and
  the core test supplies `timeout_seconds` explicitly, so the fingerprint always matches.
- No test varies the resolved default between the original request and the retry.
- `spawnSchema` key-order normalisation *does* remove a related hazard (see verified-clean §), so the
  residual instability is specifically the config-derived value.

### Recommended correction
Fingerprint only caller-supplied arguments — hash the `spawnSchema` output *before*
`timeout_seconds` is resolved — and treat the effective timeout as mutable metadata rather than part
of the idempotency key. Alternatively compare a canonicalised subset (team/task/role/prompt) and log
rather than reject a timeout-only difference.

---

## Verified clean (checked, not defects — recorded to avoid re-derivation)

| Area | Result | Probe |
|---|---|---|
| `create()` full rollback on mid-transaction failure | teams/tasks/workers/events all rolled back (0 rows) after an injected failure *after* the inserts | `/tmp/rev11/probe/p13.ts` |
| Nested transactions roll back via savepoints (`finish`→`transition`→`patch`, `message`→`queueMessage`→`transition`) | inner + outer rollback both correct | `/tmp/rev11/probe/p2.ts` |
| Deliberate "enqueue then throw" rollback in `queueMessage` (`src/coordinator.ts:225-232`) | dispatch row discarded; count returns to baseline | `/tmp/rev11/probe/p2.ts` |
| `notify()` deferral (`src/store.ts:49-56`) | `queueMicrotask` fires after the synchronous commit, so waiters see committed rows. It also fires on **rollback** (spurious wake) — harmless: `waitForStateChange` re-scans and finds nothing new. No lost wakeup. | `/tmp/rev11/probe/p1.ts` |
| Cross-connection lost update on `patch()` | not reachable — `patch()` re-reads immediately before the write; `acquireProcessLock` (`src/runtime.ts:145`) enforces one owning process; `ARCHITECTURE.md` states one process owns the DB | `/tmp/rev11/probe/p10.ts` |
| `UNIQUE(team_id,request_id)` with NULL `request_id` | SQLite treats NULLs as distinct, so unlimited request-less workers are allowed (intended) | `/tmp/rev11/probe/p9.ts` |
| Fingerprint key-order stability | `spawnSchema.parse` normalises key order, so `{a,b}` vs `{b,a}` hash identically | `/tmp/rev11/probe/p5.ts` |
| WAL/SHM file permissions | `chmodSync(path, 0o600)` (`src/store.ts:21`) runs *before* `PRAGMA journal_mode=WAL` (`:22`), so `-wal`/`-shm` are created at 0600 (contain `server_password`) | `/tmp/rev11/probe/p4.ts` |
| `finish()` duplicate-completion guard | `current.state === "completed" || "cancelled"` short-circuits before any write, so no duplicate `result.received` event or token rows | `src/store.ts:279-285` |
| `transition()` same-state short-circuit (`:160`) | deliberately suppresses duplicate `worker.<state>` events (asserted by `tests/core.test.ts:113-118`); it also skips the `last_activity_at` bump, which only affects CLI sort order (`src/cli/overview.ts:41,47`) | code trace |

## Tests / probes executed

- Toolchain: Bun **1.4.2** at `/tmp/opencode/bun-linux-x64/bun` (snapshot had 1.3.14, which cannot
  read `lockfileVersion: 2`). `bun install --frozen-lockfile` in the disposable clone; `bun.lock`
  verified byte-identical afterwards (`cmp` against a pre-install copy) — lockfile never rewritten.
- `bun test tests/core.test.ts tests/lifecycle.test.ts tests/token-idle.test.ts`
  → **57 pass, 0 fail, 201 expect() calls, exit 0** (250 ms). These are the store/targeted suites for
  this scope.
- 13 standalone probe scripts under `/tmp/rev11/probe/` (all against `:memory:` stores or throwaway
  files in `/tmp`, using the repo's own `FakeProvider`/`FakeAgent`). All exited 0.
- Full suite intentionally **not** run (reserved for the whole-suite reviewer).

## Limitations
- No CRITICAL/HIGH issue surfaced; the transactional core (`create`/`transition`/`claimDispatch`/
  `finish`) is correctly wrapped and rolls back cleanly under injected failure. Findings are LOW.
- Multi-*process* concurrent writers were not exercised beyond a two-connection probe; the deployment
  model (flock + documented single owner) makes that path unreachable.
- Filesystem-permission and redaction surfaces were only spot-checked (WAL/SHM mode) and are other
  reviewers' scopes.
- No real cloud/model/infra calls: all providers and the coding agent were local fakes.
