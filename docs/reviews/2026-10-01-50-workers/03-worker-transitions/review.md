# SwarmForge review — lifecycle transitions and state invariants

- **Exact target reviewed:** `d428e0f730ed5649485732e95d39c32f5d6a8895`
- **Published branch:** `feature/binary-config-serve-20260930`
- **Assigned baseline (not the target):** `5672ead2a526e07fea9ed11e58b3725e42013527` (kept untouched at `/workspace/repo`)
- **Reviewer checkout:** detached read-only clone at `/tmp/rv03t`, `git rev-parse HEAD` = `d428e0f730ed5649485732e95d39c32f5d6a8895`
- **Scope:** lifecycle transition correctness and state invariants across `queued/provisioning/booting/ready/running/waiting/completed/failed/cancelled/paused/recovery_required/destroyed`; state-machine adversarial traces.
- **Verdict: FINDINGS** (1 HIGH reproduced, 1 MEDIUM reproduced, 1 LOW code-evidenced)

Scope files read in full: `src/domain.ts`, `src/coordinator.ts`, `src/store.ts`, `src/config.ts`,
`src/mcp.ts`, `src/providers/freestyle.ts`, `src/providers/opencode.ts`, `src/cli/overview.ts`
(action gating), plus `tests/helpers.ts`, `tests/lifecycle.test.ts`, `docs/MCP-API.md`,
`docs/ARCHITECTURE.md`. Delta reviewed: `src/coordinator.ts` (66 lines; shutdown tracking and
stop-aware waits). No source changes were made anywhere.

---

## F1 — HIGH — A permanently failing `pause`/`resume` wedges the worker: no remediation path, timeout disabled

**Files/lines at target:** `src/coordinator.ts:828-829`, `:840-848`, `:858-859`, `:440-443`,
`:452-455`, `:407`, `:826` (contrast: `:882-889` cancel, `:907-918` destroy).

**Trigger.** Any `pause_worker` or `resume_worker` whose provider call never succeeds. Concretely:
(a) a guest deleted out of band between two control operations — an explicitly supported scenario in
this codebase (`vmMissing()`, `vm_missing`, and many lifecycle tests); (b) a persistent provider fault
(403/5xx/authz) on `vms.pause()` / `vms.start()`.

**Code trace.**
1. `control()` → `runControl()` patches `intent` durably (`src/coordinator.ts:833`), then `step()`.
2. `applyControl` pause/resume call the provider with no absence handling
   (`await this.bounded(this.provider.pauseWorker(w.vm_id))` at `:848`;
   `if (w.vm_id) await this.bounded(this.provider.resumeWorker(w.vm_id))` at `:859`).
   Compare cancel (`:882-889`, probes `vmMissing`) and destroy (`:913`, `getWorker` → `null`).
3. The throw is swallowed by `step`'s catch (`:510-517`), which only patches `error`. `intent` stays.
4. `runControl` refuses every *different* intent while one is pending (`:828-829`). That check
   precedes the "already paused" early return (`:832`), so `pause`, `cancel` and `destroy` — including
   `destroy(force=true)` — all throw `Another worker control operation is pending`. Only a retry of the
   same intent is accepted, and it cannot succeed.
5. `recover()` returns early for any intent-bearing worker (`:407`), so the confirmed-absence path
   (`:408-419`) never runs: `vm_missing` is never set and the capacity slot is never released.
6. `step` handles the intent before the deadline (`:440-443` vs `:452-455`), so an expired
   `deadline_at` is never enforced while the intent is stuck.

**Reproduction** (local fake provider/agent only, `/tmp/probes/probe4.test.ts`):

Variant 1 — pause permanently failing, guest alive:
```
state: running intent: pause error: Provider or OpenCode operation failed; retrying within deadline
expired deadline ignored: true          # deadline_at set 1s in the past; 3 ticks later still running
cancel:  THREW: Another worker control operation is pending -> state: running intent: pause
destroy: THREW: Another worker control operation is pending -> state: running intent: pause
guest still running: running
```

Variant 2 — paused worker, guest deleted out of band, then `resume_worker`:
```
message ack: {"state":"paused","delivery":"queued"}
dispatches: sent,pending
after ticks: paused intent: resume vm_missing: false   # 3 coordinator ticks + recover()
unresolved dispatch: sent
force destroy: THREW: Another worker control operation is pending
```

**Consequence.** The worker stays `running` (variant 1) or `paused` (variant 2) indefinitely, holding
one of `SWARMFORGE_MAX_WORKERS` slots for the process lifetime. In variant 1 the guest keeps running
and generating billable inference while `error` claims "retrying within deadline" and the deadline is
in fact long past — the timeout that normally bounds a running worker is disabled. In variant 2 the
missing VM is never recorded, `send_worker_message` still acknowledges `delivery: "queued"` for a
dispatch that can never be delivered, and neither cancel nor force-destroy is available. Recovery
requires manual DB surgery; repeated occurrences exhaust fleet capacity.

**Why existing guards/tests do not prevent it.** The `vm_missing` guard (`:826`) can only help after
absence is recorded, and the only recorder is skipped because of the intent. `queueMessage` refuses
messages only for `cancel`/`destroy` intents (`:201-208`), so pause/resume wedges still accept
messages. The suite covers a failing resume *inside cancel* (`tests/lifecycle.test.ts:462`), a failing
`exec`+`pauseWorker` inside `fail` (`:505`) and inside destroy (`:488`) — but never a failing
`pauseWorker`/`resumeWorker` for its own intent (`grep` for `intent` in tests finds only line 462).

**Recommendation.** (1) In `applyControl` pause/resume, catch the provider error and probe the
existing `vmMissing(w.vm_id)` (`:749`); on a confirmed absence settle immediately — pause → previous
state, resume → `previous_state ?? "ready"` — with `vm_missing: true`, an explanatory `error` and
`intent: null`, mirroring cancel/destroy. (2) In `runControl`, let `cancel`/`destroy` supersede a
pending non-destructive `pause`/`resume` intent instead of throwing, since they are the remediation
path. (3) Do not let the `w.intent` early return in `recover()` skip the absence check for
pause/resume intents.

---

## F2 — MEDIUM — `pause_worker` escapes terminal states and lets reconciliation overwrite a settled reason

**Files/lines at target:** `src/coordinator.ts:816-836` (`runControl` guards), `:837-856`
(`applyControl` pause), `:420` and `:429-432` (`recover`), contrast `:882-889`.
Gating evidence: `src/cli/overview.ts:277-283` vs `src/mcp.ts:127-140`.

**Trigger.** `pause_worker` on any non-destroyed worker. The MCP tool applies no state gate, so
`completed`, `failed`, `cancelled` and `recovery_required` workers are all accepted.

**Code trace.** `runControl` only rejects `destroyed`, `vm_missing` (non-destroy intents), a differing
pending intent, a non-paused `resume` and a redundant `pause`. `applyControl` pause then performs a
`pauseWorker` call and transitions the record to `paused` with `previous_state = <terminal state>`
(`:851-855`) — a terminal state is left. Because `recover()` skips only `terminal.has(w.state)`
(`:420`), the now non-terminal record is re-evaluated: a VM reporting `stopped` moves it to
`recovery_required` with `error: "VM stopped; inspect before resuming"` (`:429-432`), replacing the
reason the worker had actually settled with. `resume_worker` is then refused (`Worker is not paused`),
so the operator loses the documented exit.

**Reproduction** (`/tmp/probes/probe1.test.ts`, `probe3.test.ts`):
```
completed after pause: paused previous_state: completed
completed events: worker.requested,...,worker.completed,worker.paused
failed    after pause: paused previous_state: failed
cancelled after pause: paused previous_state: cancelled
failed error: test suite red: 3 failures
paused: paused error still: test suite red: 3 failures
after reconcile: recovery_required error: VM stopped; inspect before resuming previous_state: failed
after resume: THREW: Worker is not paused
durable result summary still available: test suite red: 3 failures
```

**Consequence.** A settled worker is reported as `paused` in `get_worker`, `list_workers(state=...)`
and `get_swarm_status` counts; `wait_for_state_change` emits a `worker.paused` transition for a worker
that had already reached a terminal state; the CLI, which gates actions per state, then offers
`resume`/`cancel` for a cancelled worker and hides `pause` for it. In the `failed` case the primary
`error` field is replaced by a misleading VM message (the original summary survives only inside the
dispatch result). No source or artifact loss.

**Why existing guards/tests do not prevent it.** `queueMessage` explicitly anticipates
`paused` + terminal `previous_state` (`:226-237`) but nothing validates the transition itself, and no
test pauses a settled worker (`tests/lifecycle.test.ts:286` only exercises a follow-up queued while a
*completed* worker is paused).

**Recommendation.** Reject `pause` when `terminal.has(w.state)` (keeping `cancel`/`destroy`, which are
already accepted for settled workers), or — if pausing a settled worker is intended — keep the
terminal state authoritative: have `recover()` skip `w.intent`-free workers whose `previous_state` is
terminal, and never overwrite `error` for a record that has already settled.

---

## F3 — LOW — `cancel` settles as `cancelled` when quiescence could not be proven

**Files/lines at target:** `src/coordinator.ts:875-907` (cancel), `:725-745` (`quiesce`); contrast
`:785-804` (`fail`) and `:917-926` (destroy).

**Trace.** `quiesce` returns `"paused"` both for a genuinely paused guest and for the ambiguous case
where the OpenCode stop failed *and* `pauseWorker` failed *and* the guest still exists
(`:739-744`). `fail` maps that to `recovery_required` (`:785-798`) and destroy maps it to
`recovery_required` (`:918-926`), but cancel only inspects for `"missing"` (`:890`) and otherwise
transitions to `cancelled` with no `error`. Code-evidenced (not separately reproduced): a cancelled
worker whose OpenCode service may still be generating is terminal, so nothing ever re-verifies it.
**Recommendation.** Treat `"paused"` from `quiesce` as `recovery_required` in the cancel path too, as
`fail` already does. Confidence: medium (the same fake setup as `tests/lifecycle.test.ts:505`
reproduces it; I did not spend a separate probe on it).

---

## Not findings (checked, no defect)

- `queued`→`provisioning` capacity accounting (`runTick` `:316-339`), `MAX_QUEUE` race in `spawn`
  (`:170-191`, non-transactional read-then-write can exceed `SWARMFORGE_MAX_QUEUE` by one under
  concurrent spawns; limit defaults to 1000 and `MAX_WORKERS` is enforced separately) — LOW, not
  reported separately.
- `createWorker` idempotency by slug (`src/providers/freestyle.ts:44-47`) closes the
  "timed-out create retried" double-VM concern; reconciliation adopts a late VM by metadata.
- `store.transition` emits no event for a same-state transition (`:160`); no reachable path relies on
  a repeated transition producing an event.
- Intent-vs-lock behavior (`exclusive` returning an in-flight promise, `control` returning "pending
  intent" metadata) is documented in `docs/MCP-API.md:11` and `tests/lifecycle.test.ts:562-665`.

---

## Tests and limitations

Executed with official Bun 1.4.2 at `/tmp/bun142/bin/bun` (snapshot Bun 1.3.14 cannot parse
`lockfileVersion: 2`; the lockfile was never rewritten). Dependencies installed into the disposable
`/tmp/rv03t` checkout only.

| Command (in `/tmp/rv03t`) | Exit | Result |
|---|---|---|
| `bun install --frozen-lockfile` | 0 | 125 packages (exit captured before the earlier 1.3.14 failure) |
| `bun test tests/lifecycle.test.ts tests/wait.test.ts tests/restart.test.ts tests/session-status.test.ts tests/token-idle.test.ts tests/core.test.ts` | 0 | 81 pass, 0 fail, 302 assertions |
| `bun test /tmp/probes/probe1.test.ts /tmp/probes/probe2.test.ts /tmp/probes/probe4.test.ts` | 0 | 6 pass (diagnostic traces, no assertions) |

Logs: `/workspace/.swarmforge/logs/target-lifecycle-tests.log`, `probe-run.log`,
`probe3-superseded.log`, `probes-summary.txt`.

Reviewer experiments (outside the source checkout, disclosed): `/tmp/rv03t` (detached clone of the
target + `node_modules`), `/tmp/probes/probe1..probe4.test.ts` (diagnostic traces built on the repo's
own `tests/helpers.ts` fakes — `FakeProvider`/`FakeAgent`, no real providers, no real credentials, no
network), `/tmp/bun142/bin/bun` (Bun 1.4.2 toolchain), `/tmp/buninstall.sh`.

Limitations:
- Full suite was not run (whole-suite reviewer's scope); only the six lifecycle-related files.
- F1 and F2 are reproduced end-to-end with local fakes against the exact target. Production
  reachability of F1 depends on a provider call that never succeeds; the "deleted out of band" branch
  is code-evidenced as a supported scenario elsewhere in the same file.
- F3 is code-evidenced only (same fake setup as an existing test, not separately executed).
- No cloud/model/infra provider and no smoke test was invoked; no credentials were read or emitted.
- `probe3.test.ts` exits 1 because of my own probe sequencing (it paused a worker whose fake guest was
  already deleted, then called `resume`); the two behaviors it intended to show are reproduced
  correctly in `probe4.test.ts`. This is a probe-authoring error, not a product failure.
- `/workspace/repo` was left at the assigned baseline `5672ead2a526e07fea9ed11e58b3725e42013527`,
  branch `swarmforge/repo-review-50-20260930/03-worker-transitions/w-97018f1c-1382-4adf-9f82-f033a4d55152`,
  working tree clean, no commits/pushes/tags.