---
name: using-swarmforge
description: Use when delegating work to, monitoring, reviewing, collecting results from, or cleaning up Swarmforge MCP workers.
---

# Using Swarmforge

Use this guide for the Swarmforge worker control plane. Swarmforge provisions OpenCode sessions on Freestyle VMs, stores worker state and results in SQLite, and can hand source changes to an external Git remote. Provisioning, execution, publication, and destruction are separate asynchronous steps. A worker finishing its turn does not mean its source is published or its VM is destroyed.

## Operating principles

1. **Respect the user's scope and authority.** Treat worker-count caps, role restrictions, branch rules, review requirements, stop instructions, and merge/publish authority as hard constraints. Approval to run work does not imply approval to publish externally unless the user says so or the task clearly grants it.
2. **Keep ownership clear.** Assign one owner to each change set. Use distinct tasks and branches for concurrent implementation; avoid simultaneous edits to the same files.
3. **Verify claims.** A worker's summary is a report, not proof. Check the current run, branch, commit, persisted state, reviewer verdict, and integrated test result.
4. **Preserve before cleanup.** Results survive worker destruction, but artifacts and VM-local work do not. Collect what is needed and establish source durability before destroying a worker.
5. **Close the lifecycle.** At task end, account for all workers in scope, destroy retained VMs when authorized, and verify their final states.

## Decide whether to delegate

Use Swarmforge when the task benefits from isolated execution, parallel work, specialist review, or a persistent remote environment. Keep straightforward, tightly coupled edits in the lead's checkout.

Before spawning:

- Read relevant repository instructions and the current MCP/API documentation. Use `docs/MCP-API.md` and `docs/WORKER-PROTOCOL.md` for this Swarmforge repository; use the configured tools' own schema for other deployments.
- Check capacity and existing workers with `get_swarm_status`; use `list_workers` to identify their owners and tasks. Do not mistake aggregate counts for a list of IDs.
- Decide which parts can proceed independently. Write each work package so it has one purpose, an explicit boundary, acceptance criteria, verification steps, and an expected report.
- Avoid spawning workers just to create activity. If the user says “no more coders,” do not restart a coder under another task name or role. Continue only the review, integration, recovery, or cleanup work they still authorize.

### Split the work

Good work packages have separate file ownership and can be judged independently, for example “audit provider credential handling” and “audit lifecycle transitions.” A single shared coordinator or safety file is usually not a good split across several coders. If work overlaps, make it sequential: finish one branch, review it, then base the next change on that branch.

For code changes that will be merged, require an independent review for every implementation branch. Keep the reviewer read-only and name the exact branch, commit, and base. If a branch is rejected, keep it out of integration until a corrected commit has been reviewed.

## Spawn workers clearly

`spawn_worker` accepts `task_id` and `prompt`, with optional `team_id`, `role`, `timeout_seconds`, and `request_id`. It returns a worker ID while the state is usually still `queued`; provisioning continues asynchronously.

Use stable identifiers:

- `team_id` groups related workers and controls the scope of team status.
- `task_id` identifies the work package; make it distinct for independent tasks.
- `request_id` makes a retried spawn idempotent. Retry only with the same ID and identical arguments. Reusing an ID with changed arguments is rejected.
- The `role` describes the worker assignment. Use a reviewer role for review when supported, but state the read-only review requirements explicitly in the prompt.

A useful implementation prompt states:

```text
Goal: <one concrete result>
Scope: <owned files/subsystem; files to avoid>
Acceptance: <observable conditions>
Verification: <commands and important cases>
Git: work only on your assigned branch; commit and persist it; do not merge
Report: summary, files changed, tests and exact output, branch, commit, dirty/persisted state, warnings, follow-up needed
```

Do not let a worker decide that an unrelated cleanup, refactor, or feature is in scope. If the work is blocked, ask for a precise diagnosis and preserved state rather than a speculative rewrite.

## Monitor asynchronous work

Use `get_worker(worker_id)` for a worker snapshot, `list_workers` for scoped and paginated inventories, `get_worker_logs` for lifecycle events and bounded service-log excerpts, and `get_swarm_status` for aggregate counts, capacity, and usage.

Prefer `wait_for_state_change` over rapid polling:

1. Filter by the relevant `worker_id`, `team_id`, or `task_id`, and by states that matter.
2. Use waits of at most 25 seconds. Keep the returned `next_cursor` and pass it to the next call so transitions are not skipped.
3. `changed:false` means the wait timed out without a matching event; it does not mean the worker failed.
4. After a matching event, reread `get_worker` and then fetch the corresponding `get_worker_result`.

Lifecycle events report durable state transitions, not live VM power state. A worker may move through `queued → provisioning → booting → ready → running`; a completed turn can have a later follow-up, and a pause/resume or cancellation can add control transitions. Do not assume one event equals one task completion.

### State guide

| State | What it tells you | Next action |
| --- | --- | --- |
| `queued`, `provisioning`, `booting` | Work has been accepted but the session is not ready or running yet. | Wait for transitions; inspect errors if progress stops. |
| `ready` | The VM/session is available for dispatch. | Check whether a prompt is pending or dispatch the authorized work. |
| `running`, `waiting` | A turn is active or waiting on its model/session. | Read status and logs; remember follow-up messages queue behind it. |
| `paused` | The VM/session is paused; time budget is suspended. | Resume only when authorized; inspect pending control intent. |
| `completed` | The current run completed. The VM may still exist, and future messages may reopen the worker. | Validate the current result and durability, collect artifacts, then clean up when authorized. |
| `failed` | The run failed; the VM may still contain useful files. Some failed workers can accept a follow-up. | Read the error, logs, result, and Git state before retrying or destroying. |
| `cancelled` | Execution stopped and queued messages were cancelled. The VM is retained. | Inspect or persist useful work, then destroy when authorized. |
| `recovery_required` | Safe delivery or cleanup could not be established. | Preserve the VM/work, determine what is local versus remote, and resolve before normal destruction. |
| `destroyed` | VM cleanup completed. | Result metadata remains queryable; VM artifacts and unpersisted files are gone. |

### Transient failures and stalled workers

Provider and OpenCode failures can be retried while the worker remains active. Before intervening, check `state`, `error`, `last_activity_at`, token progress, pending messages/control, recent logs, and the latest run result. A quiet excerpt or one failed operation is not proof of a stuck worker.

The scheduler may quiesce a run after a period without token progress and move it to `recovery_required`, retaining the VM for inspection. Follow the state and current scheduler policy; do not depend on a guessed timeout. If work is still active, allow its authorized retry/deadline to proceed. If the scheduler has quiesced it, inspect the VM and Git state before resuming, cancelling, or destroying.

`send_worker_message` queues a separate turn in the same OpenCode session; it is not an interrupt. Its acknowledgment means queued, not completed or delivered to the model. Do not send repeated copies when the first message is still pending. To stop an active run, use the explicit pause/cancel operation rather than expecting a follow-up message to interrupt it.

## Validate worker output

Fetch the latest result only after the corresponding run settles. Confirm its `run_id` matches the latest dispatch; a stale `result.json` from an earlier run is not evidence of success. The result schema includes `worker_id`, `task_id`, `run_id`, `status`, `summary`, `files_changed`, `tests`, `git`, `warnings`, `needs_followup`, and `followup_reason`.

Check the report for:

- A concise summary and accurate list of changed files.
- The actual verification command, whether it ran, and its pass/fail output. “Tests passed” without a command or evidence is incomplete.
- Branch and commit identity; whether the worktree was clean; and whether the commit is persisted outside the VM.
- Warnings, remaining risks, and any reason the task needs another turn.
- Credentials or sensitive data. Never reproduce secrets in messages, results, logs, or artifacts.

For a failed or missing result, inspect `get_worker_logs` and `get_worker` rather than inventing a success report. Use `get_worker_result(worker_id, run_id)` when a specific run must be distinguished from a later follow-up.

## Collect artifacts

Artifacts are stored on the VM under `.swarmforge/artifacts` and disappear on destruction. Collect any review report, benchmark, or other deliverable before cleanup.

1. Call `list_worker_artifacts` with a path relative to the artifacts root; the empty string lists the root. Do not prefix the argument with `.swarmforge/artifacts`.
2. Call `get_worker_artifact` with the worker-relative path. It returns a resource link and range metadata, not file bytes.
3. Read the URI with MCP `resources/read`. For large files, advance using `next_offset` and keep each chunk bounded (at most 32 KiB).
4. Treat missing files, path/symlink rejection, and credential screening as real outcomes. Do not try to bypass path checks or retrieve arbitrary VM files.

Persist reports you need outside the VM before destroying it. A result record survives destroy; artifact bytes do not.

## Review branches independently

For each implementation branch that may be merged:

1. Record its exact remote branch, head SHA, base SHA, and worker ID. Fetch the named branch; do not review a stale result file or a similarly named local branch.
2. Give a separate reviewer the intended behavior, previous findings, exact delta, and a read-only instruction. Request `APPROVED` or `CHANGES_REQUESTED`, with severity, file/line evidence, reproduction, tests run, and residual risk.
3. Check that the reviewer actually inspected the target SHA and left its review checkout clean. A review summary that names a different base/head does not approve the branch.
4. On `CHANGES_REQUESTED`, keep the implementation branch out of integration. Send findings only to an authorized coder. Review the new delta against the previously rejected commit, then re-review any substantive conflict resolution.
5. Destroy completed reviewers after recording their results if no follow-up review is pending.

Reviews should seek behavior failures, not just style: verify the reported bug is reproduced, the fix closes it, adjacent failure paths remain safe, and tests distinguish fixed behavior from the original bug. Read-only means no patching or committing to the implementation branch.

## Integrate and publish

Do integration in an isolated clone or worktree when the user's checkout has local/untracked files or concurrent changes. Keep each reviewed branch separate until its review approves it. Merge only the approved commit; never merge the worker's branch name blindly if it has moved since review.

Before publishing:

- Confirm every implementation branch in the merge has an approving review for its current SHA.
- Check merge ancestry and conflicts. Resolve conflicts without dropping tests or security checks; meaningful conflict resolutions need review too.
- Run the relevant suite and static checks on the integrated result. Branch tests alone do not establish that the combined changes pass.
- Confirm the destination branch has not advanced unexpectedly. Push without force unless a separately authorized workflow requires something else.
- Preserve unrelated files and work. Do not stage broad directories when untracked user files are present.

`get_worker_result.git.persisted` and a local commit are not interchangeable. With automatic handoff, Swarmforge pushes and verifies the commit; confirm the reported branch and SHA against the remote before merging. If you had to recover a bundle or commit from a VM, verify the bundle and ancestry, push the exact commit to its assigned branch, and obtain review on that commit before integration.

## Safe cancellation and destruction

`cancel_worker` stops execution but retains the VM, filesystem, and artifacts. `destroy_worker` permanently removes the VM and its artifacts after persistence checks. Normal destruction can be refused and leave the worker in `recovery_required`; that refusal protects work whose durability is unknown.

Use this order:

1. Read the latest worker/run result and collect needed artifacts.
2. Inspect the branch, commit, dirty state, and remote persistence. If a worker is still running, first decide whether it should finish, pause, or cancel under the user's instructions.
3. Call normal `destroy_worker`.
4. If it refuses, inspect the exact reason. Preserve or push needed commits and retry normal destroy.
5. Use `force:true` only when the user authorized losing local work, or when you have independently verified all needed work is persisted and authorized the destructive cleanup. Before force, compare the VM's `HEAD` and dirty state with the remote branch; do not rely only on an earlier run's result.
6. Verify the final state is `destroyed` and check aggregate capacity/status.

Do not destroy merely to clear a `recovery_required` label. A branch push may not cover uncommitted files or extra commits. Conversely, when the user explicitly requests broad cleanup, do not leave completed, cancelled, or failed records idle: enumerate the specified team/task scope across every page, preserve any needed evidence, and destroy matching terminal workers.

Scope cleanup carefully. `get_swarm_status` provides totals, not worker IDs. Use `list_workers` filtered by the requested scope and terminal states (`completed`, `failed`, `cancelled`, and where relevant `recovery_required`), follow `next_offset`, and inspect every candidate. Do not destroy unrelated teams or active workers unless the user explicitly included them. When a user says “all workers,” clarify only if the Swarmforge instance contains unrelated teams and the intended scope cannot be inferred; otherwise apply the stated scope and report what was removed.

## Common mistakes

| Mistake | Better handling |
| --- | --- |
| Assuming `spawn_worker` means the VM is ready | It usually returns `queued`; wait for lifecycle transitions. |
| Treating `changed:false` as an error | Continue waiting with its `next_cursor`, or inspect the worker directly. |
| Sending a second copy because a turn is slow | Check pending messages and run IDs; messages are queued, not interrupting. |
| Trusting a stale result or a worker's unverified Git claim | Match the `run_id`; verify branch, SHA, clean state, and remote persistence. |
| Merging because tests pass | Require independent review for that branch, then test the integrated result. |
| Destroying a completed/cancelled/failed worker without checking its VM | Collect artifacts and verify source durability first. |
| Using `force:true` to bypass an unexplained refusal | Inspect and preserve the work; force can irreversibly discard it. |
| Checking only the workers created in the current turn after a broad cleanup request | Enumerate all workers within the user's requested scope and paginate through the full list. |

## Tool quick reference

| Operation | MCP tool |
| --- | --- |
| Start isolated worker | `spawn_worker` |
| Inspect one worker / enumerate workers | `get_worker` / `list_workers` |
| Wait for events | `wait_for_state_change` |
| Queue a follow-up | `send_worker_message` |
| Pause / resume / cancel | `pause_worker` / `resume_worker` / `cancel_worker` |
| Read results / logs | `get_worker_result` / `get_worker_logs` |
| List / fetch artifacts | `list_worker_artifacts` / `get_worker_artifact`, then `resources/read` |
| Inspect task/team/swarm totals | `get_task` / `get_team_status` / `get_swarm_status` |
| Destroy / verify cleanup | `destroy_worker` / `list_workers`, `get_swarm_status` |

For exact arguments, bounds, artifact URI format, and pagination semantics, consult `docs/MCP-API.md`. For worker result fields, filesystem locations, Git handoff, and guest boundaries, consult `docs/WORKER-PROTOCOL.md`.
