# Local hosted dispatch correction report

Review-ready candidate: `5151dc599e16e9ee5176af48b27e7b5635c202ea` on `phase2b2-local-dispatch` in `/tmp/swarmforge-phase2b2-dispatch`, based on restoration commit `379935d`. No integration or external publication performed. Independent review is required before acceptance.

Committed ownership is exactly `apps/cloud/src/hosted-dispatch.ts`, `apps/cloud/test/hosted-dispatch-helpers.ts`, `apps/cloud/test/hosted-dispatch.integration.ts`, and new `apps/cloud/test/hosted-dispatch.test.ts`. The copied authority, entitlement, provider, native SQLite adapter and fixture dependencies remain outside this commit and unchanged by this agent. Schema, types, routing index, abuse, root application, locks and configuration remain outside this change.

## Corrected invariants

A fresh operation INSERT is the sole in-batch election. It pins current task state, reservation/ledger expectations, trusted principal tuple, required policy and task authorizer, lease/fence and request fingerprint. Every dependent task/reservation/ledger/outbox/audit write requires the request's own generated operation ID. A valid zero-row CAS causes no effects, and post-batch rejection is not claimed as rollback. The retained old native counterexample `/tmp/phase2b2-dispatch-red.log` shows HTTP 200/completed with ledger 9000/0; the corrected native production-handler regression reports 409 with all persisted dispatch rows unchanged after the intervening ledger edit.

Claim increments ownership fence; same-owner renewal preserves it and bounds expiry to the absolute deadline. Statement-time SQL clock guards execution election expiry. Newest policy is checked for all three capabilities at claim/ACK/renew. Account execution uses its live recorded authorizing session. CLI execution uses the shared grant predicate, installation/user/epoch/current authorization window, independently of issuer browser lifetime. Revoked/expired supervisor credentials are rejected; valid current cleanup authority survives worker/commercial/task-authorizer loss while retaining assignment/lease/fence identity. Operator recovery requires privileged current browser authority, CSRF, strict explicit stop assertion/evidence, tenant/key/current lease/fence; it settles held/stop-requested revoked/expired assignment without requeueing or granting execution authority. The assertion is audited as independently verified OS process/watchdog evidence, never inferred from a network failure.

Claim/ACK/renew/status `server_time` is projected from the shared database SQL clock in the final read, after mutations. Empty claim and stop fallback use a bounded final DB read. A five-second Worker clock skew test failed before this correction and passes afterwards. Status final execution read also pins the current task witness and checks SQL lease/deadline expiry.

Typed idempotency tests cover terminal old claim keys, exact original lease/fence replay, same-key claim competition, cross-resource ACK/renew conflicts including delayed requests that lose a key to a later task, conflicting concurrent settlement payloads, and same-key recovery/lost settlement retries. Full persisted task/reservation/outbox/ledger/operation/audit state is checked around the adversarial elections.

## Verification

Commands ran in `/tmp/swarmforge-phase2b2-dispatch/apps/cloud` unless stated otherwise:

- `bun test test/*.test.ts`: 25 pass, 0 fail, one complementary real-SQLite file. Final log `/tmp/phase2b2-dispatch-bun-all.log`; targeted final log `/tmp/phase2b2-dispatch-final-tests.log`.
- `./node_modules/.bin/tsc --noEmit`: exit 0, log `/tmp/phase2b2-dispatch-tsc.log`.
- `./node_modules/.bin/biome check src/hosted-dispatch.ts test/hosted-dispatch.test.ts test/hosted-dispatch.integration.ts test/hosted-dispatch-helpers.ts`: exit 0, 4 files clean, log `/tmp/phase2b2-dispatch-biome.log`.
- `git diff --check` and staged `git diff --cached --check`: exit 0 before commit.
- `node --experimental-strip-types --test --test-reporter=spec --test-name-pattern='dispatch real D1' test/hosted-dispatch.integration.ts`: test-file initialization failed, exit 1; log `/tmp/phase2b2-dispatch-real-d1.log`.
- `node --experimental-strip-types test/hosted-dispatch.integration.ts`: 14 real D1 tests failed during fixture initialization with `listen EPERM: operation not permitted 127.0.0.1`; log `/tmp/phase2b2-dispatch-real-d1-direct.log` contains every test name and error. No skips, removals, fallback substitutions or changed live configuration.

Additional new red evidence: `/tmp/phase2b2-dispatch-clock-red.log` reproduces Worker clock leakage; `/tmp/phase2b2-dispatch-worker-tuple-red.log` reproduces advancing a supervisor assignment whose task names another worker. Both have passing production fixes in the 25-test suite.

The retained new real D1 regression executes the production handler over actual Miniflare/workerd D1, with one committed SQL ledger edit immediately before its real batch, then compares all task/reservation/outbox/allowance/operation/audit rows. It is present and type checked, but cannot reach execution in this sandbox because listener creation is denied.

## Budgets and export contract

`dispatchCleanupLimit=2` holds at most two assigned tasks and releases at most two queued tasks per call. Two scans + two held 4-statement batches + two metered queued 6-statement batches = `dispatchCleanupMaxStatements=22`. Combined with identity cleanup including its compatibility probe and optional audit deletion: measured 33 statements, maximum 46 bound parameters. Three held and three queued candidates prove excess work stays pending; quarantine retains capacity and queued release settles its metered ledger atomically. Cleanup ledger CAS injection gives zero persistent effects.

Measured response path counts include authentication, election, post-election reads, SQL clock projection/fallback, audit and replay: claim 13 / 59 maximum bindings; claim replay 5 / 46; empty claim 7 / 30; ACK 12 / 63; ACK replay 5 / 46; renewal 12 / 63; renewal replay 5 / 46; status 4 / 46; stop status 4 / 1; metered settlement 13 / 57; settlement replay 3 / 4; operator recovery 14 / 61. Every measured path is below 50 statements and 100 bindings. These SQLite counters measure SQL statement executions and argument counts, not edge CPU or D1 scanned rows.

Exports retained/provided: `dispatchLeaseTtl`, `dispatchOperationTtl`, `dispatchCleanupLimit`, `dispatchCleanupMaxStatements`, `DispatchTaskRow`, `taskAuthorizerGuard`, `hostedRecoveryRequestSchema`, `hostedRecoveryRoute`, `cleanupHosted`, `hostedDispatchRoute`. Shared imports are `hostedPrincipalGuard` and `hostedSqlNow` from the admission-owned authority module. Event actions remain `dispatch.claimed`, `dispatch.acked`, `dispatch.renewed`, `dispatch.settled`, `dispatch.expired`, `dispatch.operator_recovered`; resources remain `task:${task UUID}`, settlement/recovery metadata retain `outcome` (including `failed`).

## Remaining execution/integration gaps

No corrected real D1/edge run, live provider proof, edge CPU or D1 scanned-row measurement is claimed. Lead must integrate approved shared dependencies and production recovery/dispatch routing plus combined scheduled wiring after independent review. Root runtime must retain the full RTT + margin subtraction from database server_time. No deployment, master merge, SwarmForge action, or lockfile change was performed.
