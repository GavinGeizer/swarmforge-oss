# Operator workflows implementation plan and progress

**Goal:** Make task progress, readiness, recovery, operating costs, reusable tasks, artifact discovery, and completion alerts accessible through the existing global CLI, MCP server, and terminal dashboard.

**Execution:** Implement sequentially in this checkout. Preserve unrelated working-tree changes. Update this checklist after each delivered feature. No real SwarmForge/model/Freestyle endpoint calls during development; live diagnostics remain an explicitly invoked operator command. Do not restart the running deployment automatically.

## Design decisions

- Reuse durable worker, dispatch, usage, artifact, and event records; avoid a second source of truth.
- Keep summaries bounded, redact remote responses, and use paginated queries.
- Readiness: local doctor remains local; `doctor --live` checks provider snapshot access and model tool-call compatibility. An optional existing VM permits guest prerequisite checks without provisioning.
- Retention: default off, optional reminder/preview or automatic expiry. Only settled workers with preserved outputs and no pending work qualify. Normal destruction still enforces Git safety. Preview is read-only.
- Recovery: actionable explanations and supported next actions; never imply a missing workspace can be recovered or silently retry failed tasks.
- Costs: runtime and measured token categories, optional configured rates, explicit estimates and coverage. Budget is an alert threshold, not a billing total or hard spending limit.
- Templates: built-in code, review, research, documentation recipes with deliverables; render locally and optionally use in MCP spawn. No automatic dispatch from viewing a template.
- Artifacts: server-side filename/path/kind/state filtering across workers; bounded credential-screened text preview and existing verified binary download.
- Notifications: durable event-based inbox with cursor pagination and CLI watch; include failures, completion, waiting, preservation failures, retention reminders, and budget alerts. No external messages or webhooks enabled by default.

## Ordered implementation checklist

- [x] 1. Task progress and completion summaries
  - Add queue/run/idle timing, progress source, last meaningful activity, compact persisted result, changed-file/test/Git/follow-up information, and artifact count to worker views.
  - Show useful progress/summary rows and result/recovery sections in the dashboard.
- [x] 5. Failure recovery guidance
  - Derive recovery actions from lifecycle, VM presence, finalization, pending controls, and results.
  - Expose guidance in worker views and detail dashboard, with durable artifact access after destruction.
- [x] 6. Usage and budget visibility
  - Add configurable per-million token and VM-hour rates plus optional USD budget threshold.
  - Expose per-worker/global usage estimates, runtime, missing-rate coverage, and budget state; display in dashboard.
- [x] 4. Retention policies
  - Add disabled/remind/auto policy plus settled-age grace period, bounded preview MCP/CLI command, and periodic guarded processing.
  - Persist reminder and refusal events without repeated warnings every poll; keep active/paused/unpreserved VMs protected.
- [x] 10. Completion notifications
  - Expose a bounded durable event feed with filters and resumable cursor.
  - Add `notifications list/watch`, cancellation, and dashboard inbox. Persist budget/retention reminders.
- [x] 7. Task templates
  - Add built-in recipe catalog and local `templates list/show` CLI.
  - Support optional template in `spawn_worker` while preserving request idempotency and explicit artifact declarations.
- [x] 9. Artifact previews and search
  - Extend server artifact pagination with filename/path query and kind/state filters.
  - Add CLI search/preview and dashboard search/preview, retaining atomic checksum-verified saves.
- [x] 3. Optional live readiness check
  - Add explicit bounded provider/model probes, redacted errors, optional existing-VM prerequisite check, and CLI flags/help.
  - Do not run these probes against the configured deployment during implementation.
- [ ] Finish: documentation, static checks, build/install global binary, commit/push, and inspect CI.

## Validation policy

Run static/type checks and build checks. No new or local test execution unless requested; existing GitHub CI runs on push. Document any unverified live behavior accurately. Review destructive-action admission, stale selections, credential redaction, pagination, rate accounting, and abort handling before publication.

## Progress log

- 2026-10-07: Inspected existing worker/result/usage/event contracts, doctor, cleanup gates, artifact repository, dashboard/client, and settings loader. Implementation begun; all eight requested additions tracked above.

- 2026-10-07: Implemented all eight feature entries. Added five MCP tools (31 total), local/global CLI commands, dashboard result/recovery/usage details, inbox, cross-worker artifact search/preview and scrolling.
- Review corrections: VM estimates use the first durable boot event and explicit missing-VM observation time; normal cleanup success requires destroyed state; expiry is rechecked atomically; provider probes share an overall deadline and refuse cross-origin polling URLs; artifact listing negotiates older-server support; cancelled-worker guidance uses replacement workers; summary redaction precedes truncation; dashboard deltas exclude display clocks.
- Validation: TypeScript and Biome checks pass. Live probes were not invoked. No new tests were added or local test suite executed; the existing API tool-count assertion was updated to the new contract. Publication/build/CI pending below.
