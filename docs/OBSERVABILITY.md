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

Counters are reconstructed from SQLite, so server restarts preserve observed totals. Usage is keyed by worker/message and updates monotonically to deduplicate polling. Detailed worker/team/task usage appears in MCP status tools. OpenCode reporting is the accounting source; provider billing may use different definitions. Data unavailable after a guest failure cannot be reconstructed from the model provider.

Example PromQL:

```promql
sum(swarmforge_tokens_total)
sum by (team) (swarmforge_tokens_total)
sum(rate(swarmforge_tokens_total{direction="output"}[5m]))
sum by (state) (swarmforge_workers)
```

Structured transition logs contain team/task/worker/VM/session identifiers and exclude prompts and known secrets. `<DB_PATH>.log` rotates at approximately 1 MiB to one backup. SQLite retains the audit event history; its backup/retention is an operator responsibility. Guest service output uses journald; configure its storage limits in the external snapshot. MCP log retrieval returns at most 100 events and a 16 KiB service tail.

Persisted events remain accessible through `get_worker_logs` after VM destruction and during provider outages. Its `opencode` field is null when the guest tail is unavailable, paused, or undergoing a control operation; observation does not intentionally resume a guest.

The bounded `/events` SSE replay uses monotonically increasing event IDs and supports `Last-Event-ID`. Slow consumers can reconnect to retrieve subsequent batches. Monitor queued capacity, recovery-required workers, old pending control intents and external inference errors. No notification bus or metrics storage is embedded.
