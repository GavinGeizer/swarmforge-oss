# Phase 2B.2 engineering evidence and adjudication

This phase uses SwarmForge workers on the user's updated
`meta/muse-spark-1.3-contributor` configuration. Reports are evidence to verify against
source, exact commits and executable tests, not blanket certification. Original
artifacts/results remain in coordinator storage. No production/preview deployment or
master integration is authorized.

## Initial investigations

| Investigation | Worker | Evidence |
| --- | --- | --- |
| Atomic admission | w-452f4e44-e8fb-4036-a854-2e66b4ce3dd8 | [Original](design-admission-original.md); follow-up recommends separate hosted-cli grants |
| Lease/recovery | w-4e10d527-68dd-453b-9cac-6138049a538c | [Original](design-recovery-original.md); follow-up corrects cancelled/paused stop ambiguity |
| Secrets/client | w-1d33172c-4a19-4e2b-9622-e864a32cf178 | [Screened copy](design-isolation-screened.md); original research remains preserved |

All three inspected fec66971536cb117b36c85faabd98883d6491cb2 and changed no product
source. No tests or live authentication were performed by these investigators.
Their follow-ups completed with clean assigned branches and verified remote baseline
SHA. They may be reused as independent reviewers because they authored no product code.

## Investigation claims requiring adjudication

- Indexed reservation counting inside guarded D1 batches is selected over process
  counters or evaluate-then-insert admission. Transaction failure rolls back all
  dependent mutation/audit rows; a final SELECT is not itself a rollback trigger.
- The admission proposal's sample reservation schema has UNIQUE(task_id) while
  describing several reservation-kind rows per task. Implementation instead uses one
  reservation per task with explicit task/worker/runtime quantities. The proposal's
  loose digit GLOB does not validate canonical decimal quantities and is not adopted.
- The proposal claims D1 lacks partial unique indexes without executable evidence.
  This assertion is not accepted; actual D1 migration/constraint tests decide index
  support. Hosted policy explicitly includes hosted_task_execution as required by
  the user, even though the historical example omitted it.
- Coordinator cancellation can settle `cancelled` after quiesce returns `paused`.
  Therefore the adapter must independently prove runtime stop or provider-confirmed
  absence. Neither a cancellation label nor lease expiry permits resource release.
- Reviewer wording about rejecting lead-proposed worker credential reuse describes
  a hypothetical unsafe approach; the lead did not propose widening worker scopes.
  The selected protocol uses separate hosted-cli and supervisor audiences.
- The isolation report contained one query-value example that tripped the existing
  credential screen. The original was retained in the VM/coordinator evidence;
  retrieval used a copy with that query value redacted inside the worker. No screen
  was disabled and no live secret is claimed to have been discovered.

## Integration-base recovery

SwarmForge clones the repository's current default head, observed at 45c29d3 (v0.1.3
release), which is outside the Phase 2B.1 branch. Investigators correctly reset only
their isolated assigned checkouts to the requested fec6697, but the bootstrap
git-base marker still named the unrelated default head. The automatic handoff's
ancestry check refused publication. GitHub App token issuance succeeded; no provider
credential failure or source rewrite was involved.

The lead independently verified each clean assigned branch/HEAD, then aligned only
the worker's handoff metadata marker with the user-authorized Phase 2B.1 base.
Subsequent publication verified the exact baseline SHA. Coders receive the same
explicit base instruction; no newer master change is imported into this phase.

## Current task ownership

| Work package | Worker | Owned area |
| --- | --- | --- |
| Worker client/storage | w-c32682ab-d72d-4b25-8179-0fef4e95eb4e | Worker client, protected-file extraction and client tests |
| Hosted foundation | w-f1ddeedb-2c4a-4ccd-a81a-c04f9f147c3b | D1 schema/types, policies, execution grants, atomic admission and tests |
| Bun supervisor | w-bbff4817-e164-44c4-9875-c7d535a2354e | Hosted/supervisor clients, durable mapping, inert runtime/watchdog and tests |

Dispatch, independent hostile tests and final exact-commit reviews follow their
schema/code dependencies. This index will record actual accepted commits, review
findings, checks and every scoped worker's preserved/cleanup disposition.
