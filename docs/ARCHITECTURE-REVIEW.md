# Final architecture review

## Credential and source handoff corrections — 2026-10-06

This follow-up covers credential handling and the Git clean-state predicate. Each issue was reproduced with a failing regression before applying its correction:

- Excerpt sanitization now redacts both intact credentials and credentials reconstructed by deleting invisible characters, before truncating the display. Tests cover controls, zero-width/BOM/bidi characters, model keys, and guest passwords.
- Plain configuration diagnostics and provenance use redaction before and after control removal, preventing the same reconstruction bug in settings output.
- The CLI client now retains its resolved credential context for every endpoint display, tool error, connection error, and close error. Dashboard refreshes and internally handled errors receive sanitized text without relying on the first frame's redaction.
- Artifact screening derives its overlap from every known credential and its raw, URL-encoded, and base64 forms in bytes. Long bearer tokens and multibyte/encoded keys can no longer evade the screen merely by crossing a requested chunk boundary.
- Git handoff requires `git status` to exit successfully before checking for an empty status. A real corrupt-index regression confirms no branch is published and temporary credentials are cleaned up; clean and dirty repository cases remain covered.

Regression evidence is in `tests/excerpt.test.ts`, `tests/inspect.test.ts`, `tests/cli-redaction.test.ts`, `tests/api.test.ts`, and `tests/git-handoff.test.ts`. Tests use synthetic credentials, disposable local Git repositories, and an isolated loopback MCP server. No real Freestyle VM or configured model/control-plane endpoint is contacted. This is a scoped follow-up, not closure of every earlier lifecycle or scalability finding.

## Original implementation review

Reviewed the implementation against the requested control-plane boundary and failure cases. The independent reviewer concentrated on lifecycle, SQLite and provider adapters; local review also exercised MCP, HTTP, artifact paths, secrets and real Git safety checks.

Material issues found and fixed:

- Completion and selecting a queued follow-up now commit together, preventing stranded work after a crash.
- Dispatch intent and running state now commit together; recovered sending turns are inspected instead of blindly replayed.
- Timeout/cancel/destroy stop the OpenCode service and its process group. VM pause is the fallback when service shutdown cannot be confirmed. Failed control operations retain retryable intent.
- Destruction inspects source persistence only after quiescing execution. Real Git tests cover dirty, untracked and local-only committed work.
- Reconciliation shares per-worker serialization with controls, re-reads pending intent after provider responses, and queries retained VMs concurrently to avoid linear timeout delays.
- Late-created VMs and owned orphans remain discoverable. Confirmed missing VMs preserve diagnostic IDs while releasing capacity.
- A follow-up accepted while a completed worker is paused becomes runnable on resume.
- OpenCode history is paginated for usage recovery beyond 100 messages; matching assistant parent IDs also establish accepted dispatches.
- Creation request retries remain idempotent even when the queue is full.
- Structured results have a total size bound; artifact contents use explicit bounded resource reads with path checks and credential screening.
- A follow-up Luna review found log retrieval incorrectly required a live VM. Durable events now remain available after destruction and provider failures, and paused guests are not queried with remote commands. Regression tests cover these cases.

No Git hosting, repository identity management, model serving, GPU scheduler, team strategy, external database or metrics storage was introduced. Provider routes are attached to VM lifetime. OpenCode owns sessions; the external snapshot owns its prerequisites.

Operational limits remain explicit: one process per local database, external snapshot and inference compatibility, conservative Git durability heuristics, artifacts retained only with their VM, and estimated inference activity. During a provider outage SwarmForge cannot guarantee immediate guest shutdown; it preserves state and retries control operations. Ambiguous prompt delivery requires lead inspection. Independent deployments must use distinct stable instance IDs.

The automated suite covers actual MCP client calls, HTTP authentication/origin handling, SQLite reopening, provider SDK request/response contracts, lifecycle/recovery failure cases, metrics and real Git commands. The real Freestyle/OpenCode/model smoke flow is opt-in and is not claimed as executed without infrastructure credentials.
