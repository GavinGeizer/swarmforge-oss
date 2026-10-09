# Independent review of admission/authority/entitlements/status

Reviewed exact candidate `4fef2d646364ede2d2dd5ea1a181222fc900eb37` in `/tmp/swarmforge-phase2b2-admission`. Source review and probes were read-only; the candidate HEAD and owned modules were unchanged through the final probe run. The pre-existing lead-owned provider modification and native test helpers remain outside this candidate. This review does **not** approve the original candidate: three concrete findings require correction or an explicit contract decision before integration.

## Findings

### P1: execution grant issuance still elects after the issuing browser session expires

Location: `apps/cloud/src/hosted-authority.ts:198` and the grant INSERT at line213.

`authorize()` captures `browserGuard(ctx,tenant,false)`, whose session predicate compares expiry only with its captured JavaScript timestamp. Unlike the updated shared grant predicate and admission browser guard, grant issuance does not add the database statement-time clock. The final SELECT repeats the same stale browser predicate; the final `hostedAuth` checks the new grant/installation, not the issuing browser session.

Reproduction uses the actual authorization route and native transactional SQLite, not a mocked guard: login and link a CLI installation, set that browser session to expire in50ms, hold the next `beforeBatch` for75ms, then issue an execution grant. The exact original candidate returns **201**, persists **one grant**, and the SQL clock in the output is28ms after the browser expiry. Reproduced twice. The new grant has its normal independent authority window even though the browser was no longer current when issuance elected.

Required behavior: fresh issuance must elect only while the browser session and installation/grant authorization windows are current on the actual SQL clock. Own elected issuance may then complete dependents atomically; exact-key replay must use current authority without returning a subsequently revoked/rotated grant. Do not turn expiry checks on dependent writes into partial transaction no-ops.

Evidence: `/tmp/phase2b2-native-admission-probes.ts`, probe `execution_grant_issued_after_browser_expiry`; output `/tmp/phase2b2-native-admission-probes.log`.

### P2: hosted status overstates supervisor execution eligibility after worker enroller loses admin authority

Location: `apps/cloud/src/hosted-status.ts:352` supervisor projection and execution_eligible at line417.

The status predicate checks the supervisor issuer's current admin chain, worker registered status/window, and policy. It omits the worker's original authorizing user's admin chain. Admission requires that chain, and corrected dispatch execution now requires it. The status can therefore claim `execution_eligible:true` when current execution must be denied.

Reproduction: A enrolls a worker; B becomes another current tenant admin and registers a supervisor through the actual registration route for A's worker. Downgrade A to member while B stays admin. Hosted status using B's current browser returns200 with `credential_authority:valid`, `cleanup_eligible:true`, and **execution_eligible:true**. Credential/cleanup authority remains valid, but execution eligibility must reflect A's lost worker authorization. The native probe seeds only the second membership and role downgrade through the DB seam; registration and status use real production routes.

Required behavior: include the worker original enroller active user/admin membership/active tenant chain in execution eligibility; retain cleanup eligibility through that execution-only worker loss. Existing test uses a single user for both chains, so it does not isolate this case.

Evidence: same probe file/log, probe `status_worker_enroller_loss`.

### P2/P3 helper contract: explicit admission reserve helper still mutates an expired allowance period

Location: `apps/cloud/src/hosted-entitlements.ts:373`, SQL at line381.

`allowanceReserveStatement()` validates that supplied period and measured boundaries are safe integers and internally contained, then binds exact period values and owning live policy. It never requires the allowance period to contain its authority timestamp or actual SQL clock. The strengthened legacy reserve alias does require that containment. The explicit helper therefore offers a weaker admission/reserve boundary than the legacy alias.

Reproduction under a current live controlled policy: set the supported allowance period to `[now-2000,now-1000]`, call the exported explicit reserve helper with that exact period and canonical expected/new quantities0->1000. It reports **changes1** and sets reserved1000 in the already expired period. No malformed input is required. The main admission route has its own stronger period guard and is not directly bypassed by this helper; this is the trusted exported reserve seam, not a claimed remote route exploit.

Required behavior if this exported helper remains admission/reserve-only: require the period to contain the supplied conservative authority time and actual SQL execution time, while keeping the separate trusted settlement helper available after commercial/period loss. Alternatively, explicitly narrow/remove the helper contract; do not silently leave a weaker substitute for downstream callers.

Evidence: same probe file/log, probe `explicit_reserve_past_period`.

## Supported observations

The candidate's admission task INSERT election rechecks current principal, newest all-three-capability policy, current worker/enroller authority, quota counts and exact current-policy allowance quantities. Full requested runtime is reserved; int64 arithmetic is bounded by canonical safe-integer quantity constraints. The fresh task UUID gates all dependent meter/reservation/outbox/operation/audit writes. Conditional no-op elections have no effects, and real SQL failures roll back. Cancellation uses a fresh own operation witness, exact reservation/ledger snapshot, full runtime quantity, assignment/fence and current principal; dependents are gated by that witness. The corrected cancellation response can report its committed election even if authority expires later in the batch.

Tenant and audience checks remain explicit: hosted CLI authentication accepts sfexec only with exact scopes and current installation/user/epoch/window; browser mutations require current tenant membership and CSRF. No new public write or entitlement bypass route appears. CLI task authority deliberately outlives the issuer browser after valid issuance.

Task cleanup pagination now advances a combined UUID-ordered task page; supervisor pagination has a separate signed purpose-bound cursor. Existing disjoint-ID regression traverses every task/supervisor without skips and rejects cross-purpose cursor reuse. Production dispatch action/resource conventions are used for observed activity. No unsupported rows-read/CPU measurements are claimed.

Independent native counters for metered current-policy admission: **13 statements /61 maximum args**; metered queued cancellation: **12 /35**; status: **18 /4**. These counts are below50 statements and100 bound arguments but do not establish edge CPU or D1 scanned-row fit. Probe `independent_admission_budget` records these values.

## Verification and limits

Fresh independent run:

`bun test apps/cloud/test/hosted-admission-regressions.test.ts apps/cloud/test/hosted-entitlements-safety.test.ts apps/cloud/test/hosted-status-regressions.test.ts`

Result **34 pass /0 fail**, 151 expect calls, complementary production-handler SQL integration using Bun SQLite with foreign keys/transactions. Log `/tmp/phase2b2-native-admission-review-tests.log`.

`bun /tmp/phase2b2-native-admission-probes.ts`

Result exit0 with the three undesired behaviors and budgets above; probes intentionally print observed actual outcomes rather than hide failures. Log `/tmp/phase2b2-native-admission-probes.log`.

All new review files live in `/tmp`; no candidate source/test/config/lock mutation was performed. Parent original report `/tmp/phase2b2-local-admission-report.md` remains unchanged. Existing real D1/workerd tests are retained but initialization is blocked here by localhost `listen EPERM`; the original candidate report records33 such failures. This independent review does not convert native SQLite evidence into real D1, live provider, edge CPU or scanned-row validation.
