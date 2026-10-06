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

## 4. Efficient status updates at scale

- Add a server-side overview summary and filter/cursor support so clients do not fetch every retained worker.
- Use lifecycle events to update active workers between less frequent full refreshes.
- Keep historical worker listing available for explicit browsing.

## 5. First-worker onboarding and documentation — implemented

- `swarmforge init` prompts for the six required infrastructure fields and writes private local configuration.
- Checkout setup builds and installs the global executable and prints PATH/reload guidance.
- README walks through prerequisites, installation, initialization, diagnostics, server startup, MCP connection, a first task, result/artifact collection, and cleanup.
- Model and snapshot live compatibility checks and a local provider demo remain future work.
