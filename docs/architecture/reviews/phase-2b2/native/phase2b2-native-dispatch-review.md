# Independent native dispatch review: original candidate

**CHANGES_REQUESTED** for dispatch candidate `5151dc599e16e9ee5176af48b27e7b5635c202ea`. This reviewer implemented the separate admission/status correction, not dispatch. Review was read-only against `/tmp/swarmforge-phase2b2-dispatch`; no dispatch source or tests were edited by this reviewer. The author subsequently began corrections; this original verdict/evidence is preserved rather than overwritten.

## High: current worker enroller authority loss still grants execution

`executionGuard` at `apps/cloud/src/hosted-dispatch.ts:290-305` checks worker ID, tenant, registered status and expiry, plus the supervisor's own authorizer. It omits the current admin chain of `cloud_workers.authorizing_user_id`. Existing worker identity semantics in `machines.ts:92-96` explicitly require the worker enroller to retain active owner/admin membership. When the supervisor issuer and worker enroller differ, loss of the enroller's privileged role is invisible to dispatch.

Concrete probe: A enrolls worker W; B is added as a current tenant admin and obtains a supervisor for W through the real production registration handler; claim and ACK the metered task; change A's membership role to member; renew through B's supervisor credential. Result: **HTTP 200, directive continue**, with new persisted operation/audit writes. The worker authorizer has lost authority while the task is permitted to keep executing. Membership setup/downgrade uses the database test seam; supervisor issuance, claim, ACK and renewal use real production handlers. This does not require forging a credential or mutating the supervisor tuple. Current worker authorization must be rechecked at the execution election and final continue read; trusted cleanup should remain usable.

Reproduction script: `/tmp/phase2b2-native-dispatch-probes.ts`; preserved original output: `/tmp/phase2b2-native-dispatch-original-probes.log`. Probe name `worker_enroller_loses_admin`.

## Medium: claim can elect an already-expired proposed lease

Claim at `hosted-dispatch.ts:456-462` computes the proposed expiry from an earlier JavaScript timestamp, but its election checks only task deadline/authority rather than proposed expiry > actual SQL time. A delayed claim whose task deadline is still future can persist a dead lease. The final authoritative read rejects it after the batch; rejection is not rollback.

Two independent concrete probes reproduced this. A simulated 31-second clock offset returned **409 authority_lost**, while task/outbox became claimed, attempts became 1, and a dispatch.claim operation persisted. A real **31,050 ms beforeBatch wait**, without clock mocking, returned **409 lease_expired** and persisted the same claimed task/outbox state with lease_expires_at already less than the final DB clock. `persistedChanged` was true. The response grants no live execution, so this is availability/stranded-capacity severity rather than an execution-authority escalation: an unstarted task becomes assigned and will quarantine its reserved capacity until trusted cleanup/recovery. Require a proposed-expiry predicate at election, not a later response check. The analogous renewal boundary should be tested too.

Preserved output probe `claim_real_31_second_batch_delay` in `/tmp/phase2b2-native-dispatch-original-probes.log` is real elapsed-time evidence against the original candidate loaded before subsequent author edits. The original reviewed source was saved at `/tmp/phase2b2-dispatch-reviewed-5151dc5.ts`.

## Medium integrity gap: settlement accepts reservation quantity/runtime drift

`settlementPlan` at `hosted-dispatch.ts:665-711` pins observed reservation and ledger quantities, but does not require reservation quantity == task.runtime_ms or reservation worker == task worker. Probe begins with correct task runtime10000, reservation quantity10000, allowance reserved10000; after claim/ACK, directly changes only the reservation quantity to1; settles current lease/fence with stop_confirmed true, outcome completed, consumed_runtime_ms0. Result: **HTTP 200**, task completed, reservation consumed quantity1, allowance reserved9999 / consumed0. The task is terminal, so leftover reserved capacity cannot be reconciled by its ordinary settlement path.

This reproduction requires a trusted database anomaly; no remote mutation route was established, and it is not presented as an unprivileged exploit. It is a gap in the full-runtime reservation invariant and should fail closed rather than hide inconsistent capacity. The author noted that old real-D1 helper defaults also created quantity1 for runtime10000; those fixtures need coherent quantities before invariant enforcement. Cleanup deserves the same task/reservation ownership/quantity checks. Probe `settlement_reservation_quantity_not_runtime` in the preserved original log.

## Other checks and practical limits

Fresh original-candidate `bun test apps/cloud/test/hosted-dispatch.test.ts` gave **25 pass, 0 fail**. I inspected fresh operation INSERT election and successor operation-ID gates, exact task witness predicates, newest all-capability policy/runtime guard, CLI grant installation/user/epoch/window pinning, account-session authority, lease/fence/resource-bound replay, trusted cleanup despite commercial/task-authorizer/worker loss, current privileged operator recovery, and bounded maintenance batching. The adversarial persisted-state tests cover same-key resource conflicts, settlement payload races, ledger CAS loss, tuple rebind, policy replacement, original lease/fence replay and revoked cleanup credentials.

Measured SQL limits from the production-handler SQLite suite: mixed identity+dispatch cleanup **33 statements / 46 maximum bindings**; operator recovery **14 / 61**; other response paths <=13 statements / <=63 bindings. These are actual statement/argument counters, not D1 scanned rows or edge CPU evidence. Edge scan/CPU limits remain unmeasured.

Original live D1 test command independently run:

```
cd /tmp/swarmforge-phase2b2-dispatch/apps/cloud
node --experimental-strip-types --test --test-isolation=none --test-reporter=tap test/hosted-dispatch.integration.ts
```

Result: **0 pass, 14 fail, 0 skipped**, every fixture initialization fails `listen EPERM: operation not permitted 127.0.0.1`. Output `/tmp/phase2b2-native-dispatch-live-d1.log`. The original actual Miniflare/workerd/D1 tests remain present; no skip/config weakening or SQLite-as-live-D1 claim was made. TypeScript completed successfully during review; the subsequent owned Biome command raced author's newly appended correction tests and reported those unformatted additions, so that run is not claimed as a clean check of the committed original snapshot. Author reports original committed checks clean. Correction candidate needs fresh verification and a separate review follow-up.

## Admission documentation observation, not independent certification

The lead supplied a valid documentation correction for my admission commit `4fef2d646364ede2d2dd5ea1a181222fc900eb37`: `hosted-admission.ts:54-55` says there is no stale-expected-value miss path and claims stronger semantics than read-then-CAS. Current code does pin expected allowance quantities at election and can return admission_conflict when quantities change between advisory read and batch. The comment should describe that actual conditional-CAS behavior and zero-effect losing election. I did not alter my committed implementation while performing this independent dispatch review and do not treat this report as certification of my own code.

## Required follow-up

Fix the current worker enroller chain and proposed lease expiry checks; enforce coherent reservation ownership/full runtime at settlement/cleanup and update legacy fixtures; rerun the complementary state probes and static checks. Preserve this original rejection and review the exact new SHA separately. Live D1 remains a separate runtime gate in a TCP-capable environment. No integration, deploy, publication, merge or SwarmForge use occurred in this review.

### Additional coherent real-time probe

To remove the old fixture's independent runtime/deadline mismatch from this finding, I repeated the real 31,050 ms delay with task runtime60000 and deadline-created60000, reservation quantity60000, and allowance reserved60000. A scratch copy of exact original5151 dispatch was loaded with only its relative dependency paths relocated to the same original dependencies; no candidate source was edited. Original again returned409 lease_expired and persisted claimed task/outbox with an expired lease. Evidence `/tmp/phase2b2-native-dispatch-coherent-original.log`; artifact `/tmp/phase2b2-dispatch-readonly-review/coherent-original-probe.ts`. This confirms the delay issue for the full-runtime admission shape.
