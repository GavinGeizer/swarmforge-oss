# Architecture

See the [Phase 1 product architecture](architecture/phase-1-summary.md) for the
code-supported audit, edition matrix, identity/tenant boundaries, entitlement and
cloud API contracts, deployment constraints, and implementation order. Hosted
capabilities there are proposed; this document describes the current coordinator.

```text
Trusted team leads → MCP /mcp → Coordinator → WorkerProvider → Freestyle VM
                                │                            OpenCode → external model
                                ├→ SQLite                    external Git tree
                                └→ private artifact storage ← secure guest helper
Metrics /metrics ← persisted usage, worker states, artifact records and finalization
```

`config.ts` validates deployment input. `store.ts` owns atomic SQLite mutations. `coordinator.ts` owns the durable queue, per-worker serialization, external operation deadlines and lifecycle reconciliation. `providers/freestyle.ts` uses the current VM SDK; `providers/opencode.ts` uses the generated v2 OpenCode client. `mcp.ts` exposes coherent operations; `files.ts` bounds live file retrieval; `artifacts.ts` preserves and stores worker output. No worker reasoning or infrastructure provisioning beyond VMs and their provider-owned route is implemented.

## Lifecycle

`queued → provisioning → booting → ready → running ↔ waiting → completed/failed`.

An active dispatch may be paused/resumed, cancelled with the VM retained, or explicitly destroyed. Unsafe cleanup and ambiguous delivery become `recovery_required`. Follow-ups reuse the stored session and are queued until the current turn finishes. Failed workers with an existing session can receive a follow-up, restarting the service while keeping context.

The database stores workers, team/task ownership, dispatches, results, transitions and message-level usage. Dispatch claim plus running state are atomic. Completion plus selection of the next queued turn are atomic. Duplicate completion does not duplicate events or tokens. Creation can be deduplicated with a caller-supplied `request_id` scoped to a team. Every committed event also wakes in-memory waiters, so `wait_for_state_change` blocks on the same durable log the SSE replay serves without polling or holding a per-worker lock.

## Restart and partial failures

Startup lists provider VMs tagged with the stable instance ID. Matching worker metadata reconnects VMs whose creation response was lost. Saved VM IDs are queried; missing VMs become failed/lost while their identifiers remain available for diagnosis and capacity is released. Booting workers resume initialization; saved OpenCode sessions are retained, and deterministic session titles recover a session created just before a crash.

Active sessions are polled again. A sending dispatch is inspected by stable message ID before any decision about execution. If delivery cannot be established, it requires inspection instead of blindly replaying a potentially mutating task. `/session/status` is polled for every session on the server and lists only sessions with work, so a session it does not list is the normal shape of a finished turn and is read as idle. A reported status type this version does not recognize is read as unknown instead, which never settles a turn and leaves it to the no-progress budget. Message history never decides the status: an assistant message without a completion timestamp is left behind by a restart, an OOM or an abort, and the inference gauge estimates from incomplete messages alone. Periodic reconciliation catches late-created VMs and adopts unknown owned VMs into visible recovery records without deleting them. Orphans with lost credentials are retained for filesystem/provider inspection.

Transient provider/startup failures retry within deadlines. Timeouts stop the OpenCode systemd service and its process group; if that fails, the VM is paused. If neither can be confirmed, the operation remains retryable. Results are validated from OpenCode first, then a matching-run `result.json`. Malformed output is never silently treated as success.

## Destruction and durability

No automatic destruction occurs on completion or failure. Normal destruction stops OpenCode and checks Git status, untracked files and local commits absent from remote refs in the configured workspace and reported working directory. `.swarmforge` output is excluded. Unverifiable or local-only work blocks cleanup. `force=true` explicitly bypasses this protection.

Non-source artifacts survive destruction because they are copied into private coordinator storage before it happens. Preservation is a separate durable stage from the task outcome: it runs after completion, abnormal failure, cancellation and before normal destruction, and it must settle successfully before a worker without `force` can be destroyed. A failed or abandoned stage reports `recovery_required` and keeps the VM; `force=true` records the stage as abandoned before deleting the guest. Remote refs are a conservative hint, not proof that every branch was durably pushed. Files outside declared workspaces and unusual external mounts require operator care. Source durability belongs to the external Git tree.

## Artifact capture

A small trusted guest helper opens workspace paths descriptor-relatively with `O_NOFOLLOW` and copies bounded regular files into private staging while computing SHA-256, or produces a bounded regular-file-only `tar.gz` snapshot. The helper returns metadata only; file bytes travel over the existing binary filesystem transport, never through command output or base64 reconstruction, and no model participates. The coordinator records every artifact durably, verifies length and checksum before a record is visible as preserved, and keeps repeated captures of the same worker, run, path and content idempotent. Model-facing reads stay bounded and credential screened, with terminal escapes removed so log files read as text; raw bytes are an explicit authenticated HTTP operation whose advertised range always matches the bytes delivered. Capture responses are budgeted by serialized bytes and always report their total and truncation, so a large collection is never lost to a response ceiling. [ARTIFACTS.md](ARTIFACTS.md) documents states, limits, roots, security and the end-to-end flow.

## Deployment boundary

One Linux process owns a database; no shared-database multi-host deployment. Freestyle slugs and ownership metadata must not be reassigned by other operators. The provider creates a TLS route tied to the VM, protected by an independent OpenCode password; no provider management credential enters worker configuration. Trusted leads share bearer access; teams are labels, not security tenants. External TLS, storage backup, inference capacity and metrics storage stay outside SwarmForge. Artifact storage is private to the coordinator process and shares its bearer access; its backup and retention are operator responsibilities.
