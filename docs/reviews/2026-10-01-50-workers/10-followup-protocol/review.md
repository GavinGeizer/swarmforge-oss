# Swarmforge review — worker 10 (follow-up queue/session identity, per-run result metadata)

- **Target SHA:** `d428e0f730ed5649485732e95d39c32f5d6a8895` (branch `feature/binary-config-serve-20260930`)
- **Verdict:** FINDINGS (1 HIGH, 1 LOW)
- **Checkout used:** disposable detached clone at `/tmp/opencode/rev10/t` (`git rev-parse HEAD` = target). Read-only; nothing written inside the checkout.
- **Assigned workspace:** `/workspace/repo` left untouched at baseline `5672ead2a526e07fea9ed11e58b3725e42013527`, clean.
- **Scope reviewed:** follow-up queue & session identity, per-run result metadata, ordering after completed turns, message-queue caps. Files: `src/coordinator.ts`, `src/store.ts`, `src/domain.ts`, `src/mcp.ts`, `src/security.ts` (`publicWorker`), `src/providers/opencode.ts`, plus `docs/MCP-API.md`, `docs/WORKER-PROTOCOL.md`, `.agents/skills/using-swarmforge/SKILL.md` and the lifecycle/session-status/core tests that cover these paths.

## Reviewer experiments (outside the source checkout)

Probes live only in `/tmp/opencode/rev10` and copies of the probe sources are in
`/workspace/.swarmforge/logs/`:

- `/tmp/opencode/rev10/work` — a *copy* of the target checkout used only to install dependencies
  (official Bun 1.4.2 in `/tmp/opencode/bun142`, `bun install --frozen-lockfile`). `bun.lock` was not
  rewritten (no lockfile diff). No real provider/credential is used: only the repo's own
  `FakeProvider`/`FakeAgent` doubles with fake literal placeholder config values.
- `/tmp/opencode/rev10/probes/followup-order.test.ts` — finding 1 reproduction (tests A/B/C).
- `/tmp/opencode/rev10/probes/stale-result.test.ts` — finding 2 reproduction.
- `/tmp/opencode/rev10/probes/cap.test.ts` — queue-cap probe (no defect found).
- `/tmp/opencode/rev10/probes/rollback.test.ts` — verifies the refused-message rollback (no defect found).

No smoke test, no real Freestyle VM, no real inference endpoint, no production configuration was touched.

---

## Finding 1 — HIGH: a follow-up acknowledged to a paused worker is queued behind a stale dispatch and later silently cancelled

**Location:** `src/coordinator.ts:220` (guard keyed on `w.state`) in combination with
`src/coordinator.ts:226-237` (the `state === "paused" && terminal.has(previous_state)` branch);
the stale dispatch is produced by `src/coordinator.ts:429-432` (and `573-578`), and the loss happens in
`src/coordinator.ts:799` (`fail()` → `cancelDispatches`).

**Concrete trigger.** A worker holds an unresolved dispatch row while reaching `recovery_required`
(the documented reconciliation paths do **not** cancel dispatches: `runRecover` moves a
non-terminal worker whose VM reports `stopped` to `recovery_required`, and the ambiguous-delivery
guard transitions to `recovery_required` leaving the dispatch in `sending`). Then:

1. `pause_worker(worker_id)` → `applyControl("pause")` → state `paused`, `previous_state = "recovery_required"`.
2. `send_worker_message(worker_id, "...")` → acknowledged `{delivery:"queued", run_id:<new>}`.
3. `resume_worker(worker_id)` → `previous_state` patched to `booting` → `ready` → the coordinator
   re-selects `store.dispatch(id)`, which is still the **old** dispatch (rowid order), and only the
   new turn is left `pending` behind it.

**Consequence.** The acknowledged run is never submitted to OpenCode, and when the token-idle
watchdog finally quiesces the blocked stale run, `fail()` calls `cancelDispatches`, which cancels
the acknowledged follow-up as well. The lead never receives an error and never sees the run execute;
the message is lost. This is precisely the invariant the surrounding comment at
`src/coordinator.ts:196-200` claims to hold ("no run is ever acknowledged as 'queued' and then
silently removed by a cancel, destroy or failure the caller did not order after it"), and it is the
pause-for-inspection workflow the operator skill explicitly recommends for `recovery_required`
workers.

**Reproduction** (`/tmp/opencode/rev10/probes/followup-order.test.ts`, repo harness + fakes):

- test A (control, same setup, no pause): `recovery_required` + message →
  `accepted.delivery = "queued"`, head dispatch **is** the new run, state `booting`. Correct.
- test B: pause (`paused`, `previous_state = recovery_required`) + message → `delivery:"queued"`,
  yet `store.dispatches` = `sent:Implement…`, `pending:next` — the acknowledged run is **not** the
  queue head.
- test C (`SWARMFORGE_TOKEN_IDLE_TIMEOUT_SECONDS: 1`): resume + ticks → `"C submissions after the
  acknowledged message: 0"` (only the original prompt was ever submitted), final worker state
  `failed` with `"No token progress for 1s; worker quiesced"`, and the acknowledged dispatch ends
  `state: "cancelled"`.

**Code trace.** `queueMessage` decides whether the worker has a dead run to discard with
`if (w.state === "failed" || w.state === "recovery_required")` — `w.state` is `paused` here, so
`cancelDispatches` is skipped; the paused branch then rewrites `previous_state` to
`"booting"`/`"ready"` and returns `delivery:"queued"`. `step()` at state `ready`
(`src/coordinator.ts:475-484`) takes `store.dispatch(id)`, i.e. the oldest unresolved row, and for a
non-`pending` row transitions to `running` and monitors the **old** run.

**Why existing guards/tests do not prevent it.** The linearization guard
(`src/coordinator.ts:201-208`) only covers an in-flight teardown or a recorded `cancel`/`destroy`
intent, not a paused terminal worker. The failed/recovery-required revival path
(`src/coordinator.ts:220-224`) is skipped purely because of `w.state`. `tests/lifecycle.test.ts`
covers the cancel/destroy/failure races for this invariant (lines 527-678) and the paused+
completed case (line 286), but never a *paused* worker whose `previous_state` is `recovery_required`
with an unresolved dispatch — the only terminal `previous_state` that can hold a stale row (`failed`
always cancels dispatches first).

**Recommended correction.** Key the stale-dispatch cancellation on the *effective* state rather than
the current state, e.g. compute
`const effective = w.state === "paused" ? w.previous_state : w.state;`
before the terminal-state block, and run the existing `vm_id`/`opencode_session_id` check plus
`this.store.cancelDispatches(id)` when `effective` is `failed` or `recovery_required` (keeping the
subsequent `previous_state` patch). Add a regression test: pause a worker holding an unresolved
dispatch, queue a message, resume, and assert the new `run_id` is the dispatch submitted to the
agent and is not later cancelled.

## Finding 2 — LOW: `get_worker_result(worker_id)` can return an earlier run's success as "latest"

**Location:** `src/store.ts:300-306` (`result()` filters dispatches that *have* a result) and
`src/mcp.ts:150-162` (the tool returns `{worker_id, result}` only).

**Trigger/consequence.** Run 1 completes with a structured result, then a follow-up run 2 is queued
and dies without producing one (deadline/token-idle quiesce, provider failure, or an unresolved
`recovery_required`). `get_worker_result(worker_id)` — documented as "Latest matching persisted
result" — returns run 1's `status:"completed"` payload with no marker that it is not the current
run; the response carries neither the worker state nor the latest dispatch `run_id` to compare
against.

**Reproduction** (`/tmp/opencode/rev10/probes/stale-result.test.ts`): after run 1 completes and run 2
is failed via the deadline path, `store.result(id)` returns `summary "run one ok"`,
`run_id c1422aa7`, `status "completed"` while `store.get(id).state === "failed"` and the actual
latest run is `fbb50a1c`. Verified: reported `run_id` !== latest run.

**Why guards do not prevent it.** `identify()` (`src/coordinator.ts:665-672`) correctly forces the
server-assigned `run_id`, and `SKILL.md` tells leads to compare `run_id` with the latest dispatch, so
the data is not untrustworthy — but the control plane itself serves a stale success for a failed run
with no in-band signal.

**Recommended correction.** Include `state` and the latest dispatch `run_id` (or an explicit
`is_latest_run: false`) in the `get_worker_result` payload when `run_id` is omitted, so the staleness
is checkable without a second tool call.

---

## Verified as sound (no defect)

- **Session identity across follow-ups.** `opencode_session_id` is never cleared by
  `queueMessage`'s revival (`src/coordinator.ts:238-243`), `ensureSession` re-verifies an existing
  session id first (`src/providers/opencode.ts:77-91`), and turn-to-turn correlation uses the unique
  per-dispatch `message_id` as `parentID` (`src/coordinator.ts:581-584`), so an earlier turn's
  assistant message cannot settle a later turn.
- **Result identity.** `identify()` overrides `worker_id`/`task_id`/`run_id`, and the filesystem
  fallback rejects a `result.json` whose `run_id` differs from the dispatch
  (`src/coordinator.ts:685-686`), so a stale file from a previous turn is not adopted.
- **Ordering after a completed turn.** `store.finish` (`src/store.ts:277-299`) marks the finished run
  completed, then re-arms `ready` when another dispatch is queued, and `step()` starts the oldest
  pending row — one turn at a time, backed by the per-worker `exclusive` lock.
- **Message-queue cap.** Probe: 99 follow-ups accepted on top of the spawn prompt (100 unresolved),
  the 100th follow-up is refused with "Worker message queue full" — matches
  `docs/MCP-API.md:25` ("worker message queues allow 100 pending turns"). Completed runs leave the
  count, so slots are released.
- **Refusal rollback.** A message refused for a paused worker whose `previous_state` is `cancelled`
  leaves no dispatch row behind (transaction rolls back the preceding `enqueue`), confirmed by probe.
- **Teardown/message linearization** for `cancel`/`destroy`/in-flight failure is enforced by
  `tearingDown`/`intent` and covered by `tests/lifecycle.test.ts`.

## Tests run (Bun 1.4.2, in the /tmp copy, real SQLite + fake providers)

- `bun test tests/lifecycle.test.ts` → 34 pass, 0 fail (exit 0).
- `bun test tests/session-status.test.ts tests/core.test.ts` → 22 pass, 0 fail (exit 0).
- 4 probe files (`probes/*.test.ts`) — 3 assertions intentionally fail to demonstrate findings 1 and
  2 (test A/B/C of `followup-order.test.ts`, and `stale-result.test.ts`); `cap.test.ts` and
  `rollback.test.ts` pass.

## Limitations

- No full-suite run (reserved for the whole-suite reviewer) and no packaging/compile step.
- Findings are demonstrated with the repository's own in-memory fakes; behaviour against real Freestyle
  or a real OpenCode server (for example an out-of-band VM stop in production) is inferred from the
  code path, not executed.
- Token-idle quiescing was accelerated with a 1-second configured timeout rather than waiting 300 s.
- Did not review artifact chunking, credential redaction, CLI/TUI, metrics, or the packaging/install
  surface (other reviewers' scopes).
