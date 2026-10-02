# Final architecture review

Reviewed the implementation against the requested control-plane boundary and failure cases. The independent reviewer concentrated on lifecycle, SQLite and provider adapters; local review also exercised MCP, HTTP, artifact paths, secrets and real Git safety checks.

Material issues found and fixed:

- Completion and selecting a queued follow-up now commit together, preventing stranded work after a crash.
- Dispatch intent and running state now commit together; recovered sending turns are inspected instead of blindly replayed.
- Timeout/cancel/destroy stop the OpenCode service and its process group. VM pause is the fallback when service shutdown cannot be confirmed. Failed control operations retain retryable intent.
- Destruction inspects source persistence only after quiescing execution. Real Git tests cover dirty, untracked and local-only committed work.
- Reconciliation shares per-worker serialization with controls, re-reads pending intent after provider responses, and queries retained VMs concurrently to avoid linear timeout delays.
- Late-created VMs and owned orphans remain discoverable. Confirmed missing VMs preserve diagnostic IDs while releasing capacity.
- A follow-up accepted while a completed worker is paused becomes runnable on resume.
- OpenCode history is **bounded, not paginated**. The SDK's generated contract for 1.18.31 declares a `before` query key on `/session/{id}/message`, but the live server rejects it with HTTP 400 and offers no offset or cursor, so older pages are unreachable. The adapter therefore requests exactly one page: the newest **100** messages, falling back once to **20** if that bound is also rejected, and degrading to **status-only** (an empty message window, status still authoritative) if both are. Accepted: a full page proves older history exists and is unread, and **usage for those unseen older messages cannot be backfilled later** — the window is a per-inspect read, not a durable index. Matching assistant parent IDs still establish accepted dispatches, and the newest assistant reply of the current dispatch is found from the last element of the ascending-chronological page, which is the order the server returns.
- Creation request retries remain idempotent even when the queue is full.
- Structured results have a total size bound; artifact contents use explicit bounded resource reads with path checks and credential screening.
- A follow-up Luna review found log retrieval incorrectly required a live VM. Durable events now remain available after destruction and provider failures, and paused guests are not queried with remote commands. Regression tests cover these cases.

No Git hosting, repository identity management, model serving, GPU scheduler, team strategy, external database or metrics storage was introduced. Provider routes are attached to VM lifetime. OpenCode owns sessions; the external snapshot owns its prerequisites.

Operational limits remain explicit: one process per local database, external snapshot and inference compatibility, conservative Git durability heuristics, and estimated inference activity. Artifact storage, native streaming retrieval, finalization, and the manager APIs are integrated. Preserved artifacts outlive their VM. During a provider outage SwarmForge cannot guarantee immediate guest shutdown or file retrieval; it preserves state and retries control operations. Ambiguous prompt delivery requires lead inspection. Independent deployments must use distinct stable instance IDs.

The automated suite covers actual MCP client calls, HTTP authentication/origin handling, SQLite reopening, provider SDK request/response contracts, lifecycle/recovery failure cases, metrics and real Git commands. The real Freestyle/OpenCode/model smoke flow is opt-in. The artifact smoke runs the production guest helper as a local subprocess with OpenCode unavailable, then verifies stored bytes after deleting the workspace. A separate credentialed Freestyle proof exercises native VM transfer and normal destruction. See the release validation report for executed commands and results.
