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
| `swarmforge_artifacts_preserved_total{kind}` | Artifact records in state `preserved`, meaning stored and checksum verified. |
| `swarmforge_artifacts_bytes_total{kind}` | Verified bytes of those preserved records. |
| `swarmforge_artifacts_failed_total{kind}` | Artifact records in state `failed`. |
| `swarmforge_artifacts_in_flight{kind}` | Artifact records still in state `preserving`, that is a capture in progress. |
| `swarmforge_artifacts_scan_complete` | 1 when the collection-duration histogram covers every preserved record, 0 when it or the fallback listing was cut short. |
| `swarmforge_artifact_collection_duration_seconds` | Capture start to verified preserved artifact. |
| `swarmforge_finalizations{state}` | Worker finalization records by stage: pending, collecting, preserved, failed, abandoned. |
| `swarmforge_finalization_attempts_total{outcome}` | Durable finalization events: `attempted`, `preserved`, `failed`, `abandoned`. |

Artifact counters and byte totals come from one grouped query over the persisted artifact
repository, so they are exact for a repository of any size and no page limit can silently
truncate them. The collection-duration histogram needs one timestamp pair per preserved record,
so it streams them with an observation bound (one million rows); reaching that bound, or an
unreadable repository, reports `swarmforge_artifacts_scan_complete 0` instead of a quietly
partial histogram. If the repository cannot be summarised by the grouped query at all, the
service's own paged listing is aggregated instead, streaming without retention until it reports
its end, and any failure or non-advancing cursor is likewise reported through the same gauge.
Alert on `swarmforge_artifacts_scan_complete` dropping to 0.

Record states are counted separately: only `failed` is a failure, and a capture still in
`preserving` is in flight. The only label is a fixed `kind` set (`file`, `directory`,
`snapshot`, `diagnostic`, `log`); an unexpected kind becomes `other` instead of creating new
time series. No artifact path, filename, checksum, size, worker ID, task ID, error message or
content is ever a label or a value.

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
neither produces an event. Anything else under the `finalization.` prefix counts as `other`.
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
sum by (state) (swarmforge_finalizations)
sum by (outcome) (swarmforge_finalization_attempts_total)
min(swarmforge_artifacts_scan_complete)
```

Structured transition logs contain team/task/worker/VM/session identifiers and exclude prompts and known secrets. `<DB_PATH>.log` rotates at approximately 1 MiB to one backup. SQLite retains the audit event history; its backup/retention is an operator responsibility. Guest service output uses journald; configure its storage limits in the external snapshot. MCP log retrieval returns at most 100 events and a 16 KiB service tail.

Persisted events remain accessible through `get_worker_logs` after VM destruction and during provider outages. Its `opencode` field is null when the guest tail is unavailable, paused, or undergoing a control operation; observation does not intentionally resume a guest.

Monitor preserved artifact throughput, `swarmforge_finalizations{state="failed"}`, workers stuck in `pending` or `collecting`, `swarmforge_artifacts_in_flight` that never drains, and `swarmforge_artifacts_scan_complete` dropping to 0. A `failed` finalization keeps its VM for inspection and `retry_worker_finalization`; `swarmforge_artifacts_failed_total` distinguishes capture failures from artifacts that were deliberately abandoned by forced destruction. Artifact bytes themselves are only visible through the authenticated download route, never in metrics, logs or events.

The bounded `/events` SSE replay uses monotonically increasing event IDs and supports `Last-Event-ID`. Slow consumers can reconnect to retrieve subsequent batches. Monitor queued capacity, recovery-required workers, old pending control intents and external inference errors. No notification bus or metrics storage is embedded.

`wait_for_state_change` is the in-process counterpart of that replay: each waiting caller holds one in-memory listener on the store and is woken by the same committed event, so a blocked call neither polls the provider nor holds a worker lock. A timeout or a dropped request releases the listener, and cursors are event IDs that remain valid after a restart. Waiting is bounded per call and reports no metric label, worker payload or guest power state.
