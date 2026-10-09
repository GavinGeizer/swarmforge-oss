# Phase 2B.2 implementation and verification checkpoint

**Status: corrected candidate; Phase 2B.2 acceptance is not complete.** The resumed
review found a high runtime watchdog defect and a medium rotation replay defect;
corrections and remaining qualification limits are recorded below. Final
independent integrated reviews and unrestricted infrastructure verification are
outstanding. Untrusted customer execution remains disabled. No production deployment,
master merge, Stripe, managed inference or production provisioning occurred.

## 1. Starting branch and commit

Work began from `phase2b1-cloud-linking` at
`fec66971536cb117b36c85faabd98883d6491cb2`. Baselines were root 610 passed,
2 existing skips, 0 failed (3,771 assertions), and cloud 52 passed, 0 failed.
The original checkout later reached `4a86a46` and has read-only Git metadata.
Current integration is isolated in `/tmp/swarmforge-phase2b2-integration`, branch
`phase2b2-hosted-dispatch`. `git log` on that branch is the authoritative contribution
and integration history. This document records a candidate rather than final signoff.

## 2. Implementation architecture

Cloudflare owns tenant identity, entitlements, resource reservations, operations,
outbox and execution leases. The existing Bun Coordinator executes a fixed controlled
inert subprocess through its provider/agent abstractions. Separate SQLite hosted
journals record intent, one-use launch rights, OS identity and settlement receipts.
Existing self-hosted orchestration remains independent of commercial authorization.

## 3. Delegation and contributions

Initial SwarmForge investigations and isolated implementation/review workers produced
schema, protected credential storage, worker enrollment client, supervisor identity,
compatibility changes and original review reports. Following provider failures, the
owner explicitly instructed us to stop using SwarmForge. Native isolated agents
finished admission, cloud dispatch and Bun runtime, cross-reviewed admission/dispatch,
and independently reviewed runtime architecture. The lead inspected code, integrated
commits and exercised production routing and cross-package behavior.

Native candidate commits include admission `4fef2d6` and correction `8126b26`, dispatch
`5151dc5` and correction `93a96aa`, runtime `adc174a`, budget correction `898e63b`, and
launch-journal/identity/retry correction `404cb2a`. Integration equivalents appear in
branch history. Reports are preserved under [reviews](reviews/phase-2b2/), including
[native reports](reviews/phase-2b2/native/). Final runtime and architecture agents
stopped after an account usage-limit error; they did not certify final integration.
No further SwarmForge infrastructure operations were performed after the owner's directive.

## 4. Files and packages

Cloud production modules: hosted types, authority, entitlements, admission, supervisors,
dispatch and private status; the default Worker routes these alongside existing identity.
Root additions: worker client and CLI, protected credential file helper, hosted client,
store, supervisor, controlled runtime and explicit hosted CLI commands. Coordinator
integration is scoped to paused controlled workers and lifecycle hooks. Tests cover
these modules and existing compatibility. The root engine has no new Cloudflare dependency.
See branch diff and contribution reports for complete file lists.

## 5. D1 migrations

`0003_hosted_execution.sql` adds ten hosted tables, ownership-qualified foreign keys,
checks and indexes after existing identity migrations. It does not seed customer policy
or widen the legacy machine-credential audience. Supplemental SQLite tests execute the
complete migration SQL on a clean database and a populated Phase 2B.1 database with
foreign keys enabled; CLI and worker rows are preserved. Real D1 migration tests remain
present but cannot initialize a listener in the current permission profile.

## 6. API endpoints

Tenant-scoped routes:

- `POST /v1/tenants/:tenant/cli-installations/:installation/execution-authorizations`
- `GET /v1/tenants/:tenant/entitlements`
- `POST /v1/tenants/:tenant/tasks`
- `GET /v1/tenants/:tenant/tasks/:task`
- `POST /v1/tenants/:tenant/tasks/:task/cancel`
- `POST /v1/tenants/:tenant/tasks/:task/recover`
- `GET /v1/tenants/:tenant/hosted-status`
- `POST /v1/tenants/:tenant/supervisors`
- `DELETE /v1/tenants/:tenant/supervisors/:supervisor`

Separate supervisor routes:

- `GET /v1/supervisor/me`, `POST /v1/supervisor/me/rotate`
- `POST /v1/supervisor/claim`
- `GET /v1/supervisor/tasks/:task`
- `POST /v1/supervisor/tasks/:task/ack`, `/renew`, `/settle`

Mutations use idempotency keys and strict schemas. Browser mutation authority includes
CSRF/origin checks. Diagnostics are authenticated and tenant-scoped. Route logs use
sanitized templates. `/ready` checks the additive hosted schema; identity maintenance
still works before that migration. Scheduled cleanup runs hosted cleanup only after
all ten tables exist. Operational details: [protocol](phase-2b2-protocol.md).

## 7. Entitlements

Server-owned policy records hold capabilities, finite numeric limits, meter periods,
effective dates, expiry/revocation and versions with audit evidence. Required execution
capabilities are `hosted_control_plane`, `remote_worker_enrollment` and
`hosted_task_execution`. Numeric limits cover workers, active tasks, task runtime and
reservations. Metering reserves bounded canonical integer `compute_ms` quantities.
Absent or unavailable authority denies admission. There are no inferred subscription
prices or default paid grants. Stripe mapping remains outside the engine.

## 8. Atomic reservations

Production D1 batches elect a fresh operation under current SQL-clock authority,
resource ownership, pinned policy/allowance and quota checks. Every dependent task,
reservation, outbox, audit and meter mutation is gated by the same fresh witness.
SQL failures roll back the batch; successful zero-row conditional updates do not
roll back and therefore cannot substitute for the witness. Idempotency fingerprints
reject changed work. Tenant-qualified uniqueness prevents duplicate logical admission.
Concurrent/multi-user/multi-CLI/multi-tenant and forced interleaving regressions invoke
production SQL. SQLite tests are complementary evidence, not a D1 certification.

## 9. Task leasing and fencing

Claims establish a finite lease and increasing ownership fence. Renewal preserves
that fence and cannot reopen expired/revoked authority. SQL-time checks prevent stale
request snapshots from admitting an already expired proposed lease. Worker identity,
its original admin authorizer, supervisor authorizer, tenant and policy are rechecked.
Client deadlines use monotonic time, full round-trip cost and a safety margin. No
stale lease, delayed renewal or old credential may reopen a stopped runtime.

## 10. Durable dispatch

Admission persists an outbox in the same batch. Claim, acknowledgement, renewal,
settlement and recovery have durable scoped operation records. Lost responses replay
current authorized results rather than allocating independent execution. Logical
exactly-once admission is distinct from at-least-once delivery. We do not promise
exactly-once distributed execution. Uncertain expired execution is held rather than
silently reassigned. The finite CLI loop waits for the actual child's outcome, including
work exceeding the initial lease when timely renewals succeed.

## 11. Worker enrollment client

The client uses existing enrollment, identity, registration and rotation APIs, protected
storage, audience checks, finite retries and safe reconnect/expiry handling. Enrollment
alone grants no workload eligibility. Supported published binaries target Linux x64
glibc. Windows is outside the current release scope and fails closed; no insecure
Windows storage fallback was added. POSIX behavior outside the published target has
not received full platform qualification.

## 12. Credential isolation

Browser, CLI identity, worker identity, hosted CLI execution and supervisor credentials
have separate audiences/scopes. The controlled runtime receives only a minimal child
environment and bounded inert duration. Repository paths, prompts, arbitrary commands,
model credentials and customer secrets are excluded from its accepted task schema.
No repository broker or hostile runtime isolation is claimed. Existing self-hosted
GitHub/provider credential behavior remains available locally. Hosted customer work
requiring repositories or model secrets remains structurally disabled until a narrowly
scoped broker, BYOK custody and isolation are implemented and independently verified.
Token redaction is not an exfiltration boundary.

## 13. Cancellation and recovery

Cancellation prevents fresh claims and records durable stop duty. Already assigned
execution retains/quarantines capacity until trusted stop confirmation. The Bun watchdog
stops on authority loss or partition; stop proof checks captured Linux boot/process
identity and absence, and rechecks identity before escalating to SIGKILL. Permission
errors or unmatched live PIDs retain uncertainty. Journals record a one-use start right
before launch and immutable settlement intent before HTTP. Reconnection never blindly
respawns. Emergency settlement does not require commercial entitlements, but does require
current cleanup authority. Revoked-supervisor cases require owner/admin recovery with
independently obtained OS stop evidence and audit; a network failure is not such evidence.

## 14. Resource observations

See [resource worksheet](phase-2b2-resource-observations.md). Actual prepared-statement
and binding counts are measured locally; scanned rows, indexed writes and edge CPU
require D1/edge instrumentation. A reproducible ten-task local protocol sample measured 13–14 SQL statements per
task request, 50 task requests, and 69,632 additional allocated SQLite bytes. Simulated
supervisor reports in that sample are not runtime validation. One-shot CLI claim mode
does not run an unbounded poll service. Recovery/cleanup work is bounded. No remote preview load or edge CPU
measurement has been performed, and local test time is not edge CPU time.

## 15. Verification

Fresh lead verification on the integrated working candidate:

- Cloud complementary SQLite suite: 84 passed, 0 failed, 306 assertions, nine files,
  including two migration checks. All are additive production SQL/handler tests.
- Production Worker-to-Bun integration: three passed, including real child completion,
  cancellation with retained capacity until stop, ambient secret exclusion, duplicate
  admission and changed-work conflict. Uses SQLite cloud storage, injected in-process
  fetch and in-memory journals; it is not live D1, TCP or durable-file recovery validation.
- Root TypeScript/Biome: passed, 132 files. Cloud TypeScript/Biome: passed, 69 files
  after additive migration tests. Both packages type-check their own platform globals.
- Root executable build, archive packaging and archive verification: passed on Linux.
- Full cloud command: failed, two file-level passes and 19 file-level failures; no
  skips. Workerd initialization is restricted and two Node child processes aborted
  on a native async-scope assertion. Supplemental tests were separately executed.
- Generated Worker types: failed at `listen EPERM`. Local cloud build command returned
  success but also reported unavailable Docker and restricted Wrangler logging; that
  exit code does not establish a valid unrestricted infrastructure build.
- Full root suite: 683 passed, 78 failed, two existing skips, one error, 3,936 assertions
  across 56 files (154.51 seconds). Targeted hosted supervisor suite: 48 passed,
  10 failed, 224 assertions (53.19 seconds). Private-path and localhost restrictions are
  confirmed gaps, not waived checks. Earlier nondurable "59 passed" runtime evidence
  was superseded by an immutable rerun with 47 passed and 12 failed.

No failed assertion was deleted, no live test was skipped to obtain green results,
and no credential/journal protection or test configuration was weakened. Earlier live
browser linking, organization selection, rotation, logout/revocation and reauthorization
are separately documented in [live verification](reviews/phase-2b2/live-linking-verification.md).
Synthetic-provider integration tests are not additional live GitHub verification.

## 16. Review findings and adjudications

Original SwarmForge and native reports are retained. Concrete findings corrected include
partial meter settlement after a zero-row mutation, status cursor omissions, stale SQL
clock authority, original worker-enroller revocation, lease expiry during delayed claim,
reservation drift, expired browser grant issuance/replay, supervisor registration/rotation
expiry, unsafe PID assumptions, start ambiguity, frozen settlement retries, short task
execution and shared launch callbacks. The lead also found and corrected strict identity
DTO mismatch and verified stable-key retries against production handlers.

Runtime Reviewer A identified journal crossbinding and changed retry fingerprints;
`404cb2a` addresses them. The lead reran both original executable probes against
integration: distinct journals matched their respective real child PIDs, and repeated
client calls retained the same request ID. This is lead confirmation; fresh independent
verification was interrupted by usage limits. Admission and dispatch corrections have concrete cross-review reports; admission
`8126b26` still needs independent correction verification. Three independent reviews of
the final integrated commit are outstanding. Author reports and lead tests do not replace
those reviews. New high/critical findings must be resolved before acceptance.

## 17. Launch blockers

Complete unrestricted root/cloud and real D1/workerd/TCP/durable-path verification;
obtain final three independent integrated reviews; qualify private credential custody;
measure Cloudflare CPU, reads/writes and retained storage under controlled load; preserve
and reconcile inaccessible historical SwarmForge VM outputs without violating the owner's
stop directive. Remote publication is not complete. A prior automatic connector approval
review rejected publication under the current never-approval policy; Git DNS access also
failed. No alternate publication route was used to bypass that rejection.

## 18. Stripe and pilot prerequisites

Owner-approved plan/capability/limit/meter policy, explicit Stripe-to-policy mapping,
idempotent authenticated billing events, revocation/grace behavior and auditing are
required before Stripe integration. A controlled inert BYOK All pilot additionally
requires all verification/review gates above, secure supervisor deployment, bounded
traffic/cleanup sizing, operational stop/recovery runbooks and explicit deployment
authorization. Repository brokerage, task-scoped BYOK secrets, snapshot hygiene and
independently verified runtime isolation are mandatory before customer/untrusted workloads.


## Durable evidence index

Exact current-run logs are preserved in `reviews/phase-2b2/native/phase2b2-final-*`.
Root failures include socket `EPERM`, protected-path ownership rejection and a
`getifaddrs` error; they have not been certified as exclusively environmental.
Cloud runner reports failed test files rather than successful assertion counts;
its two passes are config/provider files. Worker `cf build` reported success with
Docker/logging errors, so infrastructure build readiness remains unverified.
Original reviewer reports, RED reproductions and lead confirmation logs remain separate.
The original protected credential helper, test assertions and live infrastructure
coverage were retained. A final unrestricted rerun must investigate any remaining
failures before acceptance.


## Resumed final review, 2026-10-09

Reviewer A inspected exact integrated `f1d0526` and reproduced a **High** runtime
lease defect through the actual default Worker, SupervisorClient, Coordinator and
child (SQLite cloud storage/in-process transport): the live parent's stalled event
loop leaves the child executing beyond its current lease. Parent EOF and total
workload duration alone do not establish an independently enforced lease watchdog.
A separate isolated implementer is correcting this; acceptance is blocked until
actual child expiry and renewable full duration are independently verified.

Reviewer C inspected the same integrated commit and found a **Medium** SQL-clock
rotation recovery defect. Both old credential and recovery-window expiries now use
`MAX(captured_time, SQL_time)` in correction `1a03be1` (integration `23535d2`). Three
regressions went RED to GREEN; full cloud SQLite suite passed 87 tests, 322 assertions,
and cloud checks passed 70 files. Reviewer A independently reran C's original probe
against the correction: 401, no successor returned, both windows expired at SQL.
The original C report remains separate from A's narrow correction approval.

Reviewer B's final session stopped when an automated content filter reported
possible cybersecurity risk; no completed B review was delivered. C preserved its
original report before a later session interruption by the same filter. These are
not approvals, and no content-filter bypass was attempted. Three completed final
integrated reviews remain an unfinished gate. Original reports/probes/current-run
results live under `reviews/phase-2b2/native/phase2b2-final-review-*`.

The resumed focused cloud/Bun authority/migration suite passed 10 tests, 75 assertions.
A fresh environment probe reconfirmed socket EPERM and differently owned root/tmp
ancestors. A further minimal IPC probe confirms nonempty parent pipe writes report
EPERM and deliver no bytes; this creates an additional real renewable-child test gap.
IPC errors must fail closed. No authority, credential, helper or assertion is weakened
to accommodate these restrictions.


## Watchdog correction integration

Runtime correction `1a2502a` (integration `7c0f147`) makes lease expiry independent
of a stalled supervisor. The child receives validated initial numeric boot-clock
deadlines fixed before spawn, checks startup delay/current authority, and accepts
only bounded renewed absolute authority through its private pipe. Parent EOF, invalid
clock/input and expiry fail closed. The child retains its full separate task duration;
expiry reports cancelled, with the journal retained until OS stop confirmation.
Provider writes await delivery callbacks; a post-write stop/expiry race cannot publish
new parent authority. See the expanded [protocol](phase-2b2-protocol.md).

A fixture-only follow-up `f24b4a8` (integration `5cea3ef`) supplies required initial
authority to the existing direct compiled-child test. Its completion/embedded-binary
assertions remain unchanged and pass. A missing-authority fixture is a real protocol
fixture defect, not an environment failure; its original failure is preserved.
The lead also found and corrected a positive-test renewal frame that exceeded its
immutable deadline; valid frames now clamp to that deadline, matching the production
provider, while the full 31-second/zero-exit assertions remain intact.

The dedicated author's final production-code full run before the fixture follow-up
reported 693 passed, 86 failed, two existing skips and one error. Successful renewable
31-second execution and malformed/buffered renewal IPC tests remain unqualified under
nonempty pipe-write EPERM. Genuine child-live/stalled-parent expiry, startup refusal,
initial-authority validation, ordinary completion and parent EOF tests exercise real
subprocesses; they do not establish successful renewal delivery on a deployable host.
A final integrated root run after both corrections and the fixture follow-up is being
recorded separately. Final full-suite failure counts supersede earlier checkpoints.


## Independent correction verification and additional component evidence

Reviewer A independently approved the narrow A-H1 correction at exact `1a2502a`.
A frozen archive of original `f1d0526` showed the child still executing (`S`) after
lease expiry. Corrected production Worker/client/child code showed `R` before the
stall and a nonexecuting zombie (`Z`) afterward, cancelled completion, retained
journal identity and trusted OS stop confirmation. Earlier `kill(pid,0)`-only
observations were explicitly corrected: presence alone does not distinguish a zombie
from executing work. An accidental moving-checkout baseline attempt is retained and
excluded from baseline RED evidence. Original reports were not overwritten.

A separate permitted anonymous-pipe harness validates the unchanged child parser
at pinned `f24b4a8`, with source hashes verified. Six real-subprocess cases pass:
full 31-second work with 62 valid renewals, malformed/expired/oversized rejection,
late closed-channel refusal and buffered late frames unable to reopen authority.
Reviewer A independently reran all six cases; the full consumer exit occurred at
31,027.269ms. This tests the child parser over an actual anonymous OS pipe. The
production provider uses a socket-backed subprocess stdin; its writes remain EPERM.
Those original tests remain failed, and the full production supervisor/client/provider
renewal path is not qualified by the anonymous-pipe component result.

The final integrated root run also exposed a real test-fixture defect: two manually
seeded allowance periods could share one millisecond and violate their unique key.
The fixture now waits for a distinct actual clock tick with a bounded retry; no
quota/cleanup assertion, uniqueness constraint or production behavior was changed.
All 28 dispatch tests and cloud checks pass after that correction. Its original full
run UNIQUE failure is preserved rather than attributed to the environment.

Production-source equivalence was inspected: current `src` matches reviewed watchdog
`1a2502a`, and `hosted-supervisors.ts` matches independently approved `1a03be1`.
Remaining gates include the third independent concurrency/recovery review, final
corrected security/integrated signoff, unrestricted socket IPC/TCP/D1, privately owned
credential/journal recovery, full green suites and edge resource qualification.


## Latest final integrated verification checkpoint

After both production corrections, the compiled-child fixture update and the real-clock
allowance fixture correction, the complete root command finished with **697 passed,
85 failed, two existing skips, one error**, 3,989 assertions across 59 files, 147.15s.
The complete complementary cloud SQLite command passed **87 tests**, zero failures,
322 assertions across ten files. Root TypeScript/Biome passed 133 files and cloud
TypeScript/Biome passed 70 files. All failure names/traces are preserved; they are
not certified as exclusively environmental. The prior 696/86 root result included
the now-corrected allowance UNIQUE fixture failure and remains preserved separately.

The unmodified full cloud infrastructure command still failed with two file-level
passes and 19 file-level failures, zero skips. Worker generated types still failed
socket initialization. Local `cf build` printed success alongside denied Docker and
Wrangler logging access, so it does not qualify infrastructure build readiness.
The final code's Linux executable/archive build and package verification are recorded
in the durable handoff after the final feature commit. No remote publication, master
merge or deployment occurred. Original and corrected worker branches are retained
in the Git bundle, including the pinned commits needed to rerun the parser harness.

The high child-stall and medium rotation replay findings have independent narrow
correction approvals. Phase acceptance still requires the remaining third independent
review and final integrated signoff, actual provider renewal transport, unrestricted
D1/TCP/protected durable storage, full green suites and operational edge qualification.
The automated content-filter interruptions are recorded as incomplete reviews, not
approval. Customer/untrusted execution remains structurally disabled.
