# Correction companion to independent final architecture review (fresh)

- Worker: `w-cf8f53a8-390e-4f5b-90d9-4759b856a37f`
- Task: `final-architecture-review-fresh`
- Run: `ae0c7d5c-2248-45cf-b894-5e50bb8380f4`
- Preserved original report: `.swarmforge/artifacts/review.md` (unchanged)
- Reviewed source: `/workspace/phase2b2-ready` HEAD `157433166479c099a54cbee52ca9203dc722eb9f`,
  tree `bb2ff7fefd568ef07b93223fb42d375af1726b0c`, bundle SHA
  `424ca51ee631942cc25ad616eae0c939f4fbfb9659d35a9f88a66db08c7f93c0`

This companion records a correction to the original report. The original report is preserved
verbatim; nothing in it is rewritten. The overall verdict is unchanged.

## Retraction of finding L2

**Finding L2 in the original report is withdrawn as a defect allegation.** The comment in
`apps/cloud/test/enrollment.integration.ts:39` names exactly the four tables that are actually
asserted for the wrong-audience `401` path: `hosted_tasks`, `hosted_reservations`,
`hosted_outbox`, `hosted_operations`. The comment therefore matches its assertions; there is
no mismatched-comment defect.

The only residual item is an **optional test-coverage suggestion**: additionally asserting
that `hosted_allowances` is unchanged. That is optional and carries **no authority or
security defect**, because the wrong-audience `sfworker_` request is rejected `401` inside
`hostedAuth` (`apps/cloud/src/hosted-authority.ts:101`) before any statement executes, so the
allowance is provably untouched. No implementation change is required for this item.

## Status of finding L1

Finding L1 remains a **test-coverage observation only**, with no production defect. The `<=1 h`
launch-authority cap remains enforced in production at `src/hosted-runtime.ts:239` and in the
child at `src/hosted-child.ts:103`. The lead confirms the root test owner will restore the
bounded env-contract assertion without any production change. No production source change is
requested by this review.

## Unchanged verdict

- 1573 contribution: **APPROVED** within the bounded source-backed review.
- Overall Phase 2B.2: **INCOMPLETE**, pending the actual final combined source bundle after
  independent approvals (no overall acceptance certified here).
- No push/merge/deploy/VM deletion; assigned older `45c` source unchanged.
