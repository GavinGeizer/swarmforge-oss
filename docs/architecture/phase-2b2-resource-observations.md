# Phase 2B.2 resource observations and capacity worksheet

Status: implementation checkpoint, 2026-10-09. This worksheet records verified
platform limits and explicit planning calculations. It does not certify hosted
admission, edge performance, or pilot readiness. Integrated dispatch measurements
must be added after its production handlers pass the independent load tests.

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
