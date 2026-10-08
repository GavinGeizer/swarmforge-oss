# SwarmForge review 08 — worker deadlines, token-progress idle detection, scheduler quiescence, false recovery detection

- Target: `d428e0f730ed5649485732e95d39c32f5d6a8895` (branch `feature/binary-config-serve-20260930`, verified `git rev-parse HEAD` in a disposable clone at `/tmp/rev08/target`).
- Assigned branch baseline (`/workspace/repo`): `5672ead2a526e07fea9ed11e58b3725e42013527`, left unchanged and clean.
- Verdict: **FINDINGS** (2 reproduced + 1 code-evidenced LOW). Review is read-only; no source changes, no commits, no pushes.

## Scope read

`src/coordinator.ts` (`step`, `monitor`, `fail`, `quiesce`, `runTick`, `runRecover`, `applyControl`, `control`),
`src/store.ts` (`claimDispatch`, `recordProgress`, `finish`, `usage`, `tokens`, `transition`),
`src/providers/opencode.ts` (`inspect`, `sessionStatus`), `src/config.ts` (deadline/idle config),
`src/domain.ts` (states/Worker/Dispatch/AgentSnapshot), `src/safety.ts` (`inspectPersistence`),
`tests/token-idle.test.ts`, `tests/session-status.test.ts`, `tests/lifecycle.test.ts`, `docs/ENVIRONMENT.md` (§deadline/quiesce).

The target delta versus baseline touches `coordinator.ts` only in shutdown/tick-tracking plumbing
(`track`, `stopWaiters`, `startProvisioning`); deadline, idle-budget and quiescence logic is unchanged
from the reviewed baseline, so findings below are existing-code defects, not new regressions.

## Finding 1 — HIGH — A durable-but-unappliable control intent permanently disables the task deadline and the token-idle quiescence, and cannot be cleared

- File/line: `src/coordinator.ts:440` (intent branch returns before every budget check),
  `src/coordinator.ts:452` (task deadline), `src/coordinator.ts:612-626` (token-idle budget),
  `src/coordinator.ts:510-526` (catch keeps the intent), `src/coordinator.ts:833` (intent written),
  `src/coordinator.ts:828-829` (a different intent is refused).
- Trigger: `pause_worker` / `resume_worker` returns a persistent provider error (Freestyle 5xx, VM in a
  transitional state, quota). `runControl` persists `intent` durably (`coordinator.ts:833`) and then calls
  `step`, whose first branch is `if (w.intent) { await this.applyControl(w); return; }`. `applyControl`
  throws; `step`'s catch (`coordinator.ts:510-526`) only patches `error` and never clears `intent`.
- Consequence: on every later tick the worker re-enters `applyControl` and returns before the deadline
  check and before `monitor`, so an expired `deadline_at` never fires, the token-progress budget never
  expires, OpenCode is never stopped, the pending dispatch is never delivered or collected, and the guest
  keeps generating tokens indefinitely. `control(id,"cancel"|"destroy")` is refused
  ("Another worker control operation is pending", `coordinator.ts:828`) and `send_worker_message` keeps
  queueing messages that are never delivered, so the worker cannot be recovered through the MCP surface
  at all — not even `destroy(force=true)`. A process restart does not help: the intent is durable and
  `runRecover` skips workers with a pending intent (`coordinator.ts:407`).
- Additional impact: `control()` resolves **successfully** in this case (`step` swallows the error), so
  `pause_worker`/`resume_worker` answer as if applied while `get_worker` still reports `state: "running"`
  with `pending_control: "pause"` (`src/security.ts:144`).
- Reproduction (reproduced, local fakes only): `/tmp/rev08/probe/deadline-intent.test.ts`
  - `control: an unapplied pause intent blocks deadline and idle quiescence`: `pauseWorker` always throws,
    `control(id,"pause")` resolves with `state:"running"`, `intent:"pause"`; then `deadline_at` and
    `token_progress_at` are set 10x the idle budget in the past; 5 further ticks leave `state:"running"`,
    `intent:"pause"`, `systemctl stop` never issued, `resume`/`cancel`/`destroy` all refused, and a queued
    message is never submitted (`agent.submitted` stays at 1).
  - `control: an unapplied resume intent freezes the deadline forever`: same shape on a `paused` worker;
    `state` stays `paused`, `intent:"resume"`, `deadline_at` remains expired and unenforced.
  - Control test `control: expired deadline fails a running worker` proves the deadline path itself works
    when no intent is pending (state `failed`, `systemctl stop` issued once).
  - `control: a pending intent that keeps failing keeps a completed run reported as paused`: after the turn
    settles (result collected via the `result.json` fallback in the catch path), the leftover intent drives
    `applyControl("pause")` on the now-completed worker, flipping it to `state:"paused"`,
    `previous_state:"completed"`, so a finished run is no longer reported as completed.
- Why existing guards/tests do not prevent it: guards cover the pause *effect* on the budget
  (`tests/token-idle.test.ts:155` pause/resume shift) and the catch path covers failed *dispatch
  completion*; nothing asserts that a failed `applyControl` clears or bounds `intent`, and no test drives a
  persistently failing `pauseWorker`/`resumeWorker` through a tick. `runControl` returning the worker
  record also masks the failure from the caller.
- Recommendation: bound intent application — e.g. record `intent_since` and clear `intent` (or move the
  worker to `recovery_required` with the provider error) when `applyControl` throws; enforce the deadline
  and idle budget before the intent branch for non-teardown intents; and have `control()` surface the
  failure instead of resolving with an unapplied `pending_control`.

## Finding 2 — MEDIUM — A turn that already settled is discarded as "timed out" instead of completed

- File/line: `src/coordinator.ts:452-455` (deadline enforced before the session is inspected) versus
  `src/coordinator.ts:486-509` (`monitor`, which is what settles/completes a turn) and
  `src/coordinator.ts:610-611` (the idle budget's documented "only an active dispatch without a result"
  rule).
- Trigger: the turn finishes (assistant message completed with a valid structured result, or a matching
  `result.json` on the guest) but the next poll happens after `deadline_at`. `step` fails the worker before
  ever calling `monitor`, so the settlement is never observed.
- Consequence: a successful run is recorded as `failed`/`recovery_required` with
  `error: "Worker task timed out"`, its dispatch is cancelled and its structured result discarded
  (`store.result()` returns null), and an uncommitted workspace escalates the worker to
  `recovery_required`, demanding operator recovery for work that actually succeeded. `claimDispatch`
  (`src/store.ts:251-264`) starts the deadline at claim, so delivery and Git time also consume the budget,
  widening the window where a finishing turn loses its result.
- Reproduction (reproduced): `/tmp/rev08/probe/deadline-settle.test.ts`
  - `a settled turn is torn down instead of completed once the deadline expires`: run to `running`,
    `agent.complete(...)`, then `deadline_at = Date.now()-1`; one tick yields `state` `failed` (or
    `recovery_required`), `error` "Worker task timed out", `store.result()` null, dispatch cancelled.
  - Control `the same settled turn completes when the deadline has not expired`: identical snapshot,
    unexpired deadline, one tick yields `state:"completed"` and the result.
- Why existing guards/tests do not prevent it: `tests/lifecycle.test.ts` only exercises the deadline with
  an unsettled dispatch (`deadline_at = Date.now()-1` while the fake agent stays `busy`); no test settles a
  turn and then expires the deadline. `tests/token-idle.test.ts:126` pins the opposite asymmetry
  ("a turn that completes is never idle stopped") for the idle budget only.
- Recommendation: let `monitor` run before enforcing the deadline (or gate the deadline on the dispatch
  being unsettled), so a settled turn with a valid result completes and only an unsettled one is quiesced.
  Restarting the deadline for result collection would also match the documented retry-until-deadline
  behaviour in `docs/ENVIRONMENT.md`.

## Finding 3 — LOW — Deadline/idle enforcement latency is serialized behind the 30s reconcile

- File/line: `src/coordinator.ts:308-315` (`await this.recover()` inside `runTick`, before the per-worker
  `step` loop), with `runRecover` (`src/coordinator.ts:362`, `397-435`) awaiting `listWorkers()` and one
  `getWorker()` per worker, each bounded by `SWARMFORGE_API_TIMEOUT_MS` (default 30 s).
- Trigger: a degraded Freestyle API during the periodic reconcile.
- Consequence: no worker step — and therefore no deadline timeout, no token-idle quiesce, no dispatch
  delivery — runs until the reconcile settles, up to roughly two API timeouts (~60 s at defaults) per
  window, while `ticking` makes the scheduler skip the intervening polls. Enforcement of the 300 s idle
  budget can overshoot by ~20 %.
- Not reproduced: the reconcile only fires 30 s after the previous one, so a deterministic probe needs a
  30 s wait; the ordering is code-evident (`await` at `coordinator.ts:311` precedes the step fan-out at
  `coordinator.ts:340-353`).
- Recommendation: run the reconcile concurrently with (or after) the step fan-out, and bound it well below
  `SWARMFORGE_POLL_INTERVAL_MS` so it cannot starve deadline enforcement.

## What was checked and found sound

- Pause/resume budget shifting (`coordinator.ts:858-873`) is arithmetically correct; the idle clock is
  durable across restarts (`store.recordProgress`, `src/store.ts:266-276`) and legacy rows get a fresh
  clock.
- `recordProgress` is max-monotonic, so a regressed/repeated snapshot cannot reset the idle clock, and a
  failed `inspect` leaves it untouched (verified by `tests/token-idle.test.ts`).
- Idle stop quiesces OpenCode through the same safe path as a deadline timeout and keeps the VM when the
  tree is dirty (`tests/token-idle.test.ts:275`, `src/coordinator.ts:725-806`).
- `sessionStatus` (`src/providers/opencode.ts:183-188`) never treats an unrecognized status *type* as
  settled, and an unsettled assistant message cannot produce a false completion because completion needs
  both `settled` and a `completed` reply or a `run_id`-matched `result.json`
  (`src/coordinator.ts:588-609`, `673-691`).
- Ambiguous delivery escalates to `recovery_required` only when the session is idle and the message is
  absent from the fully paginated history (`src/coordinator.ts:561-579`).

## Tests / probes

- Toolchain: Bun 1.4.2 installed under `/tmp/opencode/bun` (the snapshot's 1.3.14 cannot read
  `lockfileVersion: 2`). Dependencies installed with `--frozen-lockfile` inside the disposable `/tmp` clone;
  the lockfile was not rewritten.
- Baseline (target tests in scope): `bun test tests/token-idle.test.ts tests/session-status.test.ts` →
  **25 pass / 0 fail**, exit 0 (log: `/workspace/.swarmforge/logs/rev08-baseline-tests.log`).
- Reviewer probes (outside the checkout, `/tmp/rev08/probe/`): `bun test /tmp/rev08/probe/` → **6 pass /
  0 fail**, exit 0 (log: `/workspace/.swarmforge/logs/rev08-probe-all.log`). Findings 1 and 2 are
  reproduced by these probes.
- No full suite, no build/packaging, no real provider or model calls, no VM, no credentials used.

## Limitations

- Findings were validated against injected fakes (`tests/helpers.ts`, local probe doubles). Provider-side
  behaviour (a persistently failing Freestyle `pause`, VM state reporting, OpenCode `/session/status`
  shapes) is inferred from the code contracts, not from a live integration.
- The 30 s reconcile gating (Finding 3) is code-evidenced, not executed.
- Line numbers refer to the target commit; the assigned `/workspace/repo` checkout was not modified.
