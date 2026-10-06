# Product improvement list

Prioritized opportunities from a read-through of the implementation and operator documentation.

## 1. Setup readiness checks — implemented

`bun run doctor` checks local configuration, Bun, database-directory access, and configured Git handoff files. It does not make network requests. Remote model compatibility and the contents of a Freestyle snapshot (including guest Git availability) still need an optional, explicitly invoked live check.

## 2. Worker cost and cleanup visibility

- Show retained VM count, age, and estimated spend in the status view.
- Make artifact collection and safe cleanup easy to find before destroying a VM.
- Consider configurable cleanup reminders or retention policies after preserving work.

## 3. Task-first dashboard

- Add search and filters for team, task, worker state, and age.
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
