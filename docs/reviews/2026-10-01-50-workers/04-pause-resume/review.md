# SwarmForge review — worker 04 (pause/resume, timeouts, retries, pending intents)

- **Exact target reviewed:** `d428e0f730ed5649485732e95d39c32f5d6a8895` (branch `feature/binary-config-serve-20260930`)
- **Disposable checkout:** `/tmp/rev-scope/checkout` (detached HEAD at target, verified with `git rev-parse HEAD`)
- **Assigned workspace:** `/workspace/repo` left untouched at baseline `5672ead2a526e07fea9ed11e58b3725e42013527`, clean
- **Scope:** pause/resume ordering, timeout suspension, retries, and pending intents under concurrent operations
- **Verdict:** FINDINGS (2 confirmed, both reproduced with the repository's own in-memory store + fake provider/agent doubles; no source changes made)

## Files in scope

`src/coordinator.ts` (lifecycle `step`, `runTick`, `runControl`, `applyControl`, `runRecover`, `fail`, `teardown`, `bounded`), `src/store.ts` (`patch`/`transition`/`claimDispatch`/`finish`/`cancelDispatches`), `src/domain.ts` (`terminal`, `Worker.intent`, `resultSchema`), `src/mcp.ts` (`pause_worker`/`resume_worker`/`send_worker_message` surfacing), `src/providers/opencode.ts` (retry/idle status mapping), plus `docs/MCP-API.md`, `docs/ARCHITECTURE.md` and `tests/lifecycle.test.ts`, `tests/token-idle.test.ts`, `tests/wait.test.ts` as the existing guards.

---

## F1 — MEDIUM — A pause intent recorded during an in-flight step is applied *after* that step settles the worker, regressing a terminal state to `paused`

**File / line (at target):** `src/coordinator.ts:440` (`step` dispatches on `w.intent` with no terminal-state guard), reached from `src/coordinator.ts:345` (tick filter admits any worker with an intent, terminal or not) and applied at `src/coordinator.ts:837-856` (`applyControl` pause branch).

**Trigger.** `runControl` (`src/coordinator.ts:833-834`) writes the intent durably and then calls `exclusive(id, () => this.step(id))`. `exclusive` (`src/coordinator.ts:251-257`) returns the *in-flight* promise when a coordinator step already owns the worker, so the control never runs its own step. If that in-flight step then settles the worker (`store.finish` → `completed`, the ambiguous-delivery `recovery_required` at `src/coordinator.ts:573`, or `fail` → `failed`/`recovery_required`), nothing clears the intent. `store.finish` (`src/store.ts:291`) and `fail`'s settled transitions (`src/coordinator.ts:800-804`) write `deadline_at: null` but leave `intent` set — only the "missing VM" branch (`src/coordinator.ts:781`) explicitly clears it. The next tick then applies the stale intent to an already-terminal worker.

**Consequence.**
1. The durable lifecycle state regresses from terminal to non-terminal without any new operator action. Event log for the reproduced case: `worker.completed -> worker.paused`.
2. A worker that `recovery_required` (the state the docs say must be inspected, persisted or explicitly force-destroyed) is reported as `paused`, masking the condition; `get_worker`/`get_swarm_status`/the CLI overview all show a live worker.
3. The paused worker keeps holding a `SWARMFORGE_MAX_WORKERS` capacity slot (`src/coordinator.ts:317-322`).
4. `send_worker_message` still accepts follow-ups for the regressed worker and answers `delivery: "queued"` (`src/coordinator.ts:226-249` only patches `previous_state`, it does not leave `paused`), but the dispatch can never be delivered: `step` is only reached for non-paused states, so delivery requires an explicit `resume_worker` that the lead has no reason to call because it never saw a pending pause.

**Reproduction (reproduced, deterministic).** `/tmp/rev-scope/probe/pause-race.test.ts` (outside the source checkout) with the repo's `tests/helpers.ts` doubles:

- PROBE 1: worker driven to `running`; the agent is completed and `agent.inspect` is gated mid-`monitor()`; `control(id,"pause")` is issued while the step holds the lock. Output:
  - after completion: `{"state":"completed","intent":"pause","previous_state":null,"result":"done"}`
  - after one tick: `{"state":"paused","intent":null,"previous_state":"completed",...,"vm_state":"paused"}`
  - follow-up message: `{"state":"paused","delivery":"queued"}`; after two further ticks: `{"state":"paused","submitted":1,"dispatch":"pending"}` — the accepted follow-up is stranded.
- PROBE 2: same race, but the in-flight monitor fails the worker as an ambiguous delivery. Output:
  - `{"state":"recovery_required","intent":"pause","error":"Prompt delivery ambiguous; ..."}`
  - after one tick: `{"state":"paused","previous_state":"recovery_required"}`; `resume` then returns `recovery_required` again, so the operator must already know to resume to see the state that requires action.

Real-world window: `monitor` awaits `agent.inspect` (two guest HTTP calls, each bounded by `SWARMFORGE_API_TIMEOUT_MS` = 30 s) and `complete` awaits `pushBranch` (bounded by `SWARMFORGE_GIT_PUSH_TIMEOUT_MS` = 120 s), so the race window is seconds to minutes wide while `SWARMFORGE_POLL_INTERVAL_MS` = 2 s keeps the step loop running. A lead that pauses a worker it believes is mid-turn is the ordinary trigger.

**Why existing guards do not prevent it.** The tests at `tests/lifecycle.test.ts:309-336` (destroy during reconciliation) and `:562-598` (message refused while a cancel intent waits for an in-flight step) cover the *reconcile* and *cancel* paths, and `fail`'s missing-VM branch clears `intent` on purpose — but nothing asserts that an intent which lost a race to a terminal transition is dropped, and `tests/lifecycle.test.ts:286-298` deliberately shows `pause` being legal on a `completed` worker, so `paused` after `completed` looks intentional in a snapshot. No test lets a control intent wait behind an in-flight `monitor()`/`complete()`.

**Recommended correction.** Re-validate the intent against the state that actually won the race. Minimal: in `step`, before `applyControl`, drop or refuse an intent whose worker is already in a terminal state that the intent cannot legitimately act on (only `cancel`/`destroy` are meant to act on terminal states), and clear `intent` in `store.finish` and in `fail`'s settled transitions so no intent can survive a terminal transition. Better: record the state the intent was requested against and, in `applyControl`, treat "the worker reached a terminal state while the intent was waiting" as an explicit, reported outcome rather than a silent regression.

---

## F2 — LOW — A follow-up queued while a paused worker holds a terminal `previous_state` inflates the post-resume provisioning window by up to the pause duration

**File / line (at target):** `src/coordinator.ts:235` (`provision_started_at: Date.now()` in `queueMessage`) combined with `src/coordinator.ts:863-865` (`applyControl` resume adds `elapsed` to `provision_started_at`).

**Trigger.** Pause a `completed` worker, keep it paused for a long time, then send a follow-up and resume. `queueMessage` stamps `provision_started_at` with *now* (mid-pause), and the resume path then adds `elapsed = Date.now() - paused_at`, which covers the whole pause including the part that already elapsed before the message.

**Consequence.** `provision_started_at` lands in the future, so the boot guard in `step` (`src/coordinator.ts:444-451`, `SWARMFORGE_PROVISION_TIMEOUT_SECONDS` = 300) cannot fire for that long: a `booting` worker whose `prepare`/`ensureSession` keeps failing is retried indefinitely instead of being failed. The same `elapsed`-is-always-added pattern also revives an already-lapsed deadline/provision budget when a pause is requested after it expired (`step` checks `w.intent` at `src/coordinator.ts:440` before the deadline check at `:452`), which is operator-driven and so only a note.

**Reproduction (reproduced).** `/tmp/rev-scope/probe/provision-window.test.ts` PROBE 3: complete the worker, pause it, set `paused_at` to 1 h ago, send a follow-up, resume.
- after message: `{"state":"paused","previous_state":"ready","provision_started_at_in":0}`
- after resume: `{"state":"ready","provision_started_at_in_s":3600,"boot_window_remaining_s":3900}` — a 3900 s boot window instead of the configured 300 s.

**Why existing guards do not prevent it.** `tests/lifecycle.test.ts:286-298` covers the delivery-after-resume path and `tests/token-idle.test.ts:155-166` covers the `token_progress_at` shift, but neither asserts the `provision_started_at` budget after a message-while-paused, and no test pauses for a duration longer than the provision timeout.

**Recommended correction.** In `queueMessage`, do not overwrite `provision_started_at` with `Date.now()` while the worker is paused (leave the original stamp so the resume shift is applied exactly once), or clamp the resume shift to `Math.max(0, elapsed - timeAlreadyElapsedSinceLastStamp)`.

---

## Checked and found sound (no finding)

- Deadline/provision-timeout suspension while `paused`: paused workers are excluded from `step` (`src/coordinator.ts:343-349`), and `deadline_at`, `provision_started_at` and `token_progress_at` are all shifted by the pause duration on resume (`:861-871`).
- `send_worker_message` linearization: `tearingDown` plus the `cancel`/`destroy` intent check at `src/coordinator.ts:201-208` holds the worker for the whole provider round-trip window; the enqueue at `:225` and the throw at `:232` are inside the same `db.transaction` (`:193`), so the refused "cancelled worker" path leaves no dispatch (verified: PROBE 4, `dispatches_before: 1, dispatches_after: 1`).
- `spawn` retry idempotency: `store.create` dedupes on `(team_id, request_id)` and rejects a reused key with different arguments; the fingerprint is taken over the schema-normalized input, so key order does not perturb it (`src/store.ts:70-131`).
- `resume` intent retry on an ambiguous provider failure keeps the VM and the intent for the next pass, and `queueMessage` keeps refusing messages meanwhile (`tests/lifecycle.test.ts:462-486`, `:600-625`).
- `wait_for_state_change` and the `worker.resumed` event: `lifecycleState` returns `null` for `worker.resumed`, so the extra event cannot surface as a bogus state (`src/domain.ts:127-133`).
- `step`'s catch re-reads the record and rethrows nothing except a second `GitHandoffError` from `complete`, which the tick's `Promise.allSettled` and the MCP wrapper both absorb while the intent stays durable for the next pass.

## Tests / probes run (honest record)

- Toolchain: Bun 1.4.2 installed to `/tmp/rev-scope/bun142` (snapshot system Bun is 1.3.14 and cannot read `lockfileVersion: 2`); `bun install --frozen-lockfile` in the disposable checkout, exit 0, lockfile untouched.
- Existing targeted suites: `bun test tests/lifecycle.test.ts tests/token-idle.test.ts tests/wait.test.ts` → **58 pass, 0 fail, 221 assertions, exit 0**. The full suite was not run (out of scope for this reviewer).
- Reviewer probes (outside the source checkout, `/tmp/rev-scope/probe/`, using only `tests/helpers.ts` fakes and `:memory:` SQLite — no network, no real provider, no cloud calls): `pause-race.test.ts` 2 pass / 0 fail (both defects reproduced as described above); `provision-window.test.ts` 2 pass / 0 fail (F2 reproduced, F2-negative check PROBE 4 confirmed no dispatch leak).

## Limitations

- Read-only review: no source file, test, lockfile or config was modified anywhere; `/workspace/repo` is unchanged and clean, `/tmp/rev-scope` is disposable.
- F1/F2 use the repository's fake provider/agent. The race is timing-driven, so the *ordering* is proven from the code path plus the gated-double reproduction, not from a production incident; the real window size is inferred from the configured timeouts.
- `tearingDown`/`exclusive` interaction was reviewed statically only; no high-concurrency stress was run.
- Not assessed (other reviewers' scopes): CLI/TUI and `serve`/`serve-command`, config/redaction/credential handling, packaging/install, git-handoff internals, metrics.
