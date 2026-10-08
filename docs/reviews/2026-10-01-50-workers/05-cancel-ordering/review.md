# SwarmForge review — cancellation races against dispatch/messages/results

- Exact target: `d428e0f730ed5649485732e95d39c32f5d6a8895` (branch `feature/binary-config-serve-20260930`)
- Disposable checkout: `/tmp/sf05` (detached, `git rev-parse HEAD` verified = target). Probe copy: `/tmp/probe`.
- Assigned workspace `/workspace/repo` untouched (baseline `5672ead`, clean).
- Scope: cancellation/control ordering in `src/coordinator.ts`, `src/store.ts`, `src/domain.ts`, `src/providers/freestyle.ts`, `src/mcp.ts`; quiesce semantics; acknowledged-message linearization; dispatch/result races.
- Verdict: **FINDINGS** (1 HIGH, 1 MEDIUM, 1 LOW). No source changes made.

## Findings

### 1. HIGH — `cancel` reports `cancelled` when the guest could not be proven stopped, and never retries
File: `src/coordinator.ts:875-907` (decision at `src/coordinator.ts:890`)

Trigger: `cancel_worker` (or a tick) applies `intent: "cancel"` and `quiesce()` returns `"paused"`, i.e. `provider.exec("systemctl stop …")` did not answer code 0 **and** `provider.pauseWorker()` threw. The `quiesce` contract (comment at `src/coordinator.ts:720-724`) defines `"paused"` as "the guest is alive but not provably stopped"; `src/coordinator.ts:744` also returns `"paused"` when the confirmation probe is ambiguous (`getWorker` threw or still found the VM).

Code trace: only `"missing"` is consumed —
`if (!missing && (await this.quiesce(w)) === "missing") missing = true;` — then `this.store.transition(id, "cancelled", …)` at `src/coordinator.ts:895` with `error: null`. Contrast the sibling paths, which escalate on the same outcome: `fail()` → `recovery_required` (`src/coordinator.ts:785-804`) and destroy → `recovery_required` (`src/coordinator.ts:917-926`).

Consequence: the worker is reported cleanly `cancelled` while the VM is still powered and may still be generating tokens for OpenCode. Nothing retries: `runTick` (`src/coordinator.ts:340-353`) skips terminal states without intent, and `runRecover` (`src/coordinator.ts:421-432`) only reacts to provider states `paused`/`pausing`/`stopped`, not a running guest. The leak persists until an operator issues `destroy`, which then parks in `recovery_required`. `cancel_worker` is documented as "Stops execution, cancels queued turns, retains VM" (`docs/MCP-API.md:13`).

Reproduction (reproduced, repo fakes, `tests/probe-cancel.test.ts` probe A in `/tmp/probe`): run to `running`, make `exec` answer `{code:1}` for `systemctl stop` and `pauseWorker` throw, then `control(id,"cancel")` →
`state: cancelled`, `error: null`, VM still present with state `running`, and after 5 further ticks plus `recover()`: `systemctl stop` attempts = **0**, state still `cancelled`. Probe B: identical faults with `destroy` → `recovery_required`.

Real-provider reachability (code-evidenced, `src/providers/freestyle.ts:279-301`): `pauseWorker` throws on any non-2xx and `exec` throws on API/transport errors, and `getWorker` only returns `null` for 404 (`src/providers/freestyle.ts:88-95`). A single transient Freestyle outage during a cancel therefore yields `"paused"` from the fallback branch — the common case, not an exotic one.

Why guards/tests miss it: no test cancels under `quiesce → "paused"`; `tests/lifecycle.test.ts:387-460` covers the `missing` variant, `:462-486` the paused-resume ambiguity, `:505-525` the same faults only on the deadline-failure path.

Recommendation: mirror the sibling escalation — if `quiesce()` returns `"paused"` during cancel, either transition to `recovery_required` with an "OpenCode could not be stopped; inspect" error (and keep the intent retryable), or keep `cancelled` but attach a non-null `error` plus a `vm_missing:false` marker so operators can see the guest is un-quiesced. Do not clear `intent` on an unproven stop.

### 2. MEDIUM — A failed control-intent application falls through to fallback completion, reporting `completed` and blocking cancel/destroy
File: `src/coordinator.ts:510-526` (catch handler of `step`), reached from `applyControl("pause")` at `src/coordinator.ts:839-857`

Trigger: a control intent is recorded on a `running`/`waiting` worker and the intent's provider call throws (e.g. `provider.pauseWorker` unavailable). `step`'s catch cannot tell "a control intent failed" from "a turn failed": it patches a generic error and, because `w.state` is still `running`/`waiting`, reads `.swarmforge/result.json` (`fallback`, `src/coordinator.ts:673-691`) and promotes it to a durable result via `complete()` (`src/coordinator.ts:692-719`), which also pushes the branch. The intent is left set.

Consequence (reproduced, probe H): `pause_worker` returns a worker with `state: "completed"`, `error: null` although nothing was paused and the pause failed. While `pauseWorker` keeps failing, both `cancel_worker` and `destroy_worker` are refused with "Another worker control operation is pending" (`src/coordinator.ts:828-829`), so the lead cannot stop the worker it just failed to pause; each tick retries and re-patches `error: "Provider or OpenCode operation failed; retrying within deadline"` on an already-`completed` worker.

Reproduction: run to `running`, seed `${vm}:<workspace>/.swarmforge/result.json` with `{status:"completed",summary:"fell back",run_id:<active run>}`, make `pauseWorker` throw, then `control(id,"pause")` → `completed intent:pause error:null`; `cancel` → refused; `destroy` → refused; after 3 ticks `completed intent:pause error:Provider or OpenCode operation failed…`.

Why guards/tests miss it: `GitHandoffError` is special-cased (`src/coordinator.ts:518`) but control-intent failures are not; no test exercises a throwing intent provider call.

Recommendation: in the `catch`, re-read the worker and, when `w.intent` is set, return early after the error patch (retry the intent next pass) instead of running `fallback`/`complete`; also do not clear/ignore the intent in `complete()`'s `finish` path. A completed state reached while an intent is pending should not be reported as a successful control operation.

### 3. LOW — Acknowledged-then-dropped message outside the `tearingDown` hold
File: `src/coordinator.ts:489` (also `src/coordinator.ts:411`); guard claimed at `src/coordinator.ts:196-208`

Trigger: the VM-disappeared branches call `store.cancelDispatches(id)` without holding `tearingDown`. `queueMessage` only refuses while `tearingDown` has the id or `intent` is set; during the awaited `provider.getWorker()` the worker still reads `running` and not `vm_missing`, so a `send_worker_message` call is acknowledged `delivery:"queued"`, then silently marked `cancelled` by that branch.

Reproduction (probe G): gate `getWorker`, delete the VM from the fake provider, then `message(id,"racing message")` while the gate is closed → `queued`, state at ack `running`; after release: worker `failed`, `vm_missing:true`, acked run `cancelled`.

Consequence is bounded (the guest and workspace are already gone, so the message could never run, and the next message attempt errors), but it violates the stated linearization invariant that no run is acknowledged `queued` and then removed by an operation the caller did not order.

Why guards/tests miss it: `tests/lifecycle.test.ts:527-560` covers the `fail()` path, which does hold `tearingDown`; the VM-missing branches are untested for concurrent messages.

Recommendation: wrap `src/coordinator.ts:411` and `:489` in `this.teardown(...)` (as `fail()` does) or set the hold before the `getWorker` await, so the refusal window matches the documented invariant.

## Observations that are not defects (checked, no action)

- `control(cancel)` can return with `intent:"cancel"` and no applied transition when a step holds the worker lock (probe C: returned `state:"running"`). Documented at `docs/MCP-API.md:29` ("A pending lifecycle control operation can finish on the next coordinator pass") and asserted by `tests/lifecycle.test.ts:562-598`; the intent is applied on the next tick.
- `cancel` of an already-`completed` worker rewrites state to `cancelled` while the durable result stays retrievable (probe E). Ambiguous but consistent with the linearization rule; the result is not lost.
- A prompt already handed to `agent.submit` cannot be un-submitted when cancel lands during the await (probe F); cancel then quiesces it. Bounded and expected.
- `finish()` (`src/store.ts:277-299`) refuses to record a result for a cancelled dispatch, so no result is resurrected after cancel.

## Tests / limitations

- `bun test tests/lifecycle.test.ts tests/excerpt.test.ts` (Bun 1.4.2 in `/tmp/bun142`, checkout copy `/tmp/probe`): 41 pass / 0 fail, 155 assertions, exit 0.
- `bun test tests/probe-cancel.test.ts` (8 reviewer probes, `/tmp/probe/tests/probe-cancel.test.ts`): 8 pass / 0 fail, exit 0. Probes log observations; they are not repo tests and were not committed.
- Lockfile untouched; official Bun 1.4.2 used from `/tmp` because the snapshot has 1.3.14.
- Limitations: no real Freestyle/OpenCode calls (repo fakes only), so provider-failure timing on the real API is code-evidenced, not executed; no full-suite run (other reviewers' scope); artifacts limited to `src/` control flow plus targeted probes.