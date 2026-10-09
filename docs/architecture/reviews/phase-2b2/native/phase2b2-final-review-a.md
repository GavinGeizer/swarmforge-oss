# Independent final integrated review A

Candidate: `f1d0526c5f60261f77e8a0c636f8474a5309826d`, `/tmp/swarmforge-phase2b2-integration`.
Original baseline: `fec66971536cb117b36c85faabd98883d6491cb2`.
Reviewer A did not implement or modify candidate production, tests, configuration, dependencies or Git state. This is a new independent review of the integrated source, not certification from earlier author/lead summaries. No SwarmForge tools, infrastructure CLI, VMs, deployment or publication used. Probe/report files are confined to `/tmp`.

## Verdict

**CHANGES REQUESTED: one new HIGH runtime authority defect.** The self-hosted architecture and compatibility boundaries look sound within the source/tests reviewed. Final acceptance also remains blocked by unrestricted infrastructure and protected-file execution gaps. This report does not certify release readiness or all possible defects.

## A-H1 — HIGH: child lacks an independently enforced renewable lease deadline

Locations: `src/hosted-supervisor.ts:349` (whole controlled duration passed to child), `:431` and `:452` (lease deadline enforced only by supervisor event-loop timeout); `src/hosted-runtime.ts:218` and `:233` (child receives duration but no lease budget); `src/hosted-child.ts:56` and `:71` (child only observes parent EOF and whole workload duration).

The prior correction correctly lets a workload longer than its initial lease remain whole while renewals succeed. However, the child now runs for that whole workload duration without learning its current lease expiry. Its parent-death pipe fails closed only when the parent actually exits/closes the pipe. A live but stalled supervisor cannot run its `setTimeout` watchdog or renewal, yet keeps the pipe open. The child continues after authority expiry until the full workload duration expires. SIGSTOP, an event-loop stall or a blocking native operation are distinct from parent exit. Server-side fencing/quarantine prevents a new assignment but cannot stop this existing child.

Independent executable probe: `/tmp/phase2b2-final-review-a-stalled-watchdog-probe.ts`; output `/tmp/phase2b2-final-review-a-stalled-watchdog.log`, exit 0. Uses actual unchanged Coordinator, Store, HostedStore and ControlledProcessProvider, real subprocess/OS liveness, and normal supervisor default 2s safety margin / 5s minimum lifetime. Synthetic ACK supplies an initially valid 10s lease and 20s duration with 60s absolute runtime. After successful start, an 11s busy wait stalls only the supervisor event loop. Actual result:

```json
{"leaseExpiresAt":1791588674886,"observedWall":1791588675897,"expiredCloudLease":true,"expiredLocalLease":true,"childAliveAfterExpiry":true,"childPid":25}
```

This is a concrete local-runtime defect, not a real D1/TCP finding or a claim of hostile customer execution/secrets exposure. The probe's injected transport is explicit. It uses real runtime execution and default safety settings; no private-file protection or assertion is bypassed. The child is stopped in finally after observing the failure. Severity HIGH because the stated fail-closed execution lease boundary does not survive a stalled supervisor. Current workload is inert, which limits impact; expanding to customer work would increase it.

Required correction: enforce a conservative renewable lease budget in the child or independent watchdog. Pass only bounded lease authority initially; refresh it through validated parent IPC only after an authorized renewal. Parent silence/stall must expire the child budget independently; full workload duration and absolute task deadline remain separate hard bounds. Keep parent EOF behavior, current stop proof, fencing and durable journals. Add a real-subprocess regression where the parent cannot run timers beyond the current lease, including a successful renewal followed by a stall.

The stronger end-to-end production probe **also reproduces this defect**: `/tmp/phase2b2-final-review-a-production-stall2-probe.ts`, output `/tmp/phase2b2-final-review-a-production-stall2.log`, exit 0. It logs into the actual default Worker via its local fixture, enrolls a worker, seeds an explicit policy, authorizes a hosted execution credential, registers a supervisor and submits a 120s runtime / 45s controlled task through actual HostedTaskClient. Actual SupervisorClient claims a normal 30s production lease; after waiting 10s, the normal default supervisor ACKs and launches. The reviewer then stalls its event loop until after the actual claimed lease expiry. This uses real production cloud handlers/SQL with the complementary SQLite adapter, injected in-process transport and real OS subprocess, with no shortened TTL or changed safety/minimum settings. Result:

```json
{"claimLeaseRemaining":19991,"taskRemaining":109983}
{"leaseExpiresAt":1791588803690,"observedWall":1791588807780,"expiredCloudLease":true,"expiredLocalLease":true,"childAliveAfterExpiry":true,"childPid":36}
```

No renewal could run during the stall. The real cloud-assigned lease had expired, and the child still lived roughly four seconds later. This remains SQLite/in-process evidence, not live D1/TCP. Cleanup stops the child in finally. A first stronger attempt waiting 21s before ACK was denied by the normal minimum-lifetime check; its unaltered failing script/log `/tmp/phase2b2-final-review-a-production-stall-probe.ts` and `/tmp/phase2b2-final-review-a-production-stall.log` are retained. That correct refusal does not resolve the successful default-policy reproduction above.

## Architecture and compatibility observations

- Baseline diff shows no edits to `src/coordinator.ts`, `src/store.ts`, `src/domain.ts`, `src/config.ts`, root package dependencies/lock or existing provider/agent implementation. Hosted controlled provider/agent implement the established interfaces. Coordinator paused staging cancels its pending model dispatch before inert launch. No cloud SDK import or commercial authorization is added to normal self-hosted engine startup.
- `src/cli.ts` loads hosted handler dynamically only for explicit hosted commands. Parser addition is pure. The embedded controlled-child entry is explicit and receives only isolated marker/duration environment when spawned by provider. Default hosted configuration is constructed from fixed inert values, not ambient model/repository credentials.
- Hosted mapping, one-use start rights, OS identity and frozen settlement intents live in separate SQLite journals. Existing Store schema is unchanged. Runtime stop proof does not accept Coordinator pause/cancel labels, missing maps or permission errors as proof. PID/boot/starttime/executable checks precede signals and escalation.
- Cloud schema is additive: legacy machine credential audience is unchanged, hosted CLI/supervisor credentials use separate authority stores. Production route wrapping, session cleanup compatibility, metered atomic election/dependent witnesses, ownership/fences and cleanup authority separation were reviewed directly. Migration tests preserve populated legacy installation/worker authority. This is SQLite evidence, not D1 certification.
- Controlled execution schema excludes arbitrary command, repository, prompt, model key and environment inputs. There is no demonstrated exposure of ambient secrets in the production Worker-to-Bun cancellation/child test. Hostile customer execution must remain disabled as currently documented.

## Earlier findings independently checked on this integrated candidate

Original native runtime report, native admission report, dispatch original/correction reports and compatibility/foundation architecture reports were read alongside summary/protocol. These were background, not substituted for source review.

- Callback crossbinding correction: adapted original independent probe to this exact candidate, preserving delayed-start interleaving, real children and production journals. `/tmp/phase2b2-final-review-a-onspawn-probe.ts` and `.log`: mappingA 25, mappingB 29, actualB 29, `distinctChildRecords:true`, `taskBJournalMatches:true`. Source now passes a per-launch callback to `startControlled`; no shared mutable callback remains.
- Admission retry fingerprint correction: `/tmp/phase2b2-final-review-a-submit-retry-probe.ts` and `.log`: same explicit key across two production client calls generates the same UUIDv5 request ID, `retryPayloadStable:true`. The actual default Worker/client bridge test also replays one logical admission and rejects changed work.
- Supervisor identity DTO correction: actual production Worker `/v1/supervisor/me` response is accepted by real SupervisorClient in the bridge suite. Strict client schema includes current credential/subject fields and exact scopes.
- SQL-clock browser issuance/replay, explicit reserve period and separate worker-enroller status corrections were inspected and their integrated production SQL regression tests passed. Dispatch enroller-chain, proposed lease expiry and reservation drift regression tests also passed. Earlier local reports did not supply final integrated certification; these fresh tests provide limited independent correction evidence.

## Fresh exact-candidate verification

Bun 1.4.2. Durable original logs listed here; no failed test/assertion was removed or marked skipped.

| Command | Result | Durable log |
| --- | --- | --- |
| `bun test apps/cloud/test/hosted-bun.test.ts apps/cloud/test/hosted-admission-regressions.test.ts apps/cloud/test/hosted-dispatch.test.ts apps/cloud/test/hosted-entitlements-safety.test.ts apps/cloud/test/hosted-status-regressions.test.ts apps/cloud/test/hosted-migration.test.ts` | 74 pass, 0 fail, 234 assertions; 18.43s | `/tmp/phase2b2-final-review-a-cloud.log` |
| `bun test tests/core.test.ts tests/lifecycle.test.ts tests/adapters.test.ts tests/settings.test.ts` | 110 pass, 0 fail, 639 assertions | `/tmp/phase2b2-final-review-a-core.log` |
| `bun test tests/hosted-supervisor.test.ts` | 48 pass, 10 fail, 224 assertions; 56.64s | `/tmp/phase2b2-final-review-a-runtime.log` |
| `bun test tests/hosted-cli.test.ts tests/cloud-worker-client.test.ts` | 3 pass, 10 fail, 23 assertions | `/tmp/phase2b2-final-review-a-cli.log` |
| `bun test tests/cli.test.ts tests/cli-redaction.test.ts` | 0 pass, 5 fail | `/tmp/phase2b2-final-review-a-compat.log` |
| Root `bun run check` | exit 0; type-check + Biome, 132 files | `/tmp/phase2b2-final-review-a-root-check.log` |
| Cloud `bun run check` | exit 0; type-check + Biome, 69 files | `/tmp/phase2b2-final-review-a-cloud-check.log` |

Runtime failures include durable process-restart journals, private credential storage, on-disk concurrent duplicate ACKs, factory restart and protected-file hosted handler. CLI/worker failures include private storage and localhost listeners. Legacy CLI fixture failures report socket EPERM. `/` and `/tmp` are UID/GID 65534 here, whereas production helpers correctly require trusted root/self ancestry. These are failed checks and real verification gaps, not green compatibility evidence. I did not weaken ownership assertions or fake durable storage to certify those tests. Successful runtime cases establish local in-memory journal/real child behavior only. Cloud bridge uses production handlers, injected in-process fetch and SQLite; it does not establish D1/workerd/TCP or durable-file recovery.

`git diff --check fec6697..HEAD` reports whitespace in preserved review/log artifacts; no runtime severity assigned. No candidate changes were made.

## Remaining gaps

Unrestricted protected credentials/journal custody and actual process restart, localhost/compiled CLI HTTP, actual workerd/D1 batch behavior, current live GitHub/provider behavior, edge CPU/scanned rows, sustained load and deployment remain unverified by this review. Existing failed final suite evidence in summary was not waived. Do not treat these focused passing subsets as full-root/full-cloud acceptance. Address A-H1 and run independent regression/full required infrastructure checks before acceptance.

Final provenance check after every test/probe: HEAD remains `f1d0526c5f60261f77e8a0c636f8474a5309826d`; `git status --porcelain` empty. This report is the original reviewer report, not a lead adjudication.
