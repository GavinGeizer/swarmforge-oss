# SwarmForge reviewer 01 — capacity accounting, spawn admission, queued/provisioning limits

**Target (exact):** `d428e0f730ed5649485732e95d39c32f5d6a8895`
(`feature/binary-config-serve-20260930`, HEAD subject `Bound compiled fixture teardown independently of test assertions`)
**Assigned branch (untouched, baseline):** `5672ead2a526e07fea9ed11e58b3725e42013527`
**Disposable checkout:** `/tmp/opencode/rev01` (detached, `git rev-parse HEAD` = target)
**Reviewer probes:** `/tmp/opencode/probe/*.ts` (outside the source checkout; `/workspace/repo` clean, no commits)
**Verdict:** FINDINGS (2)

## Scope

Capacity accounting, spawn admission, queued/provisioning limits, fairness and
oversubscription at 50/400 workers. Files read: `src/coordinator.ts` (978),
`src/runtime.ts` (213), `src/domain.ts` (234), plus supporting `src/config.ts`,
`src/store.ts`, `src/providers/freestyle.ts`, `src/mcp.ts` for trace confirmation.
Deterministic local fake providers only; no cloud/model provider, no VM, no smoke run.

## Baseline admission behaviour verified correct

Probe `p1_capacity.ts` — 400 spawns, `SWARMFORGE_MAX_WORKERS=50`,
`SWARMFORGE_MAX_PROVISIONING=4`, `MAX_QUEUE=1000`, 60 ticks:

```
spawned=400 queuedAfterSpawn=400 vms=0 created=0
peakProviderVms=50 peakProvisioningOrBooting=4 peakCapacityAccounted=50
peakConcurrentCreates=1
admittedInFifoOrder=true admittedCount=50
states= {"running":50,"queued":350}
```

- No oversubscription: peak 50 live provider VMs against a cap of 50.
- The reservation counters at `src/coordinator.ts:317-338` are mutated
  synchronously inside one `runTick`, so no other task can interleave between the
  `store.all()` read and the promotion loop; `this.ticking` (`src/coordinator.ts:302`)
  plus per-worker `exclusive()` (`src/coordinator.ts:251-257`) keep at most one
  `step()` per worker in flight, so `createWorker` is never issued twice concurrently
  for one worker.
- `store.all()` is `ORDER BY rowid` (`src/store.ts:139-144`), i.e. strict FIFO across
  teams. Fairness between teams is therefore *not* implemented, but
  `docs/ARCHITECTURE.md:36` states "teams are labels, not security tenants" and
  disclaims a distributed scheduler, so global FIFO is a documented design choice and
  is **not** reported as a defect.
- `SWARMFORGE_MAX_QUEUE` boundary is exact (probe `p3_bounds.ts` (b)):
  `MAX_QUEUE=5 -> accepted=5 rejected=7`; cancelling a queued worker frees exactly one
  slot. `request_id` retry idempotency under a full queue is correct
  (`src/coordinator.ts:173-184` + `src/store.ts:75-84`), and is already covered by
  `tests/lifecycle.test.ts:5-21`.
- A `bounded()` timeout during `createWorker` cannot leak a VM: the provider is
  idempotent by slug (`src/providers/freestyle.ts:44-47`, slug from `worker_id`), and
  the worker keeps its `provisioning` reservation while retrying.

## Findings

### F1 — MEDIUM: session revival occupies provisioning slots, head-of-line blocking new admission for up to 300 s

- **File / line (target):** `src/coordinator.ts:323-325` (slot accounting) and
  `src/coordinator.ts:330-331` (the gate); root cause `src/coordinator.ts:238-243`.
- **Trigger:** `send_worker_message` on a `failed` or `recovery_required` worker that
  still owns a VM transitions it to `booting`, not to a new-VM path:
  `src/coordinator.ts:238-243` — `w.state === "completed" ? "ready" : "booting"`.
  The next tick counts every `booting` worker against
  `SWARMFORGE_MAX_PROVISIONING` (`src/coordinator.ts:323-325`), so revived workers
  consume the budget intended for *concurrent VM creation*.
- **Consequence:** once `MAX_PROVISIONING` (default 4) such revivals are in
  `booting`, `capacity < SWARMFORGE_MAX_PROVISIONING` is false and **no** queued
  worker can be promoted, even though `capacity` accounting shows the vast majority of
  the 50 VM slots free and **no new VM is being created**. The block lasts until
  `SWARMFORGE_PROVISION_TIMEOUT_SECONDS` (default 300) elapses, because
  `src/coordinator.ts:444-451` fails a `booting` worker only after
  `provision_started_at` is 300 s old and `queueMessage` resets that field to
  `Date.now()`.
- **Reproduction** (`/tmp/opencode/probe/p2_booting_slot.ts`, fake provider/agent,
  exit 0): 4 workers driven to `running`, transitioned to `failed` (a real
  inference/VM outage does this), then each given a follow-up message whose session
  restore always throws:
  ```
  post-message states= ["booting","booting","booting","booting"]
  fresh worker state after 10 ticks: queued
  capacity accounting = 4 of MAX_WORKERS=50
  provisioning-slot consumers = ["t0:booting","t1:booting","t2:booting","t3:booting"]  MAX_PROVISIONING=4
  provider VMs created total = 4  (only 4 real VMs exist)
  new queued work is blocked: true
  ```
  The bound is confirmed in `p3_bounds.ts` (a): after `provision_started_at` is aged
  past 300 s, `revived=["failed","failed","failed","failed"] fresh=ready`.
- **Why existing guards/tests do not prevent it:** `tests/lifecycle.test.ts:666-678`
  ("a message is accepted again once the failed lifecycle operation has settled")
  asserts only that the revived worker reaches `booting`; `harness()` in
  `tests/helpers.ts:20-21` pins `MAX_PROVISIONING` to 1 and creates a single worker,
  so the shared-budget interaction is never exercised.
  `tests/lifecycle.test.ts:40-54` is the only limit test and it only counts
  `queued` workers. Nothing in `runTick` distinguishes "booting because this worker
  needs a new VM" from "booting because this worker is restoring an existing session".
- **Recommended correction:** give the two cases distinct accounting. Either count the
  provisioning gate only for workers that have no `vm_id` yet
  (`w.state === "provisioning" || (w.state === "booting" && !w.vm_id)`), or add a
  separate state/flag for session revival and exclude it from
  `src/coordinator.ts:323-325`. A dedicated revival bound shorter than
  `SWARMFORGE_PROVISION_TIMEOUT_SECONDS` would remove the 300 s worst case as well.

### F2 — MEDIUM: `fail()` does not clear a durable `intent`, so a pause racing a terminal failure resurrects `failed` into a capacity-holding `paused`

- **File / line (target):** `src/coordinator.ts:800-804` — the main `fail()` transition
  writes `{ error, completed_at, deadline_at: null }` with **no `intent: null`**.
- **Code trace:**
  1. `step()` is inside the `running`/`waiting` branch awaiting
     `this.provider.getWorker(w.vm_id!)` (`src/coordinator.ts:487`) — an await window
     up to `SWARMFORGE_API_TIMEOUT_MS` (default 30 s).
  2. A lead calls `control(id, "pause")`. `runControl` durably patches
     `intent: "pause"` (`src/coordinator.ts:833`) and then awaits
     `this.exclusive(id, () => this.step(id))` (`src/coordinator.ts:834`). Because a
     step is already in flight, `exclusive()` returns the *existing* promise
     (`src/coordinator.ts:251-257`) and never runs a fresh `step()`, so the intent is
     not applied in this pass.
  3. The in-flight step sees the guest stopped and calls
     `await this.fail(w, "Worker VM stopped")` (`src/coordinator.ts:504-506`), which
     leaves `intent: "pause"` durable on a now-terminal `failed` worker.
  4. The next tick's step filter admits any worker with a truthy `intent`
     (`src/coordinator.ts:345`), so `applyControl` pauses the VM and transitions the
     **failed** worker to `paused` (`src/coordinator.ts:851-855`).
- **Trigger:** a `pause_worker` issued while the worker is being monitored and the
  turn then fails — reachable on both the "Worker VM stopped" path
  (`src/coordinator.ts:504-506`) and the "Missing or malformed structured result" path
  (`src/coordinator.ts:595-600`), which is inside `monitor()` after
  `await this.bounded(this.agent.inspect(w))`.
- **Consequence:** a terminal failure is silently converted into a non-terminal
  `paused` state. `get_worker_result` returns `result: null` forever
  (`src/mcp.ts:154-160`) and `wait_for_state_change({states:["failed"]})` never fires,
  so the lead hangs; the worker is re-stepped every tick indefinitely, and its retained
  VM keeps consuming one of the 50 `SWARMFORGE_MAX_WORKERS` slots
  (`docs/ENVIRONMENT.md:36`) until an operator notices and destroys it. The failure
  reason is only visible as a `paused` worker's `error` string.
- **Reproduction** (`/tmp/opencode/probe/p4_stale_intent.ts`, fake provider/agent,
  exit 0): worker driven to `running`; the guest is set `stopped` out of band and
  `provider.getWorker` is given a 40 ms delay; `control(id,"pause")` is issued while
  the `getWorker` round-trip is in flight:
  ```
  control('pause') returned state=failed
  after fail(): state=paused intent=null error=Worker VM stopped
  next tick: state=paused previous_state=failed intent=null error=Worker VM stopped
  terminal? false
  result available? no  vm retained? true  vms=1
  5 more ticks: state=paused intent=null vms=1 (never terminal, capacity held)
  ```
  Note the caller is told `failed` while the very next tick rewrites the state.
- **Why existing guards/tests do not prevent it:** the sibling branches of the same
  function do clear it — the VM-missing branch writes `intent: null`
  (`src/coordinator.ts:776-782`) and `applyControl`'s cancel branch writes
  `intent: null` (`src/coordinator.ts:895-905`) — so the omission at
  `src/coordinator.ts:800-804` is an inconsistency, not an intentional design. No
  test drives `control()` concurrently with an in-flight `step()`: every
  `control(..., "pause")` in `tests/` is awaited from a steady state (e.g.
  `tests/lifecycle.test.ts:118,292,302,439,467,604,631`,
  `tests/token-idle.test.ts:160`, `tests/wait.test.ts:237`). `tests/helpers.ts`
  fakes resolve synchronously, so the 30 s await window is never entered.
- **Recommended correction:** add `intent: null` to the transition fields at
  `src/coordinator.ts:800-804` so a terminal outcome always consumes the intent, and
  have `runControl` re-check for a terminal state after `exclusive()` returns before
  reporting the post-control state (currently `src/coordinator.ts:835` returns a value
  the next tick will invalidate). `cancel` and `destroy` variants of the same race are
  benign because the stale intent is the operator's own requested outcome.

## Tests and probes actually run

| Command | Exit | Result |
| --- | --- | --- |
| `/tmp/opencode/bun-linux-x64/bun install --frozen-lockfile` (in /tmp checkout) | 0 | 125 packages; lockfile unmodified |
| `bun test tests/lifecycle.test.ts tests/core.test.ts` (Bun 1.4.2) | 0 | 44 pass, 0 fail, 157 assertions, 2 files, 181 ms |
| `bun run p1_capacity.ts` | 0 | 400 workers / 50 cap: no oversubscription, FIFO |
| `bun run p2_booting_slot.ts` | 0 | F1 reproduced |
| `bun run p3_bounds.ts` | 0 | F1 300 s bound; MAX_QUEUE boundary correct |
| `bun run p4_stale_intent.ts` | 0 | F2 reproduced |
| `bun run p5_redact.ts` | 0 | production `Redactor` scrubbed all canaries |

Toolchain: snapshot `bun` is 1.3.14 and cannot read `lockfileVersion: 2`; official
Bun 1.4.2 was installed to `/tmp/opencode/bun-linux-x64/` and the lockfile was never
rewritten. Not run (out of scope for this reviewer): the full test suite, the
packaging/build targets, and `scripts/smoke.ts` (real billable VM). Reused repo fakes
from `tests/helpers.ts` plus local fake provider/agent classes written for these
probes only.

## Disclosure: accidental index pollution, fully reverted

While creating the disposable checkout I first ran
`git --work-tree=/tmp/opencode/rev01 checkout <target> -- .` from `/workspace/repo`.
That command updated the **assigned repo's index** to the target tree and wrote files
to the /tmp work tree. It was detected before any further work (`git status` showed 26
staged/unstaged entries) and reverted with `git reset --hard 5672ead`. Post-revert
verification: `HEAD=5672ead2a526e07fea9ed11e58b3725e42013527`, `git status --porcelain`
= 0 lines, branch unchanged, no commits/pushes/tags created, no untracked files, no
stash. The disposable clone used for all review work is `/tmp/opencode/rev01`
(detached at the target, clean). The only other repository-level side effect is the
instructed `git fetch origin feature/binary-config-serve-20260930`, which updated a
remote-tracking ref only.

## Limitations

- F1 and F2 are reproduced with injected local doubles; the provider and inference
  services themselves were never contacted, so real API timings could change the width
  of the race window but not the logic error.
- `MAX_WORKERS`/`MAX_PROVISIONING` misconfiguration (e.g. provisioning > workers) was
  traced by inspection only, not probed; it is not a bypass because `capacity` is
  checked first in the same condition (`src/coordinator.ts:330-331`).
- Idle-timestamp pre-ageing in probe `p3_bounds.ts` (a) simulates elapsed time instead
  of waiting 300 s; the arithmetic and the bound are therefore exact, but no wall-clock
  300 s run was performed.
- Per-team fairness, queue-thrash at 400 workers, and startup reconciliation at
  >MAX_WORKERS orphaned VMs were read but not probed; no defects found in them.
- Credential-shaped strings used by the probes are fixtures only; all log lines were
  passed through the production `Redactor` (`src/security.ts:43-50`) before export,
  and no canary survived. No secret files were inspected.

## Artifacts

`/workspace/.swarmforge/artifacts/review.md`,
`/workspace/.swarmforge/artifacts/findings.json`,
logs: `/workspace/.swarmforge/logs/rev01_redact.log`.
