# Independent Reviewer A: runtime candidate

Reviewer did not implement this code. Read-only source review of `adc174afde028e74a267c53464070d8cc44b57ba` in `/tmp/swarmforge-phase2b2-runtime`, including complete addition against `bcf8809`; follow-up `898e63b86e5c221c373421892a2e3b3b9da4cdeb` inspected after author correction. No SwarmForge tools used, no production source modified by reviewer.

## Assessment

Architecture preserves the existing self-hosted engine and explicit CLI opt-in. New root runtime files do not import Cloudflare libraries. `src/cli.ts` dynamically loads the hosted handler only for an explicit hosted command; normal CLI argument behavior remains. Hosted configuration is constructed from fixed inert settings rather than ambient repository/model credentials. Controlled child launch uses the shipped executable and embedded hook in standalone mode; source mode has a separate development entry. Release compile settings disable ambient dotenv/bunfig/tsconfig/package autoload. The actual child receives only bounded duration and a minimal environment, with a parent-EOF watchdog and finite absolute duration.

Hosted SQLite mapping is separate from existing Store schema. A durable CAS grants a start right once, before local staging/spawn, preserving ambiguity after a crash. A paused existing Coordinator worker stages the inert runtime and retires its pending model dispatch. Lease authority uses monotonic local deadlines and full measured ACK/renew RTT; renewal never restarts a stopped task. Stop proof requires actual OS identity/absence, distinct from Coordinator labels. Foreign-process consumption uses the full reserved runtime conservatively; exact settlement intent is persisted before HTTP and reused after lost responses. None of these establish malicious same-UID isolation, repository brokerage, or exactly-once distributed execution; hostile customer workloads must stay gated.

## Concrete findings, original evidence

### A1 — Medium: shared spawn callback permits distinct-task journal crossbinding

`HostedSupervisor.ackAndStart` assigns `provider.onSpawn` to a closure for one task, while `ControlledProcessProvider.startControlled` asynchronously reads process identity and later invokes that global callback. Concurrent distinct tasks sharing one provider overwrite it, and each call clears it in `finally`.

Reproduction: `/tmp/phase2b2-review-a-onspawn-probe.ts`, invokes the real provider and real in-memory Coordinator/Store/HostedStore. A test-only provider subclass delays two starts to impose a reproducible interleaving; no fake PID/stop proof is supplied. Result:

```json
{"mappingA":23,"mappingB":23,"actualB":27,"distinctChildRecords":false,"taskBJournalMatches":false}
```

The second task's durable journal points to the first task's PID. This can invalidate stop/recovery evidence if used concurrently. Current cloud invariants (one supervisor bound to one enrolled worker, one open task per worker) and the serial CLI task loop block this distinct-task interleaving in the current honest server flow, so this is medium defense in depth, not a demonstrated current hosted admission bypass. Recommendation: pass the journaling callback as a per-call `startControlled` argument instead of mutable global provider state. Reported to lead and runtime author; correction pending.

### A2 — Medium: repeated client admission call with same key changes its fingerprint

`HostedTaskClient.submitTask(worker, runtime, duration, idempotencyKey)` generates a fresh random `request_id` on every method invocation. Production admission includes `request_id` in its fingerprint. Thus a repeated method call using the same key and identical semantic arguments necessarily conflicts rather than returning the previous admission. Internal HTTP retries inside one method invocation preserve the body and are safe; server atomic idempotency remains intact.

Reproduction: `/tmp/phase2b2-review-a-submit-retry-probe.ts` captures two actual production client requests with the same UUID key. `retryPayloadStable:false`, distinct request IDs. Production cloud source `/tmp/swarmforge-phase2b2-admission/apps/cloud/src/hosted-admission.ts` independently shows the request ID included in task.create fingerprint. Recommend stable request ID supplied by caller or derived from/reused with the operation key, plus a two-call production router/client replay test. Reported to lead/author; correction pending.

### A3 — High integration defect found by lead: supervisor identity DTO mismatch

Lead's actual defaultWorker/Bun integration returned credential_id, subject_id, epoch in `/v1/supervisor/me`, but root `supervisorIdentitySchema` is strict and omitted these fields at adc174a. Production client identity therefore rejects production server replies. The reviewer inspected the strict schema and agrees this is a contract mismatch, not acceptable mock-only validation. Original reproduction belongs to lead; reviewer has not independently run the integrated bridge yet. Exact-schema correction and final integration verification pending.

### A4 — Lease staging clock follow-up identified by author

Original adc174a started the staging elapsed clock after synchronous `grantStartRight`; SQLite busy/blocked CAS time could therefore extend usable authority. Follow-up898e63b anchors observation and staging clock before the CAS. Source correction inspected; author's real1700ms blocking CAS regression passed in the full runtime suite below. Attribution: author discovered this independently, reviewer verified correction.

## Reviewer verification

1. Targeted production runtime/store/process suite at original review: 39 passed,0 failed,173 assertions,15.79s. Includes actual inert children, stop identity mismatch/rechecks, partition cancellation, frozen settlement behavior, elapsed accounting, RTT and staging races; simulated transport explicitly labelled.
2. Existing CLI/backward-compatibility + redaction + hosted parser/shipped binary smoke:7 passed,0 failed,46 assertions,1.06s. Actual existing MCP overview/status/redaction tests passed.
3. Full `bun test tests/hosted-supervisor.test.ts tests/hosted-cli.test.ts`:59 passed,0 failed,311 assertions,66.35s. The worktree advanced from adc174a to898e63b while the test command began; the full run included the new blocking-CAS test. This run is evidence for the current follow-up candidate, not a frozen original commit certification. Final exact-SHA frozen verification is still required.

The native review process could create protected on-disk journals and local TCP listeners. In this reviewer environment the unmodified compiled actual CLI supervisor HTTP fixture passed (785.60ms), separate from the instrumented mock-fetch build (789.71ms). This does not establish live Cloudflare/D1/edge behavior or GitHub authentication. Lead's process environment reportedly denied TCP/ownership checks; these differences must be recorded, rather than assuming every tool environment has the same restrictions.

## Outstanding review scope

Await final integrated implementation SHA and inspect actual cloud routes, supervisor identity contracts, quota/lease schema, default Worker wrapper, compatibility and end-to-end tests. This report does not certify those unintegrated components and does not declare Phase2B.2 complete. Preserve this original report and add correction evidence separately.

## Environment correction (preserved, supersedes assumption above)

After the first full test tool result returned59pass, a direct metadata probe showed Bun1.4.2, Nodev26.3.0, processUID/GID1000, but lstat(`/`) UID/GID65534 mode0755 and lstat(`/tmp`) UID/GID65534 mode01777. A direct production HostedStore private-path probe failed correctly. A fresh immutable worktree `/tmp/phase2b2-review-a-898e63b` at exact898e63b, with unchanged source and dependency symlink, running the same full test command with output redirected to `/tmp/phase2b2-review-a-runtime-898e63b.log`, now reproduces the private directory verification failures in actual process-recovery tests. No production security checks were bypassed or weakened. The reason for the earlier success/fresh failure discrepancy is not established. Do not use the earlier successful tool result to close final release verification gaps; use exact-SHA durable final logs and record the restricted filesystem/listener environment. The earlier result is preserved as reported tool evidence, with this explicit contradiction.

Exact immutable898e63b command: `bun test tests/hosted-supervisor.test.ts tests/hosted-cli.test.ts > /tmp/phase2b2-review-a-runtime-898e63b.log 2>&1`, cwd `/tmp/phase2b2-review-a-898e63b`, exit1. Final durable result47pass/12fail/229assertions/56.54s. Eleven failing cases require protected file ancestry/private credentials/process-restart journals; the unmodified compiled actual hosted supervisor HTTP fixture fails with `EPERM: operation not permitted, listen`. The instrumented compiled test also fails at protected credential storage before compilation. These are genuine restrictions, not assertion weakening or skipped tests. The raw full log is preserved at the path above.
