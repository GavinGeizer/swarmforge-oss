# Phase 2B.2 implementation and controlled local acceptance

**Status: controlled local implementation accepted; pilot and untrusted launch remain blocked.**
The original candidate `44156cc6ad7858059f0e45a659b63de81d258249` was recovered
without losing accepted contributions. Production socket-based child lease renewal,
real local workerd/D1, loopback HTTP and protected journals now execute successfully.
All accepted code and test repairs are integrated. Full suites, production child
renewal, build checks and independent A/B/C reviews passed. Final delivery identifiers
and fresh-bundle restoration are recorded in the primary handoff.
Untrusted customer execution remains disabled. No master merge, production deployment,
Stripe, managed inference or production provisioning is introduced.

## 1. Starting branch and commit

Work began from `phase2b1-cloud-linking` at
`fec66971536cb117b36c85faabd98883d6491cb2`. Baselines were root 610 passed,
2 existing skips, 0 failed (3,771 assertions), and cloud 52 passed, 0 failed.
The original checkout later reached `4a86a46`; its historical Git permission restriction
has ended. Recovery integration is isolated in `/tmp/swarmforge-phase2b2-recovery`, branch
`phase2b2-hosted-dispatch`. `git log` on that branch is the authoritative contribution
and integration history. The original complete bundle remains preserved. Its SHA256 is
`92df947d406f827e91782358836acc54b57fd0c219daec741ac668e45cf7dae0`;
a fresh clone, six required refs, ancestry and full object checks succeeded.

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
The owner subsequently explicitly reauthorized SwarmForge workers and private source
delivery. Recovery uses SwarmForge itself through its authenticated MCP server, with
separate implementation owners and independent reviewers. Private Git bundles are
checked by hash, prerequisite, actual HEAD/tree and clean worktree; automatic handoff
metadata for the older assigned `45c29d3` checkout is not treated as private source
persistence. New workers use the configured DeepSeek V4.1 Flash model. Historical
failed, quiesced and interrupted workers and their outputs remain preserved.

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
foreign keys enabled; CLI and worker rows are preserved. Real local workerd/D1
clean-install and Phase 2B.1 upgrade tests now run, including existing CLI and worker
credential checks after migration. No additional migration is needed for recovery.

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

## 15. Recovery investigations and verification

Starting historical observations at44156cc: root697pass/85fail/2existing skips/1error;
cloud SQLite87pass; cloud infrastructure2 file passes/19 file failures; listener startup
blocked generated types. These are preserved environment observations, not permanent
application failures. In the resumed unrestricted environment, TCP/workerd startup,
protected storage and actual subprocess IPC run. The original shared setup error was
`getifaddrs`; the original provider socket writes and listeners returned `EPERM`.
Those restrictions were demonstrated then and are no longer reproduced here.

Confirmed corrections:

| Failure | Confirmed cause and correction | Production effect |
| --- | --- | --- |
| Child environment exact allowlist | Stale three-variable fixture omitted two watchdog boot-clock variables; exact five-variable allowlist, raw integer syntax, captured initial authority and one-hour bound retained | Test repair; secret rejection assertions retained |
| Worker credential submitted to task route | Old Phase 2B.1 unknown-route test used malformed JSON; now valid controlled JSON/idempotency, wrong audience401 and zero task/reservation/outbox/operation writes | Test repair |
| Exhausted allowance returned409 | Both advisory and post-batch diagnostic contradicted documented403; exhausted403 and unavailable409 now agree | Two response-code lines; quota/transaction SQL unchanged |
| Concurrent journal test timed out | Invocation-count delay gated the wrong task after concurrent ACK/staging; first launch and gate release could wait on each other | Test gate bound to task identity; deterministic RED/GREEN regression |
| Audit count10 versus8 | Twenty requests crossed a real minute boundary; the server correctly permitted2+8 across two buckets | Test checks per-window authority and deterministic exact-eight saturation |
| Enrollment response body already read | An unread local Miniflare response became disturbed across D1 migration calls under memory pressure | Parse registration immediately; credential identity still checked after migrations |

The first quota correction7e0cf18 also changed unavailable allowances to403, and its
claimed diagnostic test only repeated the advisory path. That standalone correction was
rejected and preserved. Repair1574331 distinguishes both paths with REAL beforeBatch
ledger mutations and zero-dependent-write assertions; independent B/C reviews reproduced
the rejected failure and approved the corrected range.

Actual production transport: `ControlledProcessProvider` creates socket-backed stdin
using subprocess `stdio: pipe`. A31-second child survives its initial30-second lease
through renewals; the lead and worker each executed this production path. Anonymous
OS-pipe parser tests are supplemental evidence only. No production transport replacement
was needed. Child expiration, stale renewal, cancellation, uncertain stop, fencing and
journal recovery remain enforced.

New `apps/cloud/test/hosted-runtime.integration.ts` exercises the default Worker routes
and middleware under real local Miniflare/workerd D1, a real Node TCP bridge, a real Bun
supervisor/coordinator/provider and inert child, and private file-backed journals.
Its five cases cover31s/multiple renewals/lost ACK/no duplicate child, cancellation with
verified stop and released reservation, partition with retained uncertain capacity,
actual driver failure while a child is alive with production cleanup, and malformed
output rejection. PID absence requires `ESRCH`; permission errors cannot prove death.
All drivers are awaited before fixture teardown; SIGKILL fallback is a failed
qualification with explicit uncertainty. The lost ACK response body is consumed.
The lead executed all five cases on integrated source:5pass/0fail,62.188s.
Identity provider fixtures are synthetic; these are local infrastructure tests, not live
Cloudflare edge or additional live GitHub qualification.

Final code integration is `0b06aeb77c4f9b3d30a1102bc3f092c9f0eaf5f3`, tree
`9c85e0316de58b46d38bee4d7ec8aa0c1f3a414a`. Accepted recovery heads include
1574331 (quota contract),605fa60 (real lifecycle tests),b6d6e54 (root gate/bound)
andc1e696a (cloud test repairs). Actual commands and results:

| Command | Result |
| --- | --- |
| Root `bun --no-env-file --config=/dev/null test` |788pass/0fail/2existing skips;4,540 assertions,790tests/59files,233.29s |
| Cloud `bun run test` (Node infrastructure then Bun SQL) |130/130 infrastructure,0skips,68.364s;90/90 SQL,351 assertions/10files,19.49s |
| Node memory64 focused abuse/schema diagnostic |8/8,0skips,5.960s; real clean and populated2B.1 migration cases |
| Root/cloud `bun run check` | TypeScript/Biome passed on133/71files |
| Cloud `bun run types` | Generated bindings passed |
| Root `bun run build`, `bun run package`, `bun run package:verify` | Linux executable/archive/manifest verification passed |
| Cloud `bun run build` | Emitted actual Worker bundle, exit0; Docker detection permission warning retained |
| Built CF artifact smoke under real workerd/D1 | ready200; unauthorized valid admission401; zero task/reservation/outbox/operation rows; no external requests |

Root ran at `a3f14dc15ee8d85c2e76efde452251ac3625d4d5`; the subsequent final
code merge changes only the two Node integration files. Root sources, root tests,
SQL tests, migrations, dependencies and configurations are identical. The full
cloud suite and executable/archive were verified at0b06aeb. Recovery documentation
and review evidence are a later delivery delta; final delivery identifiers are
recorded in the primary handoff.

The cf-built1,003,567-byte Worker artifact SHA256 is
`34a09951f53d6b227615aaef8e091a2db573321dd66c70f92800421bab3e465e`.
Its successful local workerd/D1 boot qualifies the emitted compilation despite
unavailable Docker detection; this API uses no container binding. It does not
qualify live Cloudflare edge CPU or production bindings. The preliminary Linux
archive at0b06aeb SHA256 is
`5436d42e3bea1c67455b79d188f554e053b5398b1dadeaaf27f73fe7a6200997`.
A final delivery build, if regenerated, carries its own actual commit/hash in the handoff.

Both existing skips are retained: lifecycle-package-only finalization survival,
and opt-in real Freestyle/OpenCode/model smoke. No test was skipped to obtain green
results. B recovered the stored summary of one earlier non-final cloud run:
125 tests,124 passed,1 failed. The original command filtered out per-test details;
its identity/stack is irretrievable. This is an explicit historical verification gap,
not established flakiness or an established production defect. B's three fresh full
130-test runs and the lead/A/C runs passed. The original report and correction are retained.

Earlier live browser linking, organization selection, rotation, logout/revocation and
reauthorization remain documented in [live verification](reviews/phase-2b2/live-linking-verification.md).
Linux is the advertised release scope; Windows secure-storage qualification is outside
that scope. No new live provider check is claimed in this recovery.

## 16. Independent review and adjudication

Original and corrected reports are preserved separately. Recovery roles:

- Architecture A: w-cf8f53a8-390e-4f5b-90d9-4759b856a37f; prior A quiesced and is retained.
- Concurrency B: w-e78895ad-229f-407e-9ff7-84acef9410e5.
- Security C: w-eb4ef77b-0a04-4d46-9bc5-934a1985eb3e; original malformed follow-up remains incomplete.

All three approved the1573 quota/audience correction within its exact scope. B and C
approved the605fa60 end-to-end test after correcting real driver cleanup and response
body leaks. B reproduced the original journal deadlock and approved the identity-bound
gate and accurate wording; A's dropped one-hour test bound was restored atb6d6e54.
A retracted its mismatched-comment allegation after source inspection showed the
comment exactly matched the four asserted tables.

C's original shared-journal allegation was tested against the real supervisor/client
and production Worker with an in-process SQLite D1 adapter. Cloud tenant guards reject
foreign ACK/renew/status/settlement. Distinct private journals prevent accidental
sharing by default. The deliberately shared probe used a never-started row and a stub
provider: it does not prove isolation of a foreign OS runtime. The local journal and
MCP server are the trusted operator plane. Do not share credential paths or explicitly
configured state paths across tenant supervisors. Corrected probe helpers assert
rejections without catching their own assertion failures.

Previous content-filter interruptions, failed source preflights, public stand-in
investigations and malformed results remain incomplete evidence; they are not approvals.
No security filter or rejected publication was bypassed. All three independently
inspected the complete integrated implementation at
`8abc7bdc58c2461bd067a5c860923b13f6e8b6cf`, tree
`f3e0f746f56bf6c9c0b6a36799f947921c77e18b`, and approved their full assigned
controlled-local scopes. These are complete-scope reviews, beyond contribution approvals.

| Reviewer | Final result and independent execution |
| --- | --- |
| [A: architecture/compatibility](reviews/phase-2b2/recovery-20261011/final-review-A-8abc7bd.md) | APPROVED; cloud130/130, SQL90/90, compatibility110/110, child/client23/23, root/cloud static checks |
| [B: concurrency/recovery](reviews/phase-2b2/recovery-20261011/final-review-B-8abc7bd.md) | APPROVED; root788/0/2 existing skips, cloud130/130 three times, SQL90/90, runtime5/5, static checks, memory64 abuse3/3 |
| [C: authentication/isolation](reviews/phase-2b2/recovery-20261011/final-review-C-8abc7bd.md) | APPROVED; root788/0/2 existing skips, cloud130/130, SQL90/90, static checks,15 cross-tenant guard checks |

No introduced Critical/High defect remains unresolved. The unrecovered historical
failure is retained as an evidence gap. The deliberate fivefold-load `/proc/environ`
timing observation is recorded as a test robustness limitation; it did not recur in
these final whole-root runs. Local workerd/D1, TCP and OS IPC are qualified in the
resumed authorized environment; live deployed operations remain outside these reviews.
The final delivery adds documentation and preserved evidence only. Reviewers verify
that exact delivery commit and unchanged production/test source in follow-up reports
preserved in the handoff/evidence archive; no passing source suite is altered.

## 17. Deployment and untrusted launch gates

The final combined root/cloud suites, builds, generated types, package verification,
clean/Phase 2B.1 migrations and exact integrated A/B/C reviews passed. The handoff
records the final delivery commit, package and verified fresh bundle restoration.
Controlled local fixture qualification is distinct from pilot deployment readiness. Live edge CPU, D1 scanned/written rows, larger retention
storage growth and load fitness remain unmeasured. The cf build warning is a Docker detection restriction, not a failed Worker compile;
the actual emitted artifact was booted against real local D1. Production bindings
and live edge performance still require separately authorized qualification.

Private credential custody, supervisor operating permissions, stop/recovery runbooks,
owner-approved capacity policy and explicit deployment authorization remain pilot gates.
Repository brokerage, task-scoped BYOK custody, snapshot hygiene and independently
verified hostile runtime isolation are required before any customer/untrusted execution.
Historical VMs are retained; necessary outputs are preserved before any separately
authorized cleanup. No master merge or production deployment is authorized here.

## 18. Stripe and BYOK All prerequisites

Stripe requires owner-approved capability/limit/meter policy, a separate authenticated
idempotent plan-to-policy mapping, revocation/grace policy and audits. No prices, billing
rates or product quotas were invented. A controlled inert pilot requires the qualified
candidate, secure supervisor custody, bounded request/cleanup sizing, operational
recovery and explicit deployment approval. Customer workloads retain the separate
repository/secret/isolation gates above.

## 19. Recovery delivery and evidence

Primary handoff: `data/phase2b2/HANDOFF.md`. Preserved original bundle:
`data/phase2b2/phase2b2-hosted-dispatch.bundle`. Committed recovery evidence: [original/corrected reports and logs](reviews/phase-2b2/recovery-20261011/).
Additional local recovery evidence: `data/phase2b2/recovery-20261009/`, including exact-current-run structured results,
original/corrected reviews, hashes, failed attempts, RED reproductions and test logs.
Source bundles preserve rejected and accepted intermediate commits. The original
candidate summary and complete earlier evidence remain in44156cc Git history.
The final handoff identifies the implementation/delivery commits, refreshed bundle
hash and fresh-restore result, exact test commands/counts, remaining live-infrastructure
restrictions and worker disposition. Automatic older-checkout publication metadata is
not an accepted-source identifier.
