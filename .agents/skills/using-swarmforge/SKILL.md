---
name: using-swarmforge
description: Use when choosing a Swarmforge worker strategy or delegating, monitoring, reviewing, integrating, recovering, or cleaning up Swarmforge MCP work.
---

# Using Swarmforge

Swarmforge runs isolated OpenCode sessions on Freestyle VMs and stores worker state and results in SQLite. The lead owns task decomposition, evidence checks, integration, and cleanup. Provisioning, execution, source publication, and VM destruction are separate asynchronous steps.

## Artifact retrieval

Use `read_worker_artifact` for live plaintext and `read_artifact` for preserved plaintext. For a complete text or binary file, preserve it, then run `swarmforge artifacts download ARTIFACT_ID --output PATH`; bytes stream to disk with checksum verification. The legacy `get_worker_artifact`/`resources/read` path yields base64 and is only for clients explicitly requiring binary resources.

## Operating constraints

- Respect the user's worker caps, permitted roles, branch rules, review requirements, stop instructions, and publish/merge authority. A strategy does not grant permission to spawn, publish, or discard work.
- Give each change set one owner. Concurrent coders need separate branches and file ownership; sequence overlapping edits.
- Verify worker claims against the current run, exact commit, remote persistence, reviewer verdict, and integrated checks.
- Require independent review of each implementation branch before merging. Reviewers remain read-only; substantive conflict resolutions need review too.
- Collect needed artifacts and establish source durability before destroying a VM. Results and preserved artifacts survive destruction; unpreserved VM files and unpersisted work do not.
- Account for every worker in scope at task end. Complete authorized cleanup and verify final states.

## Choose a strategy

Keep straightforward, tightly coupled edits in the lead's checkout. Use the smallest swarm that provides useful isolation, independent evidence, or parallel progress. More workers help only when their outputs can be combined without competing ownership or unresolved dependencies.

| Strategy | Use when | Assignment and handoff |
| --- | --- | --- |
| Focused delegation | One bounded task needs an isolated environment or specialist attention | One worker owns the task; the lead verifies its output and obtains independent review before merging code. |
| Parallel implementation | Changes have independent file ownership and stable interfaces | One coder per change set; review branches separately, then verify the integrated result. |
| Research and synthesis | A decision needs evidence from distinct areas | Read-only workers investigate separate questions; the lead reconciles evidence into one recommendation. |
| Parallel diagnosis | A bug has several plausible causes | Workers investigate different hypotheses against the same baseline; select an evidenced cause before assigning a fix. |
| Dependency stages | Later work depends on an earlier interface or change | Finish and review each prerequisite, then dispatch downstream work from its exact approved commit. |
| Competing approaches | An expensive decision has genuinely different plausible solutions | Bound isolated experiments under common criteria; choose one approach and retain useful evidence from others. |
| Independent review | Existing code needs verification or adversarial scrutiny | Read-only reviewers inspect an exact base/head and complementary risks; findings return to an authorized owner. |
| Recovery and cleanup | Work is stalled, failed, cancelled, or awaiting destruction | Inspect current state, preserve evidence/source, resolve durability, and verify authorized cleanup. |

Read the selected recipe in [swarm strategies](references/strategies.md) before dispatch. Combine strategies when useful: parallel diagnosis can lead to focused implementation, followed by independent review. State why the strategy fits and change it when evidence invalidates its assumptions.

## Prepare the work

Before spawning:

1. Read repository instructions and the current [MCP API](../../../docs/MCP-API.md) and [worker protocol](../../../docs/WORKER-PROTOCOL.md). For other deployments, use their configured tool schemas.
2. Check `get_swarm_status` for capacity and `list_workers` for existing ownership and tasks. Aggregate counts are not a worker inventory; paginate scoped lists.
3. Identify dependencies, file ownership, base commits, and deliverables. Set a concurrency limit within both available capacity and the user's cap. Budget for review and recovery; do not occupy every slot with coders if that prevents review.
4. Define each work package's goal, boundary, acceptance criteria, verification, report, and stopping condition. For uncertain work, bound the experiment or investigation before adding workers.
5. Use one `team_id` for related work and distinct `task_id` values for independent packages. Stable `request_id` values make identical spawn retries idempotent.

Maintain a compact task map for work involving multiple workers:

| Task | Worker / role | Scope | Depends on | Base / head | Evidence / next action |
| --- | --- | --- | --- | --- | --- |
| Each work package | Actual ID and assignment | Owned files or question | Prerequisite task or none | Exact SHAs when relevant | Result, review, durability, cleanup state |

The task map can be kept in working notes; it is not a required new repository file. Use it to avoid duplicate dispatch, lost results, and merging an unreviewed head.

## Run, verify, and close

Read the relevant sections of [worker operations](references/operations.md) before the corresponding action:

- [Spawn workers](references/operations.md#spawn-workers-clearly): prompts, IDs, persistence workflow.
- [Monitor work](references/operations.md#monitor-asynchronous-work): lifecycle states, event cursors, stalls, follow-up semantics.
- [Validate output](references/operations.md#validate-worker-output) and [collect artifacts](references/operations.md#collect-artifacts): current run identity, evidence, bounded resource reads.
- [Review branches](references/operations.md#review-branches-independently) and [integrate/publish](references/operations.md#integrate-and-publish): exact commits, independent verdicts, integrated checks.
- [Cancel/destroy](references/operations.md#safe-cancellation-and-destruction): preservation, refusal handling, force restrictions, scoped pagination.

Use `wait_for_state_change` with waits of at most 25 seconds and carry forward `next_cursor`. Reread the worker after a relevant event and fetch the matching result. A timeout with `changed:false` is not failure; `completed` does not establish publication or destruction.

`send_worker_message` queues another turn in the same session. It does not interrupt an active turn. Check pending messages before resending; use explicit pause/cancel when the user's instruction requires stopping execution.

At completion, report the result, verification evidence, exact branches/commits when relevant, unresolved findings, and the disposition of every worker in scope. If cleanup or persistence remains unresolved, describe the retained state and needed action.
