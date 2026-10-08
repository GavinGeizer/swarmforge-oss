# SwarmForge review — worker 26 (freestyle pause/resume/cancel/destroy)

- Target: `d428e0f730ed5649485732e95d39c32f5d6a8895` (branch `feature/binary-config-serve-20260930`)
- Baseline in `/workspace/repo`: `5672ead2a526e07fea9ed11e58b3725e42013527` (untouched, clean)
- Disposable checkout: `/tmp/r26/t` (detached at target, `git rev-parse HEAD` = d428e0f…)
- Scope: Freestyle pause/resume/cancel/destroy control flow, ambiguous provider state
  (`src/coordinator.ts` `applyControl`/`control`/`quiesce`/`step`/`recover`,
  `src/providers/freestyle.ts` pause/resume/destroy/get, `src/store.ts` transitions,
  `src/domain.ts` state model, MCP control wrappers)
- Toolchain: Bun 1.4.2 installed at `/tmp/bun1420` (snapshot bun 1.3.14 cannot read this
  lockfile); `bun install --frozen-lockfile` succeeded (125 packages, lockfile untouched)
- Verdict: **FINDINGS** (4 actionable, 1 minor). No credential material is reproduced here.

## Findings

### A. HIGH — `resume_worker` silently no-ops forever once `previous_state` becomes `"paused"`
- Where: `src/coordinator.ts:851-855` (pause records `previous_state: w.state`),
  `src/coordinator.ts:861` (resume transitions to `w.previous_state ?? "ready"`),
  race source `src/coordinator.ts:497-503`, skip of paused workers `src/coordinator.ts:344-349`,
  message repair `src/coordinator.ts:226-237`.
- Trigger: `pause_worker` is issued while a `step` for that worker is in flight
  (any poll tick: monitor/`getWorker`), and that in-flight step observes the guest as
  `paused`/`pausing`. `runControl` records the intent (`src/coordinator.ts:833`) *before*
  taking the worker lock, and the `running`/`waiting` branch of `step` transitions the
  worker to `paused` (`src/coordinator.ts:497-503`) without re-reading `intent`. The queued
  `applyControl` then runs with `w.state === "paused"` and overwrites
  `previous_state` with `"paused"`.
- Consequence (reproduced): the worker is wedged. `resume_worker` passes its guard
  (`state === "paused"`), calls `resumeWorker`, then transitions paused → paused because
  `previous_state` is `"paused"`, and still emits `worker.resumed`. `store.transition`
  (`src/store.ts:146-158`) skips the state-change event when state is unchanged, so MCP
  clients see a "resumed" event and a `state: "paused"` response forever. Because paused
  workers are excluded from `runTick`, the stuck worker is never stepped again: no deadline
  enforcement, no monitoring, no usage accounting. `send_worker_message` still returns
  `delivery: "queued"` (`src/coordinator.ts:226-237` only rewrites `previous_state` when it
  is *terminal*), so a follow-up is accepted and never delivered. `wait_for_state_change`
  for `running` never fires. `cancel`/`destroy` still work, so recovery is manual.
- Reproduction (outside the checkout, `/tmp/r26/exp/pause-intent-race.test.ts`):
  run worker to `running`; gate `provider.getWorker`, flip the fake VM to `paused` when it
  is released; start `tick()`, then `control(id,"pause")`, then one more `tick()`.
  Observed: `state=paused previous_state=paused intent=null`; after
  `control(id,"resume")`: `state=paused previous_state=paused paused_at=null`;
  events `… -> worker.paused -> worker.resumed`; dispatches stay `sent,pending`,
  submissions stay 1 across 5 further ticks.
- Recommendation: in the pause branch use the state observed *before* the intent was
  recorded (`if (w.state === "paused") { clear intent; return; }`), or reject
  `previous_state` values that are not resumable in the resume branch
  (`w.previous_state && w.previous_state !== "paused" ? … : "ready"`), and re-check
  `intent` before the paused transitions in `step`/`recover`.
- Why existing guards do not help: `runControl:832` refuses a *new* pause only when it
  observes `paused` at call time; `recover:407` re-checks `intent` but the `step` branch
  does not; `queueMessage` repairs only terminal `previous_state`; the pause/resume tests
  (`tests/lifecycle.test.ts:113-125`, `:286-297`) never pause a worker whose state changes
  underneath a pending intent.

### B. MEDIUM — stopped-guest discovery keeps a stale `deadline_at`, so follow-ups fail instantly
- Where: `src/coordinator.ts:429-432` (transition to `recovery_required` without
  `deadline_at: null`), `src/coordinator.ts:238-243` (follow-up transition does not reset
  it), `src/coordinator.ts:452-455` (deadline check runs before any provisioning work).
- Trigger: a worker is in `running`/`waiting` with a live `deadline_at` and its guest is
  stopped out of band; the 30 s reconcile pass (`src/coordinator.ts:421-432`) moves it to
  `recovery_required` but leaves the old absolute deadline in place.
- Consequence (reproduced): `send_worker_message` is accepted (`delivery: "queued"`,
  state `booting`) and the very first `step` fails it with `Worker task timed out` before
  `prepare()`/`ensureSession()` ever run. The stale deadline is never cleared, so every
  later message repeats the same instant failure. Related: nothing in the follow-up path
  starts a stopped guest (`resumeWorker` is only used by resume/cancel/destroy), so even
  with budget left the follow-up cannot succeed — `prepare` needs a live guest
  (`src/providers/freestyle.ts:114-122`). The documented behaviour "failed workers with an
  existing session can receive a follow-up, restarting the service while keeping context"
  (`docs/ARCHITECTURE.md`, README) does not hold for this state.
- Reproduction (`/tmp/r26/exp/cancel-stopped.test.ts`): run to `running`, set
  `deadline_at` to a past value (models a run that used its budget), set the fake VM state
  to `stopped`, `recover()` → `recovery_required`, `deadline_at` still in the past;
  `message()` → queued/`booting`; one `tick()` → `failed`, error `Worker task timed out`.
- Recommendation: clear `deadline_at: null` in the stopped-VM branch (as every other
  `recovery_required` transition does: `:573-577`, `:800-804`, `:919-921`, `:936-941`) and
  reset it on the follow-up transition; when adopting a stopped guest for a follow-up,
  call `resumeWorker` (or surface an explicit refusal) before `prepare`.
- Why existing guards do not help: `recover:404-420` guards intent/destroy, not deadlines;
  the stopped check is the only terminal transition that omits `deadline_at: null`; the
  lifecycle tests cover disappeared (`:399`) and paused-gone (`:432`) guests, not a
  stopped guest followed by a message.

### C. MEDIUM — `cancel_worker` reports success when the OpenCode stop could not be proven
- Where: `src/coordinator.ts:890`
  (`if (!missing && (await this.quiesce(w)) === "missing") missing = true;` — only the
  `missing` outcome is inspected); contrast `:785-804` (`fail`) and `:917-926` (`destroy`),
  which both treat `quiesce`'s `paused` outcome as unsafe.
- Trigger: `quiesce` (`src/coordinator.ts:725-745`) cannot confirm a stop — `agent.abort`
  and the `systemctl stop` exec fail, and `pauseWorker` fails — while the guest is still
  present (`getWorker` answers a record). Both provider calls then throw on every tick.
- Consequence (reproduced): the worker is recorded `cancelled` with `error: null` and the
  guest is still `running` with OpenCode generation unproven-ended. `cancelled` is
  terminal, so nothing monitors the worker again: tokens keep being spent with no usage
  accounting and no signal that the turn was not stopped. The identical unprovable stop on
  the failure path yields `recovery_required` ("VM paused after OpenCode stop failure"), so
  the two paths disagree about what is safe. `files.logs` (`src/files.ts:112-133`) will
  still exec into the guest for a `cancelled` worker, so the pause signal is also lost.
- Reproduction (`/tmp/r26/exp/cancel-stopped.test.ts`): `provider.exec` and
  `provider.pauseWorker` both throw → `control(id,"cancel")` → `state=cancelled`,
  `error=null`, VM `running`; same setup on the deadline path → `recovery_required`.
- Recommendation: capture the `quiesce` outcome and, when it is `paused`, either record
  `error: "VM paused after OpenCode stop failure"` on the cancelled record or transition to
  `recovery_required`, matching `fail`/destroy.
- Why existing guards do not help: the ambiguity rule is implemented only for
  `missing`; `tests/lifecycle.test.ts:432-500` covers the ambiguous *resume* and the
  *vanishing* guest, not an ambiguous stop.

### D. LOW — `control()` returns before its own intent is applied when a step holds the lock
- Where: `src/coordinator.ts:251-257` (`exclusive` returns the in-flight promise instead of
  queueing the new work) with `:833-834`.
- Trigger: a control call arrives while the worker's step is mid-flight (any provider call;
  poll interval is 2 s, API timeout 30 s). Observed in the probe: `control(id,"pause")`
  returned while `pending_control` was still `pause` and the state was unchanged; the intent
  is only applied by a later poll tick.
- Consequence: the MCP response describes an operation that has not happened
  (`pending_control` set, state unchanged, Git safety check not yet run for `destroy`), and
  an immediately following control call of a different kind fails with "Another worker
  control operation is pending". `docs/MCP-API.md:11` acknowledges "or pending intent" for
  `pause_worker`, which is why this is LOW; it also widens the window for finding A.
- Recommendation: have `runControl` await its own `step` (queue behind the lock instead of
  aliasing the running promise), or poll until `intent` is cleared before returning.
- Why existing guards do not help: `runControl` validates state before recording the
  intent but never waits for application; the race tests
  (`tests/lifecycle.test.ts:311-330`) only assert the intent survives reconciliation.

### E. LOW — disappearance handled in `step` leaves the inference gauge and excerpt behind
- Where: `src/coordinator.ts:487-496` (`running`/`waiting` vanished-VM branch) omits
  `this.inference.delete` / `this.excerpts.delete`, unlike `src/coordinator.ts:408-419`.
- Consequence: after a guest disappears mid-run, `get_worker` can still return an
  `excerpt` of a turn that no longer exists and the metrics gauge keeps counting an
  inference-active worker until the next reconcile pass (≤30 s). Self-healing, so LOW.
- Recommendation: mirror the reconcile branch's two `delete` calls in the `step` branch.

## Tests / probes

All under `/tmp/r26` (outside `/workspace/repo`); Bun 1.4.2 at `/tmp/bun1420/bin/bun`.

- `bun install --frozen-lockfile` — exit 0, 125 packages.
- `bun test tests/lifecycle.test.ts tests/core.test.ts` — exit 0, **44 pass / 0 fail**
  (baseline at target is green; my findings are not pre-existing failures).
- `bun test /tmp/r26/exp/pause-intent-race.test.ts` — exit 0, 1 pass (finding A probe).
- `bun test /tmp/r26/exp/cancel-stopped.test.ts` — exit 0, 2 pass (findings B and C probes).
- No cloud/model provider was contacted; all probes used the repository's own
  `FakeProvider`/`FakeAgent` doubles and an in-memory SQLite store.

## Limitations

- Freestyle was never called. `quiesce`, `resumeWorker` and `destroyWorker` outcomes are
  modelled with the repo's `FakeProvider`; the claim in finding B that `prepare` cannot run
  on a stopped guest is code-evidenced (the SDK's `exec` runs in the guest) but not
  reproduced against the real API.
- Findings A and D are timing dependent and were reproduced by explicitly gating the
  injected `getWorker`, not by chance; the poll interval was not shortened.
- Full suite, `tsc`/biome and packaging were out of scope for this reviewer.
- Reviewer experiment files: `/tmp/r26/exp/pause-intent-race.test.ts`,
  `/tmp/r26/exp/cancel-stopped.test.ts`. `/workspace/repo` was not modified
  (still `5672ead`, clean).