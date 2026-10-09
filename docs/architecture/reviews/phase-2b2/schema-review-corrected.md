# Schema re-review (corrected): `b61f244` vs `7fc8c53` — FOCUSED, READ-ONLY

Verdict: **APPROVED** for schema freeze. No unresolved critical/high. Dispatcher may proceed subject to the two
non-blocking notes in §4.

## Provenance (exact target archive + clean checkout head, recorded separately)

- Review checkout (own assigned branch, untouched): `/workspace/repo` HEAD `fec66971536cb117b36c85faabd98883d6491cb2`,
  branch `swarmforge/phase2b2-hosted-20261009/architecture-atomic-admission/w-452f4e44-e8fb-4036-a854-2e66b4ce3dd8`,
  `git status` clean before and after. No source edits; no lockfile changes; no commits.
- Exact target archive: commit `b61f2444a6b28667c69893501d8f51013f3ce8af`
  ("fix(cloud): correct Phase 2B.2 schema per independent review", parent `7fc8c53...`), on coder branch
  `origin/swarmforge/phase2b2-hosted-20261009/hosted-foundation/w-f1ddeedb-2c4a-4ccd-a81a-c04f9f147c3b`.
  Prior candidate `7fc8c53a3c5a21c3e96505e61723441f72e5d117` confirmed as its direct parent.
  Inspected read-only via `git show` + `git diff`; executed via an isolated scratch archive
  (`git archive b61f244 -- apps/cloud`, since removed) with a scratch-only `npm install` (sandbox Bun 1.3.14 cannot
  parse the pinned lockfileVersion-2 `bun.lock`; repo lockfiles untouched).
- Corrected files (diffstat `7fc8c53..b61f244`: 3 files, +668/−188):
  `apps/cloud/migrations/0003_hosted_execution.sql`, `apps/cloud/src/hosted-types.ts` (+45/−~20),
  `apps/cloud/test/hosted-schema.integration.ts` (505→876 lines, 3→5 tests).
- Frozen external DTO names unchanged: capabilities/scopes/table names/`taskSubmitSchema`/`hostedTaskSchema`/
  claim/lease/settlement shapes identical (verified in DTO test + `git diff hosted-types.ts`: only added
  `maxTaskRuntimeMs`/`maxMeterQuantity` constants, tightened bounds, added row-interface fields).
- Original report preserved: `/workspace/.swarmforge/artifacts/schema-review.md` (prior CHANGES_REQUESTED) untouched.
  This file is `schema-review-corrected.md`; `report.md` mirrors it.

## Executed evidence (all blocked cases reproduced against updated actual DDL on real workerd D1)

- Candidate suite on corrected tree: `node --experimental-strip-types --test test/hosted-schema.integration.ts` →
  **5 pass / 0 fail**: frozen DTOs; FK orphans direct+batch; quantity CHECKs on valid-parent rows; cross-org binding +
  worker exclusivity + rollback; clean install + 2B.1 upgrade.
- Independent blocked-case repro (scratch `blocked_repro.mjs`/`blocked2.mjs`, Miniflare `getD1Database` handle):
  - BLOCKED-1a/1b (was HIGH): `quantity '12x'` / `'1.5'` on valid task → **REJECTED [CHECK constraint failed]**.
  - BLOCKED-2a/2b (was MEDIUM): 20-digit, `9007199254740992` (> MAX_SAFE) → **REJECTED [CHECK constraint failed]**.
  - Exact-string storage (no CAST/rounding claim): `SELECT allowed_quantity, typeof(...), quote(...)` →
    `{"allowed_quantity":"9007199254740991","t":"text","q":"'9007199254740991'"}` — TEXT in, TEXT out, exact.
  - BLOCKED-3 (was MEDIUM): `max_task_runtime NULL` → **REJECTED [NOT NULL constraint failed]**; DDL
    `INTEGER NOT NULL CHECK(... BETWEEN 1 AND 3600000)`; Zod `min(1).max(3600000)` non-nullable; task `runtime_ms`
    same bound + `controlled_duration_ms <= runtime_ms`.
  - BLOCKED-4a (was MEDIUM): cross-tenant task (worker of orgB under orgA) → **REJECTED [FOREIGN KEY]** via composite
    `(organization_id, worker_id)` FK (candidate suite asserts the same; independent cross-org probe in prior review
    scope now covered by composite FK, not just app SQL).
  - BLOCKED-4b (was MEDIUM): duplicate active task same worker → **REJECTED [UNIQUE constraint failed]** via partial
    `UNIQUE ... WHERE state IN (queued,claimed,running,stop_requested,held)`; terminal settle releases slot
    (candidate test proves `completed` → new task succeeds).
  - Prior LOW-5: FK-orphan rejection asserted direct AND batch in the corrected suite (5/5 test file's FK test);
    matches D1 primary-source always-on enforcement. No weakened declaration-only test remains.

## §3 Conditional-DML enforceability check (no unnecessary design closure)

- Nullable `reservation.worker_id`: ACCEPTED by design (capacity-only hold before worker pinning is legitimate);
  exclusivity is enforced at the task layer (partial unique above) and capacity counts via
  `SELECT count(*) ... WHERE organization_id=? AND state IN ('active','quarantined')` (probe returned `{"n":1}` on the
  live handle). Do NOT force `worker_id NOT NULL` — that would close a valid pre-assignment hold state. Admission SQL
  must carry the org-match `EXISTS` guard when filling `worker_id`/`allowance_id` (composite FKs cover task/worker and
  grant/installation links; `reservation.allowance_id → hosted_allowances(allowance_id)` is a single-ID FK, so the
  org-match for the allowance leg stays a conditional-DML predicate — sufficient, no schema change demanded).
- Composite allowance links / capacity counts: properly enforceable in conditional DML as described; no further DDL
  required for freeze. Remaining settlement arithmetic stays string-exact (Zod + DDL lexical bound mirror each other;
  `9007199254740992` rejected at both layers).

## §4 Non-blocking notes (not freeze-gates)

1. `hosted_tasks.installation_id/execution_grant_id/authorizing_session_id` NULL-able tri-path (account-direct vs
   grant vs operator-seeded) is documented in the migration header; dispatcher admission SQL must assert exactly one
   valid path per `principal_kind` (conditional CHECK or batch predicate) — follow-up, not a DDL defect.
2. Quantity bound settles future arithmetic safety (≤ MAX_SAFE lexical, TEXT storage, no Number/CAST per header
   comment); dispatcher must keep the string-only rule (no new numeric parsing) — convention to preserve, already
   documented in DDL header + Zod refine.

## Sources

`git rev-parse/log/diff/show` for both commits (read-only); corrected SQL/types/tests via `git show b61f244:...`;
executed Miniflare suite (5/5) + independent workerd probes (CHECK/FK/UNIQUE/NOT NULL rejections, typeof/quote
exactness). Prior baseline context deliberately not re-read per dispatch (focused re-review).

