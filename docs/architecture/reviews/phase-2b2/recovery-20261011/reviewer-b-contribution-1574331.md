# Reviewer B — Contribution Review: `1830b06..157433166479c099a54cbee52ca9203dc722eb9f`

**Verdict for THIS contribution: APPROVED (correct, minimally-scoped correction).
Overall Phase 2B.2 remains INCOMPLETE — the final integrated commit still
follows. No overall phase approval is given here.**

This is a separate correction report. The original interim report
`review.md` is preserved unchanged (still INCOMPLETE/provisional). No prior
incomplete/filter-interrupted report is an approval.

## Provenance (verified, read-only, no source push)

- Rejected correction bundle `/tmp/phase2b2-cloud-rejected.bundle`: SHA256
  `c3c09906885ee253431ab266e1d30871ff2b0bec3358ef1b422b580771cbbde7`,
  size 3542 — MATCHES; fetched `refs/private/cloud-rejected` =
  `7e0cf1877d30b10b98a74901586f05f908be71da` (tree
  `51513da109d8aad3c201e0acaff63225923a8096`), requires `44156cc`. This is
  REJECTED and preserved only as history; it is NOT approved.
- Corrected contribution bundle `/tmp/phase2b2-diagnostic-reviewed.bundle`:
  SHA256 `1cb7fd9a47e1bdab6dd3dffbd4a320da91a11ac991648a28162c397c2c809ede`,
  size 3813 — MATCHES; fetched `refs/private/diagnostic-reviewed` =
  `157433166479c099a54cbee52ca9203dc722eb9f` (tree
  `bb2ff7fefd568ef07b93223fb42d375af1726b0c`), requires `1830b06` (verified as
  the merge-base). History: `1574331 (lead repair) -> 7e0cf18 (rejected
  correction) -> 1830b06`. Reviewed range `1830b06..1574331` changed exactly 3
  files (see below).
- Isolated clone `/workspace/phase2b2-review`; `git fsck --full` clean; no
  implementation edits, no merge, no push, no deploy. Original assigned branch
  `/workspace/repo` unchanged at `45c29d3`. Bun 1.4.2 frozen deps.

## Production change under review (path:line)

Range `1830b06..1574331`, production only `apps/cloud/src/hosted-admission.ts`
(two status-code lines; quota SQL unchanged):
- `apps/cloud/src/hosted-admission.ts:310-315` — advisory pre-check
  `remaining < runtime_ms` now throws **403** `allowance_exhausted` (was 409).
- `apps/cloud/src/hosted-admission.ts:635-639` — post-batch diagnostic now
  throws **`anyCovered ? 403 : 409`** with code
  `anyCovered ? "allowance_exhausted" : "allowance_unavailable"` (at 1830 both
  were 409; the rejected `7e0cf18` regressed unavailable to an unconditional
  403).
- Unchanged: `apps/cloud/src/hosted-admission.ts:305-309` advisory
  period-coverage still 409 `allowance_unavailable`; `:317-337` allowance guard
  SQL; `:341-455` single conditional admission batch. No other production file
  changed in the range.

## Independent regression reproduction (out-of-source harness)

Method: two throwaway `git worktree` checkouts OUTSIDE the source tree
(`/tmp/p2b2-rejected` @ `7e0cf18`, `/tmp/p2b2-reviewed` @ `1574331`), each
linked to the frozen `node_modules`, each running the corrected regression test
`apps/cloud/test/hosted-admission-regressions.test.ts` (the `beforeBatch`
ledger race scenario "allowance becoming unavailable at the batch boundary").
The harness sets `h.db.beforeBatch`, asserts the batch contains
`INSERT INTO hosted_tasks` (proving the atomic batch was entered), then mutates
the real ledger to make the allowance unavailable before the batch.

- REJECTED `7e0cf18`: `admission diagnoses an allowance becoming unavailable at
  the batch boundary` → **FAIL**: `Expected: 409 Received: 403`
  (`hosted-admission-regressions.test.ts:368`). The exhausted scenario passed.
  This independently reproduces the lead-detected regression: the unconditional
  403 also changed `allowance_unavailable`.
- REVIEWED `1574331`: both scenarios **pass** (403 exhausted / 409 unavailable).

## Test evidence at `1574331` (executed)

- `bun test test/hosted-admission-regressions.test.ts`:
  **26 pass / 0 fail / 132 expect() calls** (matches dispatch claim). Includes:
  - REAL `beforeBatch` race tests for both `exhausted` (403) and `unavailable`
    (409) that prove the batch was entered and assert **zero dependent writes**
    — `hosted_tasks`, `hosted_reservations`, `hosted_outbox`,
    `hosted_operations` each `count=0`, no `hosted.task_admitted` audit row, and
    the meter unchanged/expected (`reserved_quantity='0'`,
    `consumed='1000'|'0'`).
  - The former "both paths 403" test is correctly relabeled
    "advisory allowance exhaustion and retries return 403 without a second
    reservation" — it exercises the advisory path only, not the DB batch.
  - Canonical int64 test now asserts the error **code**
    `allowance_exhausted` alongside status 403 (`:455-459`).
- `node --experimental-strip-types --test test/hosted-admission.integration.ts`:
  **15 pass / 0 fail** (was 14/1 — F1 closed; the metering test now passes).
- `node --experimental-strip-types --test test/enrollment.integration.ts`:
  **4 pass / 0 fail** (was 3/1 — F2 closed). Wrong-audience worker credential
  against task admission with valid controlled JSON + Idempotency-Key is
  rejected **401** with zero task/reservation/outbox/operation rows preserved.
- Statics: root `biome check src tests scripts` → **133 files clean**; cloud
  `biome check src test scripts ...` → **70 files clean**; root and cloud
  `tsc --noEmit` clean (matches dispatch "root133/cloud70 statics pass").

## Invariants held (verified against corrected source/tests)

1. Exhausted allowance (window covered, insufficient headroom) → **403**
   `allowance_exhausted` on BOTH advisory and post-batch diagnostic paths.
2. Unavailable allowance (no covering window) → **409** `allowance_unavailable`
   on BOTH paths.
3. Other conflicts (quota/limit, idempotency conflict, worker busy, request-id
   reuse) remain 409 — unchanged code.
4. Atomic admission batch and quota/entitlement SQL unchanged; racing losers
   write nothing; no admitted capacity is created on a denied request.
5. Canonical int64 meter boundary still enforced (now with a code assertion).

## Severity adjudication

The original interim report preserved F1 at **High, provisional**. Adjudication
now: a **post-batch HTTP status mismatch that grants no admitted capacity and
leaves zero dependent writes is NOT a High security defect** — it is a contract/
diagnostic-correctness bug (403 vs 409 for clients). F1's original High
severity is retained in the preserved interim report as the historical finding;
this correction records the downgraded severity rationale. No weakened
assertions and no production auth/quota weakening were used to close F1 or F2.

## Statement

Contribution `1830b06..157433166479c099a54cbee52ca9203dc722eb9f`: **APPROVED**
— correct, minimal, invariants preserved, regression independently reproduced
and fixed. Do not merge if changes requested (none here). Overall Phase 2B.2
verdict remains **INCOMPLETE** pending the final integrated commit (new real
D1/Bun test + documentation); the final `review.md` must state
APPROVED / CHANGES_REQUESTED / INCOMPLETE with the exact reviewed SHA.
