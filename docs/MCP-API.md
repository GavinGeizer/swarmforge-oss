# MCP API

Streamable HTTP: `POST /mcp`. Supply the configured bearer token. Standard MCP SDK initialization and tool calls are supported. GET/DELETE MCP session operations return 405 because transport sessions are stateless. Worker IDs and OpenCode sessions remain persistent across client connections.

| Tool | Arguments | Result |
| --- | --- | --- |
| `spawn_worker` | `task_id`, `prompt`; optional `team_id="default"`, `role="coder"`, `timeout_seconds`, `request_id` | Worker ID, ownership, initial queued state; provisioning is asynchronous. |
| `get_worker` | `worker_id` | State, IDs, timestamps, error, pending control/messages, token usage. While a turn is active, a bounded single-line excerpt of the latest assistant text plus `excerpt_partial` and `excerpt_at`; absent once the worker settles. |
| `list_workers` | Optional `team_id`, `task_id`, `state`, `offset=0`, `limit=20` | Paginated metadata; total and next offset. |
| `send_worker_message` | `worker_id`, `message` | Durable queued run ID; same OpenCode context. |
| `pause_worker` | `worker_id` | State/metadata after pause or pending intent. |
| `resume_worker` | `worker_id` | Resume paused worker and suspended timeout budget. |
| `cancel_worker` | `worker_id` | Stops execution, cancels queued turns, retains VM. |
| `destroy_worker` | `worker_id`, optional `force=false` | Permanent deletion or recovery-required refusal; provider failures retain retryable intent. |
| `get_worker_result` | `worker_id`, optional `run_id` | Latest matching persisted result, or null. Survives destruction. |
| `get_worker_logs` | `worker_id`, optional `after=0`, `limit=50` | Events plus bounded OpenCode service log tail. |
| `list_worker_artifacts` | `worker_id`, optional `directory=""`, `offset=0`, `limit=20` | Relative directory entries of `.swarmforge/artifacts` without file contents. |
| `get_worker_artifact` | `worker_id`, `path`, optional `offset=0`, `length=32768` | Resource link, byte size, range, next offset. |
| `list_artifacts` | Optional `worker_id`, `task_id`, `state`, `offset=0`, `limit=20` | Preserved artifact metadata; total pages and next offset. Never contents. |
| `get_artifact_metadata` | `artifact_id` | One artifact's size, checksum, state, attempts, origin and timestamps. |
| `preserve_artifact` | `worker_id`, `path`, optional `kind="file"`, `run_id` | Captures a file, or a directory with `kind="directory"`, into coordinator storage. Returns `{artifacts, truncated}`. |
| `read_artifact` | `artifact_id`, optional `offset=0`, `length=32768` | Bounded, credential-screened text excerpt plus `binary`, `returned_bytes`, `next_offset` and `download_path`. Binary content returns metadata only. |
| `snapshot_worker` | `worker_id`, optional `paths`, `run_id` | Archives the workspace into one verified `tar.gz` artifact; `.git` and `node_modules` excluded. |
| `retry_worker_finalization` | `worker_id` | Retries collection for a retained worker and reports its finalization state and preserved artifacts. |
| `list_worker_files` | `worker_id`, optional `path=""`, `offset=0`, `limit=20`, `max_depth=4` | Live workspace directory entries without contents; traversal and symlinks refused. |
| `get_task` | `task_id`, optional `team_id="default"` | Worker state counts and token usage for that task. |
| `list_tasks` | Optional `team_id`, `offset=0`, `limit=20` | Persistent task ownership metadata. |
| `get_team_status` | `team_id` | Aggregate state counts and usage. |
| `get_swarm_status` | None | Aggregate states, tokens, configured capacity, metrics listener status, inference estimate. |
| `wait_for_state_change` | Optional `worker_id`, `team_id`, `task_id`, `states`, `cursor`, `timeout_ms=10000` (max 25000, `0` checks once) | Next matching lifecycle transition, or `changed=false` on timeout. |

IDs accept alphanumerics, `_ . : -`, up to 128 characters. Prompts/messages are at most 32,000 characters. Per-spawn timeout is 1–604,800 seconds. Lists allow at most 100 entries; worker message queues allow 100 pending turns. Timestamps are Unix epoch milliseconds. Tool failures set `isError`; provider failures during asynchronous work appear in worker metadata. Artifact paths are workspace relative and at most 1024 bytes and 32 components deep; a spawn may declare at most 100 `artifacts` paths.

`wait_for_state_change` blocks on the durable event log instead of polling, and reads no guest or provider state. It reports worker lifecycle transitions only: a creation is the `queued` transition, and a resume is reported through the state transition it performs. Omit `cursor` to start at the newest event and wait for future transitions; pass a previous `next_cursor` to replay the first matching event after it. Ownership filters (`worker_id`, `team_id`, `task_id`) and `states` are combined; events that do not match are consumed without being returned, and a `states` list restricts wakeups. `changed` is `true` with `event_id`, `next_cursor`, `worker_id`, `team_id`, `task_id`, `vm_id`, `state` and `at`, or `false` with the same fields null and a `next_cursor` that the next call can resume from. A wait holds no worker lock, so concurrent callers, coordinator passes and control operations continue; a caller that disappears releases its listener. The reported `state` is the durable lifecycle state, `vm_id` is the recorded VM identifier and neither is a live power state; event payloads, prompts and secrets are never returned. A cancelled or disconnected request ends the wait with a tool error.

Creation retries should reuse the same `request_id` and arguments. Reusing the key with different arguments is rejected. Follow-up messages are separate turns, not interrupts; cancel or pause explicitly when needed. Cancellation makes a worker unavailable for further prompts. A pending lifecycle control operation can finish on the next coordinator pass.

Artifact resource URIs look like `swarmforge://workers/<id>/artifacts/<encoded-path>?offset=0&length=32768`. Explicitly call MCP `resources/read` for that URI. Responses contain base64 blobs of at most 32 KiB. Use subsequent offsets to download large files without placing them all in model context. Traversal and symlink paths are rejected; detected credentials block file content retrieval. Tools do not export guest configuration or arbitrary filesystem paths.

Preserved artifacts are a second, durable surface described in [ARTIFACTS.md](ARTIFACTS.md). `list_artifacts`, `get_artifact_metadata` and `read_artifact` are read-only; `preserve_artifact`, `snapshot_worker` and `retry_worker_finalization` change worker or storage state. Inline reads never return more than 32 KiB, never return binary payloads, and refuse artifact content that contains a configured credential; every response carries the `download_path` of the authenticated raw route. `get_artifact_metadata` and `list_artifacts` expose only a fixed public projection, so storage locations and transfer internals are never returned.

`GET /health` provides liveness. `GET /events?after=<event-id>` returns a bounded SSE replay; reconnect with `Last-Event-ID` to continue. These endpoints use the same bearer access as MCP. Events describe durable lifecycle changes and do not contain prompts. `wait_for_state_change` observes the same event ids in memory, so a cursor taken from one of these surfaces stays meaningful after a restart.

`GET /artifacts/<artifact_id>/download` returns raw artifact bytes under the same host, allowed-host, bearer and origin checks. It answers only `GET`, sends `application/octet-stream` with `Content-Disposition: attachment`, `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`, and advertises `Accept-Ranges: bytes`. One `Range` header is honoured: multi-range, reversed, non-numeric and unsatisfiable requests get `416` with `Content-Range: bytes */<size>`, and a single response streams at most 8 MiB, so large artifacts are fetched in follow-up ranges. An unknown artifact is `404`, an artifact that is not preserved is `409`, and a caller that already disconnected receives nothing. Artifact bytes are never served from a `GET` on a tool, never inlined into a browser and never included in an error body.

Response excerpts are live status only. They reuse the existing session poll, are capped at 180 characters on a single sanitized line, redact configured secrets, and are cleared when a turn settles or a new dispatch starts. They are never written to events, metrics, SQLite, or `list_workers`.
