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
| `swarmforge_artifacts_preserved_total{kind}` | Artifacts captured from workers and verified in storage. |
| `swarmforge_artifacts_bytes_total{kind}` | Verified artifact bytes held by the coordinator. |
| `swarmforge_artifacts_failed_total{kind}` | Captures that failed or were abandoned, by artifact state. |
| `swarmforge_artifact_collection_duration_seconds` | Capture start to verified preserved artifact. |
| `swarmforge_finalizations{state}` | Worker finalization records by stage: pending, collecting, preserved, failed, abandoned. |
| `swarmforge_finalization_attempts_total` | Automatic and operator-triggered collection attempts, summed from persisted attempt counts. |

Artifact metrics are reconstructed from persisted artifact records and finalization records on every scrape, so restarts and manual retries keep the same totals. Their only label is a fixed `kind` set (`file`, `directory`, `snapshot`, `diagnostics`, `log`); an unexpected kind becomes `other` instead of creating new time series. No artifact path, filename, checksum, size, worker ID, task ID or content is ever a label or a value, and a finalization error message never reaches the metrics surface.

Counters are reconstructed from SQLite, so server restarts preserve observed totals. Usage is keyed by worker/message and updates monotonically to deduplicate polling. Detailed worker/team/task usage appears in MCP status tools. OpenCode reporting is the accounting source; provider billing may use different definitions. Data unavailable after a guest failure cannot be reconstructed from the model provider.

Example PromQL:

```promql
sum(swarmforge_tokens_total)
sum by (team) (swarmforge_tokens_total)
sum(rate(swarmforge_tokens_total{direction="output"}[5m]))
sum by (state) (swarmforge_workers)
sum(rate(swarmforge_artifacts_bytes_total[15m]))
sum by (state) (swarmforge_finalizations)
```

Structured transition logs contain team/task/worker/VM/session identifiers and exclude prompts and known secrets. `<DB_PATH>.log` rotates at approximately 1 MiB to one backup. SQLite retains the audit event history; its backup/retention is an operator responsibility. Guest service output uses journald; configure its storage limits in the external snapshot. MCP log retrieval returns at most 100 events and a 16 KiB service tail.

Persisted events remain accessible through `get_worker_logs` after VM destruction and during provider outages. Its `opencode` field is null when the guest tail is unavailable, paused, or undergoing a control operation; observation does not intentionally resume a guest.

Monitor preserved artifact throughput, `swarmforge_finalizations{state="failed"}` and workers stuck in `pending` or `collecting`. A `failed` finalization keeps its VM for inspection and `retry_worker_finalization`; `swarmforge_artifacts_failed_total` distinguishes capture failures from artifacts that were deliberately abandoned by forced destruction. Artifact bytes themselves are only visible through the authenticated download route, never in metrics, logs or events.

The bounded `/events` SSE replay uses monotonically increasing event IDs and supports `Last-Event-ID`. Slow consumers can reconnect to retrieve subsequent batches. Monitor queued capacity, recovery-required workers, old pending control intents and external inference errors. No notification bus or metrics storage is embedded.

`wait_for_state_change` is the in-process counterpart of that replay: each waiting caller holds one in-memory listener on the store and is woken by the same committed event, so a blocked call neither polls the provider nor holds a worker lock. A timeout or a dropped request releases the listener, and cursors are event IDs that remain valid after a restart. Waiting is bounded per call and reports no metric label, worker payload or guest power state.
