# Architecture

```text
Trusted team leads → MCP /mcp → Coordinator → WorkerProvider → Freestyle VM
                                │                            OpenCode → external model
                                └→ SQLite                    external Git tree
Metrics /metrics ← persisted usage and worker states
```

`config.ts` validates deployment input. `store.ts` owns atomic SQLite mutations. `coordinator.ts` owns the durable queue, per-worker serialization, external operation deadlines and lifecycle reconciliation. `providers/freestyle.ts` uses the current VM SDK; `providers/opencode.ts` uses the generated v2 OpenCode client. `mcp.ts` exposes coherent operations; `files.ts` bounds file retrieval. No worker reasoning or infrastructure provisioning beyond VMs and their provider-owned route is implemented.

## Lifecycle

`queued → provisioning → booting → ready → running ↔ waiting → completed/failed`.

An active dispatch may be paused/resumed, cancelled with the VM retained, or explicitly destroyed. Unsafe cleanup and ambiguous delivery become `recovery_required`. Follow-ups reuse the stored session and are queued until the current turn finishes. Failed workers with an existing session can receive a follow-up, restarting the service while keeping context.

The database stores workers, team/task ownership, dispatches, results, transitions and message-level usage. Dispatch claim plus running state are atomic. Completion plus selection of the next queued turn are atomic. Duplicate completion does not duplicate events or tokens. Creation can be deduplicated with a caller-supplied `request_id` scoped to a team. Every committed event also wakes in-memory waiters, so `wait_for_state_change` blocks on the same durable log the SSE replay serves without polling or holding a per-worker lock.

## Restart and partial failures

Startup lists provider VMs tagged with the stable instance ID. Matching worker metadata reconnects VMs whose creation response was lost. Saved VM IDs are queried; missing VMs become failed/lost while their identifiers remain available for diagnosis and capacity is released. Booting workers resume initialization; saved OpenCode sessions are retained, and deterministic session titles recover a session created just before a crash.

Active sessions are polled again. A sending dispatch is inspected by stable message ID before any decision about execution. If delivery cannot be established, it requires inspection instead of blindly replaying a potentially mutating task. `/session/status` is polled for every session on the server, so a session it does not list is treated as unknown rather than idle: only a settled turn, one with no incomplete message of that dispatch, is completed, and silence or a still-streaming turn is left to the no-progress budget. Periodic reconciliation catches late-created VMs and adopts unknown owned VMs into visible recovery records without deleting them. Orphans with lost credentials are retained for filesystem/provider inspection.

Transient provider/startup failures retry within deadlines. Timeouts stop the OpenCode systemd service and its process group; if that fails, the VM is paused. If neither can be confirmed, the operation remains retryable. Results are validated from OpenCode first, then a matching-run `result.json`. Malformed output is never silently treated as success.

## Destruction and durability

No automatic destruction occurs on completion or failure. Normal destruction stops OpenCode and checks Git status, untracked files and local commits absent from remote refs in the configured workspace and reported working directory. `.swarmforge` output is excluded. Unverifiable or local-only work blocks cleanup. `force=true` explicitly bypasses this protection.

Remote refs are a conservative hint, not proof that every branch was durably pushed. Files outside declared workspaces and unusual external mounts require operator care. Source durability belongs to the external Git tree. Non-source artifacts are available only while their VM is retained; collect them before deletion.

## Deployment boundary

One Linux process owns a database; no shared-database multi-host deployment. Freestyle slugs and ownership metadata must not be reassigned by other operators. The provider creates a TLS route tied to the VM, protected by an independent OpenCode password; no provider management credential enters worker configuration. Trusted leads share bearer access; teams are labels, not security tenants. External TLS, storage backup, inference capacity and metrics storage stay outside SwarmForge.
