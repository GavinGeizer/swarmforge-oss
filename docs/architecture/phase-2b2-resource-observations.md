# Phase 2B.2 resource observations and capacity worksheet

Status: implementation checkpoint, 2026-10-09. This worksheet records verified
platform limits and explicit planning calculations. It does not certify hosted
admission, edge performance, or pilot readiness. Integrated local protocol measurements appear below. They are complementary
SQLite evidence; independent live D1/edge load tests remain outstanding.

## Platform limits

Workers Free permits 100,000 requests/day, 10 ms CPU/request, and 128 MB/isolate.
Waiting for database or network results is not Worker CPU time. Local test wall
time cannot establish compliance with the edge CPU ceiling.
[Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)

D1 Free limits include 50 queries/Worker invocation, 100 bound parameters/query,
500 MB/database, 10 databases/account, and 5 GB total storage. Limits apply to
individual statements within a batch. One database serializes its queries;
overload may queue or reject requests. These limits require bounded recovery
batches and indexed tenant/resource predicates.
[Cloudflare D1 limits](https://developers.cloudflare.com/d1/platform/limits/)

Free D1 allowances are 5 million rows read/day and 100,000 rows written/day.
Returned row count is not scanned row count; index maintenance also consumes
writes. Record genuine `meta.rows_read`, `meta.rows_written`, and `meta.size_after`
when available. Daily read/write exhaustion denies database operations; this
must deny new admission and must not be reported as confirmed runtime stop.
[Cloudflare D1 usage definitions](https://developers.cloudflare.com/d1/platform/pricing/)

These are platform limits, not SwarmForge subscription quotas. No subscription
price, billing rate, managed inference allocation, or customer policy follows
from this worksheet.

## Request-volume model

Let `S` be continuously polling supervisors and `P` their idle polling interval
in seconds. The modelled idle claim volume is `S * 86400 / P` requests/day.
This is arithmetic, not an observed production workload. A one-shot supervisor
invocation contributes one claim attempt instead; do not assume the implemented
CLI runs a continuous polling service without checking its actual mode.

| Supervisors | Poll interval | Modelled idle requests/day |
| --- | --- | --- |
| 1 | 5 seconds | 17,280 |
| 5 | 5 seconds | 86,400 |
| 6 | 5 seconds | 103,680 |
| 10 | 30 seconds | 28,800 |

The six-supervisor/five-second case exceeds the request ceiling before any
authentication, task submission, renewal, cancellation, settlement, operator
read, or retry traffic. Backoff and jitter must remain finite and preserve
idempotency keys. Polling changes never extend an execution lease.

If `T` tasks/day each produce `H` heartbeats and `K` other task API requests,
the additional modelled volume is `T * (H + K)`. Add identity and cleanup traffic
separately. Determine `H` from actual execution duration and heartbeat cadence;
determine `K` from the integrated claim/ack/report/recovery path, including retries.
Do not count a lost acknowledgement as a new logical task.

## D1 work and storage methodology

For each production operation, collect its prepared-statement count, bound
parameter maximum, D1 scanned/written rows, batch outcome, and task/reservation
state before and after. Include the existing authentication and abuse-limit
statements. Repeat on a database with retained task and audit history; an empty
database hides unindexed scans.

Application records per accepted task include one task, one reservation, and
one outbox record, plus operation and audit history. Their existence is a
schema requirement; their final indexed write cost is not yet measured.
Renewal cadence, encrypted replay results, and retention policy affect growth.
Estimate storage from actual `size_after` deltas over a sufficiently large
controlled run, report the sample size, and include indexes and identity data.
Retaining evidence and idempotency tombstones costs storage; deleting them
without an explicit retention/replay policy can reopen duplicate operations.

The existing identity cleanup schedule is every ten minutes. Its deletes are
bounded to 500 candidate rows per statement. Hosted expiration cleanup must
retain capacity for uncertain execution, even after policy expiry or a database
outage. A TTL is not runtime termination evidence. Cleanup query scans and
retained-session reference checks need their own measurement.

## Evidence available at this checkpoint

| Check | Evidence and limitation |
| --- | --- |
| Lead default Worker bundle | esbuild produced 842,037 bytes on the integrated schema checkpoint; this is local uncompressed output, not an edge size/CPU result |
| Lead static checks | Root TypeScript/Biome passed on 120 files; cloud TypeScript/Biome passed on 35 files at the schema checkpoint |
| Lead worker-client tests | Bun 1.4.2: nine production client/storage tests passed; no D1 or edge claim follows |
| Schema reviewer | Exact `b61f244`: five real local D1/workerd tests passed, plus CHECK/FK/UNIQUE probes |
| Migration compatibility author | Exact `7897898`: full cloud suite 59/59 passed on real local D1/workerd; independent review pending |
| Local lead D1 rerun | One DTO test passed; four fixture tests failed at localhost listener startup (`EPERM`); documented verification gap |
| Remote environment | No remote preview load test, edge CPU measurement, production deployment, or live hosted workload run performed |

Green unknown-route probes from rejected test commit `7300825` are excluded
from admission and load evidence. The corrected tests deliberately fail while
the requested production routes are missing.

## Upgrade and launch decisions

Before increasing pilot traffic, calculate total requests, scanned/written rows,
and storage from the observed workload plus cleanup/retry overhead. Obtain an
owner-authorized platform upgrade before the forecast reaches any Free ceiling.
If measured edge CPU exceeds 10 ms, or an invocation needs more than 50 D1
queries, optimize and remeasure or upgrade before admitting that workload.
Local elapsed time is insufficient to make that decision.

Database exhaustion must trigger operational recovery, not quota-counter resets
or release of quarantined reservations. Independent review and a controlled
end-to-end run are prerequisites to a pilot. Repository brokerage, task-scoped
BYOK custody, snapshot hygiene, and runtime isolation remain separate prerequisites
to enabling untrusted customer execution. Production deployment requires owner
authorization.


## Integrated local protocol sample

Reproduce from `apps/cloud` with:

```sh
bun --no-env-file --config=/dev/null scripts/measure-hosted-local.ts
```

The sample invokes the default production Worker, preserves rate limits, executes
production SQL with foreign keys/atomic SQLite batches, and retains history for ten
sequential metered tasks. Each receives a claim, acknowledgement, renewal and settlement:
50 task requests total. Identity is synthetic, transport is in-process and supervisor
reports are simulated. No child executes in this cost sample. Actual subprocess
completion/cancellation is covered separately by `hosted-bun.test.ts`.

| Operation | Samples | Prepared statements per request |
| --- | ---: | ---: |
| Browser-authorized metered admission | 10 | 14 |
| Claim | 10 | 14 |
| Acknowledgement | 10 | 13 |
| Renewal | 10 | 13 |
| Settlement | 10 | 14 |
| Empty hosted scheduled cleanup plus identity cleanup/schema check | 1 | 13 |

Counts include the default Worker's rate-limit statement. Component-reviewed dispatch
counts exclude that statement and are therefore one lower. This empty-cleanup sample
is not a bound for populated recovery batches. The dispatch correction report records
bounded populated cleanup separately; final integrated busy-cleanup verification remains
a review requirement. The adapter rejects more than 100 bound arguments, but this sample
does not measure D1 scanned rows or index write amplification.

SQLite allocated pages rose from 121 to 138 at 4,096 bytes/page: 69,632 additional
allocated bytes over ten tasks, approximately 6,963 bytes/task for this small sample.
The ending 565,248 bytes includes identity, indexes and retained history. Page allocation
is not live D1 `size_after`, linear long-term storage growth, or a retention policy.
Operation/audit history and encrypted result size must be measured at larger scale.

The result asserts zero remaining reserved meter and ten consumed units. Per-operation
wall times are recorded in the preserved JSON log only as local timings; no Cloudflare
CPU claim follows. No scan/write accounting or remote load result was fabricated.
Evidence: [local sample](reviews/phase-2b2/native/phase2b2-final-local-protocol-cost.log).


## Recovery qualification, 2026-10-11

The emitted cf Worker bundle (1,003,567 bytes, SHA256
`34a09951f53d6b227615aaef8e091a2db573321dd66c70f92800421bab3e465e`)
booted under local workerd with real D1 and all migrations. Readiness returned 200;
unauthorized valid admission returned 401 with zero dependent writes. This qualifies
local compilation and routing, not deployed bindings or edge CPU. The Docker detection
permission warning is preserved; this Worker declares no container binding.

Source inspection bounds a populated scheduled cleanup at 22 hosted statements,
10 identity statements and one schema check: at most 33 statements in this path.
This is a statement-count bound, not measured D1 scanned rows, write amplification,
or Worker CPU. No edge performance or additional live load qualification is claimed.
