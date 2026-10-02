# Observability

When enabled, the separate metrics listener exposes `/metrics` on port 9090 by default. Prometheus/Grafana are external consumers. Metrics do not contain worker IDs, task IDs, prompts or commits. Team labels use `SWARMFORGE_METRICS_TEAMS`; unlisted teams map to `other`.

| Metric | Meaning |
| --- | --- |
| `swarmforge_workers{team,state}` | Persistent worker records by lifecycle state, including destroyed history. |
| `swarmforge_workers_active` | Running or waiting tasks. |
| `swarmforge_workers_waiting` | Waiting on OpenCode/retries. |
| `swarmforge_workers_created_total{team}` | Persisted worker requests. |
| `swarmforge_workers_completed_total{team}` | Completed turns, including follow-ups. |
| `swarmforge_workers_failed_total{team}` | Failed/recovery-required transitions. |
| `swarmforge_tasks_queued` | Workers awaiting VM capacity. |
| `swarmforge_worker_provision_duration_seconds{backend}` | Provision-to-ready histogram. |
| `swarmforge_worker_task_duration_seconds` | Completed turn duration histogram. |
| `swarmforge_tokens_total{team,model,direction}` | Observed input/output/reasoning/cache tokens. |
| `swarmforge_inference_requests_active` | Estimate based on incomplete assistant messages, not exact inference-server concurrency. |
| `swarmforge_artifacts_attempts_total{kind}` | Capture attempts started, from the durable artifact event log. Exact and monotonic: every attempt is persisted. |
| `swarmforge_artifacts_preserved_total{kind}` | Captures that stored and verified bytes. Bounded per artifact by the 20 terminal-event cap; see below. |
| `swarmforge_artifacts_bytes_total{kind}` | Verified artifact bytes written by the coordinator. Same 20 terminal-event cap as `preserved_total`. |
| `swarmforge_artifacts_failed_total{kind}` | Capture attempts that failed. Same 20 terminal-event cap as `preserved_total`. |
| `swarmforge_artifacts_stored{kind}` | Currently published artifact copies, excluding superseded ones. Exact: read from the record table. |
| `swarmforge_artifacts_stored_bytes{kind}` | Bytes of the currently published copies. Exact: read from the record table. |
| `swarmforge_artifacts_in_flight{kind}` | Captures that are still running. Exact: read from the record table. |
| `swarmforge_artifacts_scan_complete` | 1 when the collection-duration histogram covered every completed capture. It says nothing about the counters above; alert on it for the histogram. |
| `swarmforge_artifact_collection_duration_seconds` | Capture start to a verified stored artifact. |
| `swarmforge_finalizations{state}` | Worker finalization records by stage: pending, collecting, preserved, failed, abandoned. |
| `swarmforge_finalization_attempts_total{outcome}` | Durable finalization events: `attempted`, `preserved`, `failed`, `abandoned`, `other`. |

Cumulative artifact counters are reconstructed from the durable artifact event table
(`artifact_events`: `artifact.attempted`, `artifact.preserved`, `artifact.failed`), which is
append-only, so a `_total` only ever grows. They deliberately do not come from the record table:
every attempt is its own record and a recapture supersedes the copy it replaces, so summing
records would count both the old and the new copy while a later cleanup of superseded bytes
lowers the byte total again. Current state is therefore a gauge, not a total:
`swarmforge_artifacts_stored` and `swarmforge_artifacts_stored_bytes` count only published copies
(`superseded_by IS NULL`), and `swarmforge_artifacts_in_flight` counts captures still running.

## One exception: these counters are bounded, not exact at any repository size

The event table is append-only for `artifact.attempted`, but a single artifact keeps at most **20
terminal events** — `artifact.preserved` and `artifact.failed` combined. Once an artifact already
has 20, further terminal events for that same artifact are **dropped, not recorded**
(`maxArtifactEvents = 20`, enforced in the data plane's `src/artifact-store.ts`). That is
deliberate: it bounds a source that is recaptured in a loop. The consequences are precise:

| Metric | Source event | Bounded by the 20-event cap? |
| --- | --- | --- |
| `swarmforge_artifacts_attempts_total` | `artifact.attempted` | No. Every attempt is persisted, so this total is exact and monotonic. |
| `swarmforge_artifacts_preserved_total` | `artifact.preserved` | Yes, past 20 terminal events for one artifact. |
| `swarmforge_artifacts_failed_total` | `artifact.failed` | Yes, past 20 terminal events for one artifact. |
| `swarmforge_artifacts_bytes_total` | `artifact.preserved` | Yes, past 20 terminal events for one artifact. |

So the honest reading is: the three terminal-derived series are exact for ordinary workloads and
**under-count a single path that churns past 20 settled captures**; they never over-count and
never decrease. Do not alert on them as a lossless ledger for a churning path — use
`swarmforge_artifacts_stored`, `swarmforge_artifacts_stored_bytes` and `swarmforge_artifacts_in_flight`,
which come from the record table and are exact current state, or `swarmforge_artifacts_attempts_total`,
which is exact. The same bound also limits the per-artifact event history the data plane can read
back (`ArtifactService.events(artifact_id, limit = 20)`, newest first); that accessor is not
currently exposed as an MCP tool.

Counters and gauges otherwise come from grouped queries, so they need no paging. The
collection-duration histogram has to walk rows, so it streams them with a budget of twenty
thousand completed captures and reports `swarmforge_artifacts_scan_complete 0` if that budget is
ever reached, rather than silently truncating; alert on that gauge. Note that this gauge covers
only the histogram: the cumulative counters are exact *for the attempt counter* and bounded as
described above regardless of `scan_complete`. A capture still in `preserving` is in flight,
never a failure, and a failure series exists per kind with a zero value so a dashboard never has
to tell "no failures" from "no data". Record states are counted separately from outcomes: only a
recorded `artifact.failed` event is a failure.

The only label is a fixed `kind` set (`file`, `declared`, `snapshot`, `diagnostic`); an unexpected
kind, including a plural or a caller-supplied name, becomes `other` instead of creating new time
series. No artifact path, filename, checksum, size, worker ID, task ID, error message or content
is ever a label or a value.

Cumulative finalization totals are rebuilt from the durable event log, not from the current
worker record, because a record's `attempts` counter describes one collection cycle and falls
back to zero when a worker is collected again. The lifecycle package persists exactly these
event types, and this is the contract the metric depends on:

| Event type | Meaning | Label value |
| --- | --- | --- |
| `finalization.attempted` | One collection attempt was claimed and persisted before any effect | `attempted` |
| `finalization.preserved` | Collection settled with its artifacts stored | `preserved` |
| `finalization.failed` | Collection gave up | `failed` |
| `finalization.abandoned` | Preservation was explicitly abandoned, normally by forced destruction | `abandoned` |

`finalization.attempted` is the durable attempt count. A claim persists it before doing anything,
so a worker whose process died mid-attempt still leaves exactly one event per attempt when the
claim is re-entered after a restart, and the counter always matches the persisted attempts field.
Creating the preservation record announces nothing and a scheduled retry is not an outcome, so
neither produces an event. The superseded `finalization.collecting` name is still counted as an
attempt so an older database keeps its history, and anything else under the `finalization.` prefix
counts as `other`.
Event payloads are never read, so a recorded error cannot become a label or a value. A database
written before these events existed reports zero attempts, which is honest: the history was never
persisted. The stage gauge `swarmforge_finalizations{state}` still comes from the live worker
record, and is a gauge of current state rather than a sum of attempts.

Counters are reconstructed from SQLite, so server restarts preserve observed totals. Usage is keyed by worker/message and updates monotonically to deduplicate polling. Detailed worker/team/task usage appears in MCP status tools. OpenCode reporting is the accounting source; provider billing may use different definitions. Data unavailable after a guest failure cannot be reconstructed from the model provider.

Example PromQL:

```promql
sum(swarmforge_tokens_total)
sum by (team) (swarmforge_tokens_total)
sum(rate(swarmforge_tokens_total{direction="output"}[5m]))
sum by (state) (swarmforge_workers)
sum(rate(swarmforge_artifacts_bytes_total[15m]))
sum by (kind) (swarmforge_artifacts_stored)
sum(rate(swarmforge_artifacts_attempts_total[1h])) - sum(rate(swarmforge_artifacts_failed_total[1h]))
sum by (state) (swarmforge_finalizations)
sum by (outcome) (swarmforge_finalization_attempts_total)
min(swarmforge_artifacts_scan_complete)
```

Structured transition logs contain team/task/worker/VM/session identifiers and exclude prompts and known secrets. `<DB_PATH>.log` rotates at approximately 1 MiB to one backup. SQLite retains the audit event history; its backup/retention is an operator responsibility. Guest service output uses journald; configure its storage limits in the external snapshot. MCP log retrieval returns at most 100 events and a 16 KiB service tail.

Persisted events remain accessible through `get_worker_logs` after VM destruction and during provider outages. Its `opencode` field is null when the guest tail is unavailable, paused, or undergoing a control operation; observation does not intentionally resume a guest.

Monitor preserved artifact throughput, `swarmforge_finalizations{state="failed"}`, workers stuck in `pending` or `collecting`, `swarmforge_artifacts_in_flight` that never drains, and `swarmforge_artifacts_scan_complete` dropping to 0. A `failed` finalization keeps its VM for inspection and `retry_worker_finalization`; `swarmforge_artifacts_failed_total` counts capture attempts that failed, while a forced destruction's deliberate abandonment shows up as `swarmforge_finalization_attempts_total{outcome="abandoned"}` and as a drop in `swarmforge_artifacts_stored`. Artifact bytes themselves are only visible through the authenticated download route, never in metrics, logs or events.

The bounded `/events` SSE replay uses monotonically increasing event IDs and supports `Last-Event-ID`. Slow consumers can reconnect to retrieve subsequent batches. Monitor queued capacity, recovery-required workers, old pending control intents and external inference errors. No notification bus or metrics storage is embedded.

`wait_for_state_change` is the in-process counterpart of that replay: each waiting caller holds one in-memory listener on the store and is woken by the same committed event, so a blocked call neither polls the provider nor holds a worker lock. A timeout or a dropped request releases the listener, and cursors are event IDs that remain valid after a restart. Waiting is bounded per call and reports no metric label, worker payload or guest power state.
