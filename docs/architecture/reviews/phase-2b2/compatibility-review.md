# Compatibility review: `7897898` vs `b61f244` — READ-ONLY, BOUNDED

Verdict: **APPROVED**. No blocker. 7a helper review explicitly out of scope (not duplicated).

## Provenance (exact SHA, branch, base; clean checkout; scratch candidate)

- Inspected candidate SHA: `78978988d461a12d43e0680f4b7052e5e7c3b477`
  ("fix(cloud): guard hosted session refs in expiry cleanup, default fixtures to all 3 migrations"),
  branch `swarmforge/phase2b2-hosted-20261009/cloud-migration-compatibility/w-6e744671-a513-4c66-af22-4b21c79a05e0`,
  parent = base `b61f2444a6b28667c69893501d8f51013f3ce8af` (my APPROVED-frozen schema). Direct child, verified.
- Review checkout: `/workspace/repo` HEAD `fec66971536cb117b36c85faabd98883d6491cb2` on assigned branch
  `swarmforge/phase2b2-hosted-20261009/architecture-atomic-admission/w-452f4e44-e8fb-4036-a854-2e66b4ce3dd8`,
  clean before and after. No product edits. Inspected via `git show/diff` (read-only) + executed via isolated
  scratch archive (`git archive 7897898 -- apps/cloud`, scratch-only npm install, removed after).
- Delta: 8 files, +376/−23. No DDL migration change (0003 untouched); all compatibility is code + fixtures + tests.

## All 8 files inspected

1. `src/abuse.ts` (+32/−~10): session DELETE gains two `NOT EXISTS` legs
   (`hosted_execution_grants.session_id`, `hosted_tasks.authorizing_session_id`); split into
   `legacySessionDelete` (phase2b1 shape) + `sessionDelete` (phase2b2) via `buildCleanupStatements`;
   `cleanupIdentity` probes `sqlite_master` for both hosted tables (`n===2` → new path, else legacy).
   `cleanupStatements()` (no-DB export) returns the new path. No `PRAGMA`/defer/`OR IGNORE` anywhere
   (candidate compat test asserts the absence by regex).
2. `test/migrations.ts` (new, 43 lines): `FixtureSchema = "phase2b1"|"phase2b2"`, `migrationFiles/Statements`,
   `applyMigrations(db, schema="phase2b2")` — reads the actual committed migration files, no fakes.
3. `test/machine-helpers.ts`: `fixture(origin, {schema})` defaults phase2b2 (all 3 migrations).
4. `test/hosted-cleanup-compatibility.integration.ts` (new, 283 lines, 2 tests): statement-shape test
   (both new legs present, all 3 legacy legs retained, no FK relaxation) + end-to-end regression (legacy batch
   fails FK + rolls back unrelated state; corrected cleanup preserves grant/task/sessions/audit, removes
   unrelated expired state; idempotent repeat; NaN boundary rejected).
5. `test/hosted-schema.integration.ts`: 4 tests pin `schema:"phase2b1"` then apply 0003 manually (explicit
   phase2b1→003 upgrade path preserved); DTO test uses default (phase2b2).
6. `test/auth.integration.ts`, `test/runtime.integration.ts`: inline 0001+0002 SQL extended with 0003
   (all-3-fixture default — consistent with new helper).
7. `test/local-setup.integration.ts`: cf migrate assert updated 0002→0003 on first apply, `[]` on repeat.
8. (7a `scripts/hosted-policy-local.mjs` untouched here — later separate review, not duplicated per dispatch.)

## FK cleanup + fixtures vs phase2b1-schema2 + schema3

- Old expired sessions referenced by hosted grants/tasks: the bug is real and the fix is correct. 0003 adds
  `hosted_execution_grants.session_id → sessions` and `hosted_tasks.authorizing_session_id → sessions` FKs;
  the pre-fix DELETE would hit `SQLITE_CONSTRAINT_FOREIGNKEY` and roll back the whole batch (D1 batch atomicity),
  preserving unrelated expired state. New legs exclude exactly those sessions; all other expiry behavior unchanged.
- `sqlite_master` legacy check is safe: read-only `SELECT count(*)`, no error swallowing (a probe failure throws,
  failing closed); single worker build serves both generations. `cleanupStatements()` export keeps the new-path
  default for callers without a DB handle.
- Fixture default change (0001-0003) is coherent: every previously-0001+0002 inline site now applies all 3;
  the 4 hosted-schema tests that need the upgrade path say so explicitly. `test/migrations.ts` reuses committed
  files (no drift between fixture DDL and cf migrations).

## Executed (meaningful targeted D1/workerd; pinned Bun present; no full reruns)

- Pinned Bun 1.4.2 available (`~/.bun/bin/bun --version → 1.4.2`); repo script is
  `node --experimental-strip-types --test` (bun test does not match `*.integration.ts` names), so execution used
  the pinned runner (Node 24 + Miniflare alpha/workerd D1) — the meaningful targeted set, not full suites:
  - `hosted-cleanup-compatibility` 2/2 pass; `hosted-schema` 5/5 pass (7 total, one command).
  - `auth` + `abuse` 19/19 pass (regression: fixture default change breaks nothing in identity/cleanup paths).
  - Extra probe (not in candidate): phase2b1-only DB (0001+0002) + `cleanupIdentity` → legacy path completes,
    expired session + rate row removed (`true | true`). Proves the `sqlite_master` branch serves old DBs.
- `local-setup` cf test not executed here (spawns real `cf` local migrate; covered by author's full-cloud 59/59
  claim — cited, not re-verified; the assertion change 0002→0003 matches the 8-file delta honestly).
- Author "full cloud 59/59" noted as author evidence, not mine; my executed total: 28 pass / 0 fail across the
  three targeted commands above.

## Severity: no CHANGES_REQUESTED

No HIGH/MEDIUM/LOW blocker demonstrated. Notes (non-blocking): `cleanupStatements()` without DB always returns the
new path (fine — callers with pre-0003 DBs use `cleanupIdentity`, which probes); the legacy statement copy in the
compat test is intentionally stale-on-purpose (documented as regression oracle — correct practice, not drift).

## Sources

`git rev-parse/log/show/diff` for 7897898/b61f244 (read-only); executed targeted suites + phase2b1 probe above.
Originals (`research.md`, `schema-review.md`, `schema-review-corrected.md`, `foundation-architecture-review.md`,
`hosted-adversarial-tests-review.md`, `operator-helper-trace.md`) unchanged. Scratch removed; assigned branch clean.

