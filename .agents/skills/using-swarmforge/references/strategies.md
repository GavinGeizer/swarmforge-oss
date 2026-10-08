# Swarm strategies

Choose by task dependencies and the evidence needed. Worker counts below describe assignments, not permission to exceed a user cap. The lead can coordinate outside the worker pool. Every strategy uses the shared [worker operations](operations.md) for dispatch, monitoring, validation, and cleanup.

## Focused delegation

**Use when:** A bounded task benefits from an isolated VM, specialist attention, or a persistent environment. Keep simple local work with the lead when delegation overhead adds no value.

**Arrange:** One worker owns the task. For code that will be merged, a separate reviewer follows implementation; these workers need not run concurrently.

**Execute:** Give the worker an exact baseline, owned files, acceptance cases, and report requirements. Reuse its settled session for authorized corrections to the same task. Check each new run and head, and independently review the final commit before integration.

**Finish or switch:** Stop when the deliverable is verified and preservation/cleanup is resolved. Split into parallel implementation only after discovering independent change sets. A stalled run needs state inspection before replacement.

**Example:** One coder adds a lifecycle API operation and its behavioral tests; a reviewer checks the resulting branch and failure paths.

## Parallel implementation

**Use when:** Several change sets can proceed against agreed interfaces without simultaneous edits to the same files.

**Arrange:** One coder per owned area on separate branches from a named baseline. Use separate read-only review assignments and one integration owner. Schedule in bounded waves when capacity cannot support all assignments.

**Execute:** Define shared contracts before dispatch. Record exclusions in each prompt, including shared configuration or coordinator files owned elsewhere. Workers report dependencies rather than editing another owner's area. Review each exact head, integrate approved commits in an isolated checkout, and run checks on the combined result.

**Finish or switch:** Serialize work if ownership overlaps, interfaces change, or a prerequisite blocks progress. Do not let every coder independently repair the same shared file. Stop adding coders when integration or review becomes the bottleneck.

**Example:** Separate workers change artifact retrieval and status reporting against an agreed result schema; one owner handles any shared schema change first.

## Research and synthesis

**Use when:** A decision needs evidence from distinct subsystems, sources, or perspectives and a code change is not yet justified.

**Arrange:** Read-only investigators own different questions. The lead synthesizes their reports; workers do not patch or publish. Express these restrictions in prompts even if the configured tool accepts a matching role label.

**Execute:** Give each investigator the same decision question and relevant baseline. Request source locations, observations, uncertainty, and a bounded recommendation. Collect substantial reports as artifacts before destruction. Resolve contradictions against primary evidence; agreement alone is not proof.

**Finish or switch:** Stop when the decision has sufficient evidence or a named uncertainty needs user input. If implementation follows, create a bounded work package using the selected findings rather than treating a research recommendation as implementation authorization.

**Example:** Investigators examine provider retry behavior, scheduler transitions, and OpenCode session semantics to inform a lifecycle design.

## Parallel diagnosis

**Use when:** A reproduced failure has multiple plausible causes that can be investigated independently.

**Arrange:** Investigators each own a hypothesis against the same failing baseline and reproduction. Keep the source read-only; allow isolated diagnostic experiments and require workers to disclose any temporary changes.

**Execute:** Request a reproduction, evidence supporting or rejecting the hypothesis, relevant file/line locations, and the next discriminating experiment. Share confirmed findings through the lead. Distinguish multiple real causes from contradictory interpretations before assigning one owner to the fix.

**Finish or switch:** Stop redundant investigation when a cause is demonstrated and other findings no longer affect the fix. If diagnosis remains uncertain, narrow the next experiment rather than asking every worker to implement speculative repairs. Move the evidenced fix to focused delegation or independent implementation packages.

**Example:** For a worker stuck in `waiting`, separate investigations examine token progress, pending control intent, and provider responses against the same run evidence.

## Dependency stages

**Use when:** Later changes require an earlier interface, migration, or shared coordinator change. Parallel dispatch would create speculative work or overlapping edits.

**Arrange:** One owner for each dependency stage. Independent work within a stage may run concurrently once its prerequisites are available.

**Execute:** Write the dependency order and acceptance gate for each stage. Finish the prerequisite, verify remote durability, and obtain independent review. Give the next worker the exact approved prerequisite SHA and explicit instructions to base its work on it. A downstream branch must be reviewed against that base, and final integration must include its prerequisites. Approval of a commit does not itself authorize merging it to the destination branch.

**Finish or switch:** Rebase or revise downstream work if a prerequisite changes; obtain review of changed commits. Pause blocked tasks instead of filling the pool with workers waiting for inputs.

**Example:** Review a result-schema change first, then dispatch independent producer and consumer updates from its approved SHA.

## Competing approaches

**Use when:** There are genuinely different plausible solutions and comparing them could avoid an expensive architectural mistake. Prefer a single investigation when the options can be evaluated without implementation.

**Arrange:** A small number of isolated experiments, each owning a separate branch or artifact space. Establish common inputs, correctness criteria, measurements, and time/token limits before dispatch.

**Execute:** Ask for the smallest experiment that answers the decision, not multiple complete features. Compare measured behavior, complexity, operational constraints, and residual risks. Retain the evidence for the decision. If a prototype is selected for production, assign an owner to complete it and obtain independent review of the resulting exact commit.

**Finish or switch:** Stop at the agreed evidence boundary. Select one approach or report why none meets the criteria. Preserve required artifacts and verify any authorized disposal of alternatives; do not combine incompatible prototypes or assume experimentation authorizes shipping them.

**Example:** Compare two bounded designs for lifecycle event buffering using the same replay workload and restart requirements.

## Independent review

**Use when:** An implementation branch is ready for merge, or the user requests an audit of existing work. This can follow any implementation strategy.

**Arrange:** Reviewer assignments are read-only and independent of the author. One reviewer may be sufficient; use complementary reviewers when separate risks justify them, within the permitted roles and capacity.

**Execute:** Supply the exact base/head, intended behavior, acceptance criteria, and prior findings. Review scopes may focus on correctness, recovery/security, or tests, but collectively must cover the branch to be merged. Require a verdict, evidence, tests run, and residual risk. Verify the inspected SHA and clean review checkout. The lead resolves conflicting verdicts from evidence; do not use majority voting to dismiss a demonstrated defect.

**Finish or switch:** A substantive `CHANGES_REQUESTED` finding blocks integration until corrected and reviewed. Route fixes to an authorized coder. If the user says no more coders, report the blocked branch and continue only permitted review, recovery, integration of approved work, or cleanup.

**Example:** One reviewer checks lifecycle correctness and another checks credential boundaries on the same exact commit.

## Recovery and cleanup

**Use when:** Existing workers are stalled, failed, cancelled, in `recovery_required`, or retained after completed work. Inspect them before creating replacements.

**Arrange:** The lead inventories the requested scope with paginated worker lists. Prefer inspection and recovery in the existing environment when supported; cancellation makes a worker unavailable for further prompts. Recovery does not imply permission for new coders.

**Execute:** Match current state, pending messages/control, latest run, logs, VM Git state, and remote persistence. Collect needed artifacts. Allow an authorized active retry to proceed, or use explicit pause/cancel when directed. Recover needed commits through the supported workflow, verify durability, then request normal destruction when authorized. Follow the detailed force restrictions in [safe cancellation and destruction](operations.md#safe-cancellation-and-destruction).

**Finish or switch:** Verify each intended worker is destroyed and inspect aggregate capacity. A refused destruction is a preservation problem to resolve, not a reason to bypass checks. If work must be retained, report its exact state and unresolved requirement. Replace a worker only after checking old work and preventing concurrent ownership.

**Example:** Recover a failed coder's committed branch, verify its remote SHA, collect its report, and clean up the VM before assigning further authorized work.

## Capacity and strategy changes

- Count live retained VMs and existing assignments as well as active turns. A completed worker can still occupy capacity; use actual swarm status instead of assuming a slot was released.
- Under a one-worker cap, implementation and independent review can be sequential: preserve source and artifacts, destroy the author when authorized, then create a separate reviewer. The same author session is not an independent reviewer.
- Reuse a session for follow-ups within its ownership scope. Start a separate assignment when independence or a different owner matters; do not queue unrelated tasks behind an active turn.
- Run a new wave when verified prerequisites and capacity are ready, rather than dispatching all tasks at once. Agree time/token limits when cost is material; inspect reported usage and bound retries by the task's stopping condition.
- When the plan changes, update ownership, dependency SHAs, and expected evidence before dispatch. Respect earlier stop instructions and role restrictions throughout.
