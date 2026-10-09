# Operational helper review: `7a17205` vs `2d602ca` — READ-ONLY, BOUNDED

Verdict: **CHANGES_REQUESTED** (1 MEDIUM: retained alias misstates its own checks; 1 LOW: Infinity-period
acceptance). The operator-helper state fix itself is VERIFIED WORKING (was the prior BLOCKER — now resolved).
No data-plane HIGH demonstrated; do not block foundation on unsettled downstream admission (no shared-guard
unsafety found).

## Provenance (exact SHA, detached scratch, clean branch)

- Target: `7a1720578f1dfd6596ad566c3f6f2b011f62ded4` ("fix(cloud): operational operator helper and scoped
  allowance settlement", parent `2d602ca...`), branch
  `origin/swarmforge/phase2b2-hosted-20261009/hosted-foundation/w-f1ddeedb-2c4a-4ccd-a81a-c04f9f147c3b`.
  3-file delta, +401/−86: `scripts/hosted-policy-local.mjs`, `src/hosted-entitlements.ts`,
  `test/hosted-entitlements.integration.ts`.
- Checkout: `/workspace/repo` HEAD `fec6697` on assigned branch, clean before and after. Inspected via
  `git show/diff` + executed in detached scratch archives (removed). No product edits, no deployments.
  Prior originals (`research.md`, `schema-review*.md`, `foundation-architecture-review.md`,
  `hosted-adversarial-tests-review.md`, `operator-helper-trace.md`, `compatibility-review.md`) unchanged.

## 1. Operator helper: prior BLOCKER RESOLVED — put v1 / repeat put v2 / revoke 1 / repeat revoke 0 VERIFIED

Actual configured cf local state (commands bounded with `timeout 240/280`, outputs preserved):
- `node scripts/migrate-local.mjs` → all 3 migrations ✅; single sqlite
  `.wrangler/state/v3/d1/miniflare-D1DatabaseObject/d3a30...sqlite` (inode 796082 throughout).
- Valid existing rows seeded into that SAME file (users/orgs/memberships via sqlite3).
- `hosted-policy-local.mjs put` → `{"version":1,...}`; repeat `migrate-local` → `[]` (journal, no reapply);
  repeat `put` → `{"version":2,...}`; `revoke` → `{"revoked":1}`; repeat `revoke` → `{"revoked":0}`.
  Versions in-file `[(1,True),(2,True)]`, allowances 2, policy-audits 3 — same inode file, not refusal gates.
- Why it works now: script invokes the cf driver first (owns history incl. 0002 ALTER — no hand-rolled DDL loop,
  so the `duplicate column: return_path` failure mode is gone), binds `d1Databases: { DB: { id: localDatabaseId } }`
  (real UUID, no `void`), shared storage `resourcePersistencePath: resolve(".wrangler/state/v3")` +
  `unsafeEnableSharedStorage` + isolated scratch + dev registry — opens the exact cf-migrated UUID storage.
  Fail-fast guards retained (missing tables → refuse; unknown operator → refuse; remote flags refused).

## 2. Reserve/settle split: predicates VERIFIED on real D1

- `allowanceReserveStatement`: tenant+allowance+entitlement+resource/unit/class+period_start/end+expected strings
  + live-window `EXISTS (unrevoked, valid_from<=now<valid_until)`. `allowanceSettleStatement`: same minus the
  commercial window (keeps org/triple/period/quantity), so stop evidence lands after expiry.
- Executed (`settle_probe.mjs`, workerd D1): reserve after expiry → 0 rows; settle after expiry → 1 row;
  cross-tenant settle → 0 rows; wrong-triple settle → throws `unsupported meter` (validator, before SQL).
  Candidate suite adds `trusted settlement lands after policy expiry; reserve-only does not` — passes (9/9
  entitlements file). Classification from my prior trace is satisfied: reserve-only vs trusted-settlement
  explicit; dispatch owns guarded cleanup; exec client cannot select mode (helpers are callee-side exports).
- Finite-period validation is comparisons-only (`periodEnd > periodStart`, containment `start>=ps && end<=pe &&
  end>start`): probed `NaN` → throws (`NaN` comparisons false → "not a finite window"); `Infinity` periodEnd →
  ACCEPTED (`1 < Infinity`, containment holds) — grade LOW: no executable defect demonstrated (Infinity window is a
  policy-input anomaly caught upstream by `valid_for_ms <= 365d` Zod bound on the write path; the CAS helper takes
  numbers from the stored row, and no overflow/incorrect-write was produced). Not inventing a security defect.

## 3. MEDIUM: retained `allowanceCasStatement` alias comment is FALSE — `void rowValidator` never applied

- Actual alias body: declares `rowValidator` (triple + finite-window checks) then `void rowValidator;` — dead
  code. The emitted SQL is the OLD shape: org+allowance+entitlement+expected strings+live window, with NO
  `resource=?/unit=?/resource_class=?/period_start=?/period_end=?` predicates (verified: `triple predicate:
  false | period predicate: false | void rowValidator: true`). The comment ("alias enforces the same
  ownership/triple/period checks as the reserve-only helper... without widening into settlement bypass") misstates
  actual semantics: the alias enforces strictly FEWER checks than `allowanceReserveStatement`.
- Impact: any future caller using the alias believing in triple/period binding gets none at SQL level (relies
  solely on exact allowance_id + live window). No current caller within the delta's tests uses the alias for new
  paths (tests migrated to the explicit helpers), so no live exploit — MEDIUM, fix by either wiring the validator's
  values into the SQL (add the predicates) or correcting the comment + deprecating the alias. Must fix before
  admission (shared-guard adjacent: a downstream owner could reasonably trust the comment).

## Executed summary

- Candidate suites in 7a scratch: entitlements 9/9, authority 6/6 + schema 5/5 (11/11 second command) — all pass.
- Live helper sequence above (put v1/v2, revoke 1/0, repeat migrations `[]`, same-inode verification).
- Probes: alias predicate absence; NaN-throws/Infinity-accepted; reserve-0/settle-1/cross-tenant-0/wrong-triple-throws.
- Each subprocess bounded (`timeout 240/280/120`); no hangs encountered (prior 300s quiesce was the replaced
  reviewer, not this run).

## Sources

`git show/diff` for 7a17205 vs 2d602ca; live outputs quoted above; candidate test file for suite claims.

