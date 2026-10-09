# Phase 2b2 local admission correction report

- Review-ready commit: `4fef2d646364ede2d2dd5ea1a181222fc900eb37` on `phase2b2-local-admission`.
- Worktree: `/tmp/swarmforge-phase2b2-admission`.
- Parent restored draft: `9b4b88b`.
- Bun: 1.4.2 (744846f84); Node: v24.19.0.
- Commit includes only 4 owned production modules, 2 owned original integration tests, and 3 owned complementary regression test files. Shared `provider.ts`, `local-d1.ts`, and `local-fixture.ts` are deliberately unstaged/uncommitted and remain lead-owned.
- No deployment, publication, merge, integration, lockfile change, or SwarmForge use occurred. Independent review remains required.

## Corrections

Admission and cancellation effects depend on a fresh successful batch election. Policy, principal, statement-time expiry, worker current enroller/admin authority, exact current-policy allowance ownership/window, and exact expected quantities are checked at election. Later batch effects use the election witness rather than repeatedly requiring an authority window that could expire midway. Cancellation response selects the newly elected operation witness; replay requires live current authority. SQL failure returns 503 and rolls back every task/reservation/outbox/operation/audit/meter effect.

Meter reservation covers full requested runtime. Quantities remain canonical bounded strings; JavaScript uses exact BigInt. SQLite int64 arithmetic is checked at MAX_SAFE_INTEGER boundary, including refusal of insufficient headroom and `typeof(...)='integer'` evidence. A current zero allowance cannot borrow a historical positive allowance, and a current positive allowance cannot reserve an old row. Exact idempotent admission replay returns identical 202 without a new reservation; quota conflicts are 409 and missing required capability is 403.

The legacy reserve-only alias enforces the actual controlled triple, finite safe integer periods, period containment at actual SQL execution time, owning live policy, and exact quantity expectations. The former unused row validator is removed. Explicit reserve/settle helpers reject unsafe/infinite/fractional period or measuring times; settlement preserves its trusted cleanup semantics.

Policy puts retry bounded version and allowance uniqueness collisions using a fresh actual clock on each attempt, with 1 ms awaited delay. Failed batches restore policy revocation, insertion, allowances, and audit together. Tests verify coherent created/valid/period dates, retained old consumed/reserved quantities and history, and clean 409 after exhausted retries. No timestamp fabrication or historical quota deletion/reset is used.

Status task cleanup categories project one combined ordered task page. `cursor`/`next_cursor` purpose is `hosted-status-tasks`; `supervisor_cursor`/`next_supervisor_cursor` has independent `hosted-status-supervisors` purpose. Tests enumerate disjoint task/supervisor UUID ranges and reject cross-purpose cursor reuse. Status exposes current supervisor epoch/exact scope/audience/status/admin-chain authority, execution versus cleanup eligibility, and actual `dispatch.*` production audit events attributed by `task:<UUID>` and tenant-qualified task supervisor ownership. Dispatch owner confirmed `dispatch.settled` metadata outcome and task-resource convention. Invented query_cost row/CPU measurements are removed.

## Fresh verification

Run from worktree root:

```
bun test apps/cloud/test/hosted-admission-regressions.test.ts apps/cloud/test/hosted-entitlements-safety.test.ts apps/cloud/test/hosted-status-regressions.test.ts
```

Result: 34 pass, 0 fail, 151 expect() calls across 3 files. This is **complementary SQLite integration**, executing real production handlers/SQL with Bun SQLite, foreign keys and transactional batches plus test barriers. It is not Cloudflare workerd/D1 validation and invents no D1 scan/edge CPU metrics.

Run from `apps/cloud`:

```
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/biome check src/hosted-authority.ts src/hosted-admission.ts src/hosted-entitlements.ts src/hosted-status.ts test/hosted-admission.integration.ts test/hosted-status.integration.ts test/hosted-admission-regressions.test.ts test/hosted-entitlements-safety.test.ts test/hosted-status-regressions.test.ts scripts/hosted-policy-local.mjs
```

Result: TypeScript exits 0. Biome exits 0, checked 10 files, no fixes needed. `git diff --check` and staged diff check exit 0.

Original Node Miniflare/workerd D1 tests retained and run from `apps/cloud`:

```
node --experimental-strip-types --test test/hosted-authority.integration.ts test/hosted-entitlements.integration.ts test/hosted-admission.integration.ts test/hosted-status.integration.ts
node --experimental-strip-types --test --test-isolation=none --test-reporter=tap test/hosted-authority.integration.ts test/hosted-entitlements.integration.ts test/hosted-admission.integration.ts test/hosted-status.integration.ts
```

Result: runtime-blocked. Normal isolation reports 4 failing files. Expanded no-isolation TAP identifies all 33 tests blocked by `listen EPERM: operation not permitted 127.0.0.1`; 0 pass, 33 fail, 0 skipped. Logs: `/tmp/phase2b2-admission-live-d1.log`, `/tmp/phase2b2-admission-live-d1-expanded.log`. No fixture/test weakening, runtime substitute, config skip, or assertion bypass was applied. Live D1 remains **not green** and must run in a TCP-capable environment.

## Reproduced failures and mutation evidence

The resumed initial run was 24 pass/1 fail: enroller downgrade still allowed 202. Current code rejects that worker with 403 and elects no task.

New regression tests caught cancellation committed-result denial after election-time session expiry (403), legacy alias mutation of an expired SQL-time period (changes 1), and failed cancellation dependent SQL returning 409 rather than 503. Each was run failing before its correction and then passed.

Temporarily reverting allowance uniqueness recognition to entitlement-only recognition produced 2 expected failures in policy collision tests with the actual SQLite UNIQUE failure. The production source was restored in a finally block; final verification used the corrected source.

## Interfaces and integration gaps

- Keep shared exported `hostedSqlNow` and `hostedPrincipalGuard`. `hostedPrincipalGuard` accepts the four identity fields using Pick<HostedPrincipal>; SQL includes exact hosted CLI scopes without broadening credentials.
- Status schema replaces unsupported query_cost with next_supervisor_cursor and adds execution_eligible/cleanup_eligible per supervisor. UI/router consumers must use the two purpose-bound cursors independently.
- Original replay integration assertions now expect 202 consistently. Original status tests use actual production audit actions/task UUID resources and no fictional CPU claims.
- Shared local helpers/provider modifications are prerequisites owned by the lead and were intentionally excluded from this commit. Cherry-picking only this commit requires those lead changes already present.
- Original live D1 runtime behavior, scan cost/edge CPU budget, and full integration still require evidence in an environment permitting local TCP. No completion claim is made for those gaps.
