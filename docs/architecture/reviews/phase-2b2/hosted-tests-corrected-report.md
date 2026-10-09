# Test report: hostile admission acceptance — CORRECTED RED checkpoint (canonical)

Prior approach (commit 7300825) REJECTED by lead: assertions pinned 404
envelopes as passing, i.e. green missing-route probes, and the load file
swallowed missing-table SQL errors with `catch => 0`. The original report is
preserved as `test-report-rejected-7300825.md` and the source commit is tagged
`rejected-7300825-green404` in-repo. This report supersedes it.

Branch `swarmforge/phase2b2-hosted-20261009/worker-client-storage/w-c32682ab-d72d-4b25-8179-0fef4e95eb4e`,
corrected commit `bbad371` on schema cherry-picks `c8a429e` (7fc) + `c6be5e0` (b61),
client base `09db215`/`32b230f`, original git-base `fec6697`. Tree clean.

## Scope kept
Same 3 owned files rewritten, no other files touched:
`apps/cloud/test/hosted-adversarial.integration.ts`,
`apps/cloud/test/hosted-e2e.integration.ts`,
`apps/cloud/test/hosted-load.integration.ts`.
No product/helper/router/schema/config edits. No unimplemented-source imports
(only `machine-helpers.ts`, frozen `hosted-types.ts` schemas, node builtins).

## Desired assertions (all FAIL today => legitimate RED)
Adversarial (9 tests: 8 fail, 1 passes as a true invariant):
1. valid policy + registered worker + browser POST => 202 + AdmissionReply +
   exactly one active reservation + one queued outbox. FAILS: actual 404.
2. same idempotency key + same body => identical 202/same task/one row each;
   same key + changed body => 409, no new rows. FAILS: actual 404.
3. one worker, six concurrent => EXACTLY one 202, five real quota 409s, one
   row each. FAILS: actual six 404s.
4. three workers, six concurrent, maxTasks=2 ceiling => EXACTLY two 202s,
   four 409s, two rows each. FAILS: actual six 404s.
5. absent/expired/revoked capability => 403 + error envelope each, zero rows.
   FAILS: actual 404s.
6. five malformed bodies (shell class, duration>runtime, runtime>1h, extra
   field, bad UUID) => 400 each, zero rows. FAILS: actual 404s.
7. no-auth / sfworker_ / sfcli_ on admission => 401 each, zero rows.
   FAILS: actual 404s.
8. cross-org session => 404 containment, zero rows. PASSES (true invariant
   that must hold before and after wiring).
9. browser session / sfcli_ on claim, session on renew+settle => 401 each.
   FAILS: actual 404s.
E2E (1 test, FAILS): tenant read 200 (wired, green step) then entitlement
view asserts 200 (actual 404) and admission asserts 202 + AdmissionReply
(actual 404).
Load (1 test, FAILS): 6-burst vs seeded 3-worker/2-task ceiling asserts
exactly two 202 + four 409 + two rows per table (actual six 404s). Row
counts are REAL count queries — a missing table FAILS, never reports zero.

## Exact RED failure counts (production DEFAULT Worker, real D1/workerd)
- adversarial: tests 9, pass 1 (cross-org containment), fail 8.
- e2e + load: tests 2, pass 0, fail 2.
- No failure is hidden: every mismatch reports actual vs expected status.
- Simulated GitHub identities only (synthetic users); no secrets, no raw
  credential argv, no workload execution, no remote deploy.

## Meter/allowance correction
Lead flagged the `compute_ms` allowance `'2'` vs 10s runtime mismatch. Fixed
by REMOVING allowance seeding from concurrency/load tests entirely: only the
technical entitlement ceiling governs until the backend defines the actual
meter-unit mapping contract. No meter-dependent test asserts until then.

## Verification (exact commands, apps/cloud)
- `node --experimental-strip-types --test test/hosted-adversarial.integration.ts`
  => 9 tests, 1 pass, 8 fail (desired RED).
- `node --experimental-strip-types --test test/hosted-e2e.integration.ts
  test/hosted-load.integration.ts` => 2 tests, 0 pass, 2 fail (desired RED).
- `bun run check` (apps/cloud) => clean, 38 files.
- Bun: PATH default on this VM; pinned 1.4.2 at /tmp/opencode/bun142
  (SWARMFORGE_TEST_BUN override). Node 24.21.

## Gaps / next (backend owner, then joint E2E)
- Backend must produce 202/409/403/400/401/envelope shapes above; tests must
  NOT be weakened to pass. Exact 403 error codes are asserted only as
  string-code envelopes (code names defined by backend later).
- Joint E2E bridge (Miniflare listener + real Bun Supervisor/Coordinator/
  Store/fixed child) lands after backend integrates, reading ready signatures.
- These tests MUST stay red until production passes; acceptance NOT certified.

