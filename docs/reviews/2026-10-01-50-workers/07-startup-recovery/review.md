# Reviewer 07 — restart recovery, interrupted intents, stale sessions, stranded workers

- **Target (exact)**: `d428e0f730ed5649485732e95d39c32f5d6a8895` (branch `feature/binary-config-serve-20260930`, `GavinGeizer/swarmforge-oss`)
- **Checkout**: disposable detached clone at `/tmp/opencode/rev07/sf` (`git rev-parse HEAD` = `d428e0f730ed5649485732e95d39c32f5d6a8895`)
- **Assigned workspace**: `/workspace/repo` at baseline `5672ead2a526e07fea9ed11e58b3725e42013527`, left unchanged and clean (read-only review)
- **Scope reviewed**: `src/coordinator.ts` (recover/reconcile, `step`, `applyControl`, `fail`, `quiesce`, `track`/`stop`), `src/store.ts` (dispatch/intent durability), `src/serve.ts` + `src/serve-command.ts` + `src/runtime.ts` (startup order, startup rollback, signal/shutdown, process lock, event log cursor), `src/providers/opencode.ts` (session/snapshot recovery), `src/domain.ts` (terminal set, dispatch states), plus `tests/restart.test.ts`, `tests/lifecycle.test.ts`, `tests/serve.test.ts`, `tests/session-status.test.ts`, `docs/ARCHITECTURE.md`, `docs/MCP-API.md`.
- **Verdict**: FINDINGS (1 MEDIUM, 1 LOW). No CRITICAL/HIGH.

## Findings

### F1 — MEDIUM — `recovery_required` is terminal and unresumable even when the coordinator itself parked it on a resumable guest

- **File / line (target)**: `src/coordinator.ts:831` (the gate), `src/coordinator.ts:420` (terminal early return), `src/coordinator.ts:431`, `src/coordinator.ts:575`, `src/coordinator.ts:785-804`, `src/coordinator.ts:909-926`, `src/coordinator.ts:344-349`.
- **Concrete trigger**: any of three ordinary conditions puts a worker into `recovery_required` while its guest is stopped, paused or healthy-and-idle:
  1. an interrupted submit (process crash/SIGKILL between `store.claimDispatch` and a landed prompt, or a single failed `agent.submit`) — `src/coordinator.ts:561-579` marks the dispatch ambiguous and transitions to `recovery_required` ("Prompt delivery ambiguous; inspect session before sending a follow-up") on a guest that is still `running` and idle;
  2. reconciliation observing a stopped guest — `src/coordinator.ts:429-432` sets `recovery_required` with the message "VM stopped; inspect before resuming";
  3. `fail()`/`destroy` where `quiesce()` could only pause the guest (`src/coordinator.ts:785-804`, `src/coordinator.ts:909-926`).
- **Consequence**: `recovery_required` is in `terminal` (`src/domain.ts:17-23`), so `runTick` filters it out (`src/coordinator.ts:344-349`) and `runRecover` returns before the paused/stopped mapping (`src/coordinator.ts:420` precedes `421-432`; the `!terminal.has(w.state)` guard at line 429 is therefore dead code). `resume_worker`/`control(…,"resume")` refuses with `Worker is not paused` (`src/coordinator.ts:830-831`) because the worker is not in `paused`, so the guest is never restarted. The worker plus its retained VM is held indefinitely and keeps consuming `SWARMFORGE_MAX_WORKERS` capacity (`src/coordinator.ts:317-322` counts any non-destroyed worker that still has a VM). The only recovery is `send_worker_message`, which cancels the in-flight dispatch and delivers the operator's new text instead: the original task prompt is never re-delivered (`worker.prompt` is retained on the record but only `create`/`queueMessage` ever enqueue). The error string the operator is given points at a resuming step that the API rejects.
- **Reproduction** (reproduced with the repo's own fake provider/agent, disposable lab `/tmp/opencode/rev07/lab`, Bun 1.4.2):
  - `probes/p1.test.ts` "P1": worker to `running`, guest state set to `stopped`, `recover()` → `recovery_required` ("VM stopped; inspect before resuming"); `control(id,"resume")` → `Worker is not paused`; a second restart + `recover()` + `tick()` leaves it `recovery_required`.
  - `probes/p1.test.ts` "P2": `agent.abort` throwing and `provider.exec` failing for `systemctl stop` → `fail()` → `recovery_required` with the guest `paused`; after a restart it is still `recovery_required` and `resume` is again refused.
  - `probes/p2.test.ts` "P5": dispatch left in `sending`, session idle with no message → first tick → `recovery_required` ("Prompt delivery ambiguous…") with guest state `running`, and `resume` refused.
  - `probes/p3.test.ts` "P8": `message()` on that stranded worker does recover it (`recovery_required → booting → running`) but the runs list becomes `["cancelled:Implement a feature","sent:please continue"]`, i.e. the originally spawned prompt is dropped.
  - `probes/p2.test.ts` "P4": with `SWARMFORGE_MAX_WORKERS=2`, two retained-VM workers (one `failed`, one `recovery_required`) keep a third spawn `queued` and no new VM is created — capacity stays consumed until destroy.
- **Code trace**: `runControl` accepts `resume` only when `w.state === "paused"` (`:830-831`) → `runRecover` returns for every terminal state before it can map a paused guest back to `paused` (`:420`) → `applyControl` has the `resumeWorker` call needed (`:859`, and `:915-916` proves a paused guest is treated as resumable during destroy) but it is unreachable for these workers.
- **Why existing guards/tests do not prevent it**: guards enforce the *entry* into the state, not a way out. `tests/lifecycle.test.ts:144`, `:179`, `:264`, `:352` assert `recovery_required` and VM retention only; no test resumes or otherwise recovers a worker from `recovery_required`. `docs/ARCHITECTURE.md:16` documents follow-up messages as the resolution for `recovery_required`, which matches the observed behaviour, so this is an operability gap rather than a divergence from the design: the coordinator's own messages promise resumption ("inspect before resuming") that no tool can perform, and the guest may keep an idle OpenCode service running indefinitely.
- **Recommended correction**: make the recovery path match the messages it emits — e.g. in `runRecover`, handle a paused/stopped guest for a terminal `recovery_required` worker before the `terminal.has` return (transition to `paused` with `previous_state`), or accept `resume` when `w.state === "recovery_required"` and the guest is paused/stopped (transitioning to `previous_state ?? "ready"` after `resumeWorker`); alternatively reword the errors to "destroy or send a follow-up" and record the stranded dispatch's message text in the error so the operator can recover the prompt.
- **Confidence**: high (reproduced locally; behaviour is deterministic in the fake harness).

### F2 — LOW — the `result.json` fallback is stricter than the schema: a valid result without `run_id` is discarded

- **File / line (target)**: `src/coordinator.ts:685`; schema reference `src/domain.ts:45` (`run_id` is optional).
- **Trigger**: a worker writes a schema-valid `.swarmforge/result.json` without `run_id` (the bootstrap prompt requests the field but the schema marks it optional) and its session can no longer be read (OpenCode crash/pruned session), so the file fallback is the only result source.
- **Consequence**: `fallback()` returns `null`, `identify()` never runs, and the worker is left in `waiting` with `result === null` until the token-idle budget expires, then fails and — with unpersisted work — lands in `recovery_required`, discarding a successful report. The message path has no such requirement: `identify()` (`src/coordinator.ts:665-672`) overwrites `run_id` with the dispatch's, so the check is purely a staleness guard.
- **Reproduction**: `probes/p3.test.ts` "P7" — settled session with no reply plus a result file without `run_id` → worker `waiting`, no result; the same file with `run_id` → `completed`.
- **Why existing guards/tests do not prevent it**: `docs/ARCHITECTURE.md:26` documents "a matching-run `result.json`", so the strictness is intentional; existing tests always include `run_id` (`tests/lifecycle.test.ts:212`).
- **Recommended correction**: keep the staleness guard but treat a missing `run_id` as a match only when the file's `status`/`summary` is the sole unresolved dispatch for that worker, or record the run id in the path/name the bootstrap already writes; otherwise surface the discarded result in the worker error so the report is not silently lost.
- **Confidence**: medium (reproduced; requires a worker that omits the optional `run_id`).

## Checked and found sound (no defect)

- Durable control intents survive a restart: a persisted `pause`/`cancel`/`destroy` intent is re-applied on the first tick after recovery (`probes/p1.test.ts` "P3": `paused`/`cancelled`/`destroyed`, VM deleted only for destroy).
- Interrupted provisioning adopts the VM by metadata instead of creating a second one, and an untracked owned VM is retained as a visible `recovery_required` orphan (`src/coordinator.ts:365-396`; `tests/lifecycle.test.ts:179`).
- A VM confirmed absent (404) becomes `failed` + `vm_missing` and is never silently re-provisioned (`src/coordinator.ts:408-419`; `tests/lifecycle.test.ts:202`, `:337`).
- A `sending` dispatch whose prompt did land is marked `sent` rather than replayed (`src/coordinator.ts:561-567`; `tests/lifecycle.test.ts:250`).
- Durable token-progress baseline survives restart, so the idle budget is not reset (`src/store.ts:265-276`; `tests/token-idle.test.ts`).
- Startup order, startup rollback and the abort-during-recovery path release the process lock, both listeners and the database only after the in-flight writer drains (`src/serve.ts:140-198`; `tests/serve.test.ts:331`, `:354`, `:380`, `:432`).
- `track`/`stop` correctly prove no writer remains before the store is closed; `waitForStateChange` waiters are woken instead of polling a closing database (`src/coordinator.ts:82-90`, `:258-300`).
- Signal handling exits 0 after a cancelled startup, 70 on the forced-shutdown deadline, and re-arms no deadline for a second signal (`src/serve-command.ts:88-137`; `tests/commands.test.ts`).

## Tests and probes run

Toolchain: official Bun **1.4.2** unpacked at `/tmp/opencode/bun142/bun-linux-x64/bun` (snapshot `bun` is 1.3.14 and cannot read this `lockfileVersion: 2` lockfile). `bun install --frozen-lockfile` in the disposable lab copy; the lockfile was **not** rewritten (`git status --porcelain` empty in the lab).

- `bun test tests/restart.test.ts tests/lifecycle.test.ts` (target sources, lab copy): **35 pass, 0 fail** (exit 0), 118 assertions.
- `bun test probes/p1.test.ts`: **3 pass, 0 fail** (exit 0) — P1/P2 stranded states, P3 durable intent replay.
- `bun test probes/p2.test.ts`: **3 pass, 0 fail** (exit 0) — P4 capacity retention, P5 interrupted submit, P6 run_id-less file.
- `bun test probes/p3.test.ts`: **2 pass, 0 fail** (exit 0) — P7 run_id fallback, P8 follow-up recovery.

Probe files live only in the disposable lab at `/tmp/opencode/rev07/lab/probes/` (`p1`, `p2`, `p3`.test.ts) and reuse `tests/helpers.ts` (`FakeProvider`/`FakeAgent`, in-memory SQLite, no real provider, no real infrastructure). No cloud/model provider was contacted. No full suite was run (only whole-suite reviewers do that) and no build/packaging was compiled.

## Limitations

- Behaviour of the real Freestyle provider is unverified: whether `exec`/`prepare` can run against a `stopped` guest (relevant to whether `send_worker_message` can rescue F1 case 2) and whether `vms.get(slug)` resolves a slug (relevant to `createWorker`'s idempotency guard, `src/providers/freestyle.ts:44-47`) were not exercised, because that would require calling the real provider. Both are reported as unverified, not as findings.
- `SWARMFORGE_DB_PATH` restart behaviour was exercised with a real on-disk SQLite file (`tests/restart.test.ts`) plus the probe scenarios on the same store, but no process was killed with SIGKILL; crash points were simulated by writing the durable state a crash would leave (`intent`, dispatch `sending`).
- Metrics, artifact transfer, CLI/TUI and packaging were out of scope and not reviewed.
- Reviewed artifacts were passed through the production `Redactor` (`src/security.ts`) before export; no credential values, tokens or credential-shaped URLs appear in this report or in `findings.json`.
