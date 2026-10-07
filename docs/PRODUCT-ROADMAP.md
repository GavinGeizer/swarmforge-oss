# Product improvement list

Prioritized opportunities from a read-through of the implementation and operator documentation.

## Credential and Git handoff audit pass — implemented

- Prevent credential reconstruction after excerpt/diagnostic character cleanup.
- Retain client credential redaction across dashboard refreshes and error banners.
- Size artifact screening overlap for all known credential variants in bytes.
- Refuse Git handoff when the workspace status cannot be read successfully.
- Regression details: [architecture review](ARCHITECTURE-REVIEW.md).

## Durable artifact preservation — implemented

- Integrated `artifact-salvage-20261001` with global configuration, initialization, and standalone packaging.
- Added compiled local-guest coverage for preservation, safe destruction, restart, and authenticated artifact downloads.
- Dashboard shows preservation state, metadata, checksums, and retry actions.

## Next: lifecycle and operating-cost visibility

- Revalidate remaining lifecycle audit findings around pause/resume races, pending controls, deadlines, and result fallback.

## 1. Setup readiness checks — implemented

`bun run doctor` checks local configuration, Bun, database-directory access, and configured Git handoff files. It does not make network requests. Remote model compatibility and the contents of a Freestyle snapshot (including guest Git availability) still need an optional, explicitly invoked live check.

## 2. Worker cost and cleanup visibility — retained visibility and cleanup implemented

- Overview shows retained VM and cleanup candidate counts, with worker age and idle time in cleanup/details.
- Cleanup supports selection, a frozen preview, explicit confirmation, sequential normal destruction, and individual refusals.
- The server rechecks settled state, preservation, and pending work atomically before accepting batch cleanup; existing Git and artifact gates remain in force.
- Pricing estimates still need configured rates or provider billing data.
- Consider configurable cleanup reminders or retention policies after preserving work.

## 3. Task-first dashboard — search, filtering, and sorting implemented

- Search worker/task IDs; filter exact team/task, worker state, preservation state, and retained VMs.
- Sort by recent activity, longest idle time, or oldest worker.
- Active filters apply to cleanup selection and preview; hidden and ineligible selections are cleared.
- Show queue time, current progress, last activity, errors, and useful result summaries.
- Improve artifact browsing and expose safe lifecycle actions in the detail view.

## 4. Bounded dashboard reads and operator regression coverage — implemented

- SQLite filters/sorts worker pages and supplies cached global aggregates; the interactive view loads 50 workers at a time with explicit history navigation.
- Revision polling skips unchanged transfers, applies changed-worker deltas, and resynchronizes after query changes, cache eviction, or coordinator replacement.
- Credential catalogs and encoded variants are cached by database/configuration revision; rollbacks invalidate transactional cache state.
- Local regressions cover cleanup selection, stale eligibility, duplicate confirmation, interrupted requests, quitting a batch, older servers, and 10,000-worker history.
- Push/PR CI runs static checks, local regression/compiled tests, and a build.
- Remaining scaling work: lifecycle reconciliation still reads full history; substring search, counts, and aggregate rebuilds still require SQLite scans as history grows. Historical `status --json` is intentionally a complete export.

## 5. First-worker onboarding and documentation — implemented

- `swarmforge init` prompts for the six required infrastructure fields and writes private local configuration.
- Checkout setup builds and installs the global executable and prints PATH/reload guidance.
- README walks through prerequisites, installation, initialization, diagnostics, server startup, MCP connection, a first task, result/artifact collection, and cleanup.
- Model and snapshot live compatibility checks and a local provider demo remain future work.

## Artifact retrieval and agent plaintext workflow — implemented

- Paginated CLI artifact listing and authenticated streaming downloads with size/SHA-256 verification, atomic publication, and overwrite refusal.
- Dashboard artifact browser and local save action.
- Live and preserved plaintext readers plus server/agent guidance, avoiding base64/Python reconstruction for ordinary text.

## Operator workflows — implemented

- Task progress, bounded completion summaries, changed-file/test/Git/follow-up details and contextual recovery guidance.
- Explicit `doctor --live` model/snapshot probes and optional existing-VM prerequisite checks; no automatic provisioning.
- Disabled-by-default retention policies with read-only previews, reminders and guarded automatic expiry.
- Configured USD estimates, measured token coverage, retained VM runtime and budget alerts.
- Local task templates with required deliverables and optional MCP spawn recipes.
- Cross-worker artifact search and bounded plaintext preview through CLI/dashboard.
- Durable cursor-based notifications, CLI watch and dashboard inbox.
- Full usage and limitations: [Operator workflows](OPERATOR-WORKFLOWS.md). Progress/checklist: [implementation plan](superpowers/plans/2026-10-07-operator-workflows.md).
