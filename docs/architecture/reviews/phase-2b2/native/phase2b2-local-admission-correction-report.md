# Local admission correction candidate

Exact candidate SHA: `8126b26fa87fb005afec4e4f2c5f1eda8862ae51`, parent `4fef2d646364ede2d2dd5ea1a181222fc900eb37`, branch `phase2b2-local-admission`, worktree `/tmp/swarmforge-phase2b2-admission`. This is an implementation report for independent review, not independent certification. Original candidate/report and independent RED evidence remain preserved.

## Corrections

- Grant issuance election checks current browser authority against the SQL statement clock, current installation authorization window against that clock, and positive proposed grant expiry. A request whose browser or installation expires while awaiting its batch cannot create a grant or authorization audit.
- The final fresh issuance lookup identifies this request's randomly generated grant ID and exact tenant/install/user/session/key tuple as the insertion witness. It returns the committed fresh result with 201 without repeating expiry checks after election. Racing losers and later replays use current SQL-clock browser and grant checks; revoked/rotated grants cannot replay. No credential scope changes.
- Status execution eligibility additionally requires the worker's original enroller to remain an active tenant owner/admin. A supervisor authorized by a different still-active admin remains eligible for cleanup when the worker enroller loses that authority.
- The explicit controlled allowance reserve helper now enforces current period containment at the SQL clock as well as matching the pinned period and entitlement. Stale supplied authority time cannot reopen an expired period. Settlement history behavior is unchanged.

Only six owned files were committed: `apps/cloud/src/hosted-authority.ts`, `hosted-entitlements.ts`, `hosted-status.ts`, and `apps/cloud/test/hosted-admission-regressions.test.ts`, `hosted-entitlements-safety.test.ts`, `hosted-status-regressions.test.ts`. Lead-owned `provider.ts`, `local-d1.ts`, and `local-fixture.ts` remain excluded. Shared machines and supervisors were not edited. The lead's admission meter comment correction was not included.

## RED to GREEN evidence

Before source correction, the three-file supplemental suite produced 34 pass / 5 fail, preserved in `/tmp/phase2b2-admission-correction-red.log`: expired explicit reserve changed one row; delayed browser issuance returned 201; stale-clock issuance replay returned 200; browser expiry after insertion incorrectly changed fresh issuance to 200; enroller downgrade still reported execution eligible. The separate proposed-expiry regression returned 401 after persisting the invalid grant instead of refusing election with 409; RED log `/tmp/phase2b2-admission-proposed-expiry-red.log`.

Fresh final command from the worktree root, Bun 1.4.2 (744846f84):

```
bun test apps/cloud/test/hosted-admission-regressions.test.ts apps/cloud/test/hosted-entitlements-safety.test.ts apps/cloud/test/hosted-status-regressions.test.ts
```

Result: **41 pass, 0 fail, 183 assertions**, `/tmp/phase2b2-admission-correction-green.log`. All original 34 tests remain. Added coverage includes actual expiry waits for both browser and installation, stale Worker-clock replay, in-batch post-election browser expiry, expired proposed credential, expired/future explicit allowance periods, separate worker/supervisor authorizers, and deterministic same-key miss/miss issuance race. The race returns one 201 and one identical 200 replay, exactly one grant and authorization audit; revoking the winner then gives 409 with no phantom grant/audit.

Independent reviewer's original production-SQL probes were also rerun against this corrected candidate without overwriting the original log:

```
bun /tmp/phase2b2-native-admission-probes.ts
```

Output `/tmp/phase2b2-native-admission-corrected-probes.log`: delayed expired-browser issuance 409 / zero grants; worker enroller loss execution false / cleanup true; expired explicit reserve zero changes / reserved zero. Probe budgets: metered admission 13 statements / 61 maximum bindings, cancellation 12 / 35, status 18 / 4. No scanned-row, CPU or edge budget claim follows from these counters.

From `apps/cloud`:

```
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/biome check src/hosted-authority.ts src/hosted-entitlements.ts src/hosted-status.ts test/hosted-admission-regressions.test.ts test/hosted-entitlements-safety.test.ts test/hosted-status-regressions.test.ts
```

Both exit 0; Biome checked six files with no changes. `git diff --check` and staged `git diff --cached --check` pass. Commit inspection confirms exactly the six owned files.

## Live D1 gap retained

The original real Node Miniflare/workerd D1 tests were retained and rerun from `apps/cloud`:

```
node --experimental-strip-types --test --test-isolation=none --test-reporter=tap test/hosted-authority.integration.ts test/hosted-entitlements.integration.ts test/hosted-admission.integration.ts test/hosted-status.integration.ts
```

Result: 33 fixtures fail during initialization with `listen EPERM: operation not permitted 127.0.0.1`, zero passed, zero skipped. Log `/tmp/phase2b2-admission-correction-live-d1.log`. These tests were not weakened, skipped, or claimed green. Supplemental tests execute production SQL with real Bun SQLite transactions and foreign keys through the lead-owned adapter; they are complementary evidence, not live D1/edge validation.

Independent dispatch original/correction review reports remain `/tmp/phase2b2-native-dispatch-review.md` and `/tmp/phase2b2-native-dispatch-review-corrected.md`; correction review covered exact dispatch SHA `93a96aa43e3874309d53436912a0ed728787b4aa`, including the actual 31,050 ms delayed-claim probe, separate from this authored admission candidate.

No deployment, publication, master merge, lockfile modification, integration or SwarmForge action was performed. Independent corrected-admission review is still required before integration.
