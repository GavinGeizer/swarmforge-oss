# Task progress and operator workflows

The global `swarmforge` command provides these features through a running server. Restart `swarmforge serve` after upgrading and reconnect MCP clients to load new tools. Viewing templates and running ordinary doctor checks are local operations.

## Progress, results and recovery

The interactive status overview starts with a chibi mascot and live swarm totals. Press **Tab** in the overview to toggle the technical dashboard, retaining the selected worker, filters, sorting, and page. Both presentations use the same inspection, cleanup, artifact, and notification controls. Narrow or short terminals use a compact summary; `NO_COLOR=1` selects ASCII art. Tasks are assigned through MCP, with no chat bar in the dashboard. Attention and recent-completion expressions use workers on the loaded page; running, waiting, queued, completed, and failed counts describe the entire swarm, as does recovery-required attention.

In `swarmforge status`, select a worker and press Enter. The detail view includes queue/run timing, last lifecycle or dispatch/token activity, the latest response, preserved artifact count, result summary, changed files, reported test outcome, Git branch/commit/review URL, warnings and requested follow-up.

Recovery guidance is derived from current lifecycle and preservation state. Cancelled workers require a replacement; failed workers need a retained VM and session before follow-up messages are suggested. Missing/destroyed VMs retain their persisted results and preserved artifacts, but their workspace cannot be recovered from this metadata. Preservation failures offer `retry_worker_finalization`; pending control actions must settle before another control is requested.

Use PgUp/PgDn to scroll long details. In the overview, the selected worker shows its response activity or bounded completion summary. These are reports from the worker, not an independent verification of its claims.

## Explicit live readiness checks

```bash
swarmforge doctor                    # local only
swarmforge doctor --live --json      # snapshot access and a model tool-call probe
swarmforge doctor --live --vm <vm-id> # additionally inspect an existing running VM
```

`--live` makes remote requests and a small inference request (up to 64 requested output tokens); provider billing may apply. No VM is created or resumed. Provider and model probes each have an overall maximum 30-second deadline (or the shorter configured API timeout), bounded response bodies, credential-redacted diagnostics, and redirect refusal.

The model probe checks the configured OpenAI-compatible `/chat/completions` endpoint with a required tool call. Snapshot metadata access proves accessibility, not VM creation permissions or snapshot contents. `--vm` requires an existing running VM whose snapshot ID matches the configured snapshot. It checks OpenCode, Python 3, Git, running systemd, and writable workspace. Git push permissions and complete worker execution remain unverified. Failures return exit code 1; warnings identify capabilities the probe cannot establish.

## Usage estimates and budgets

```bash
swarmforge usage --json
swarmforge usage --worker <worker-id>
```

Measured token categories come from persisted OpenCode reports. Configure rates explicitly; none are inferred from a pricing website:

```dotenv
SWARMFORGE_INPUT_USD_PER_MILLION=1.00
SWARMFORGE_OUTPUT_USD_PER_MILLION=4.00
SWARMFORGE_REASONING_USD_PER_MILLION=4.00
SWARMFORGE_CACHE_READ_USD_PER_MILLION=0.10
SWARMFORGE_CACHE_WRITE_USD_PER_MILLION=1.25
SWARMFORGE_VM_USD_PER_HOUR=0.20
SWARMFORGE_BUDGET_USD=25
```

These are example rates, not provider prices. Token rates apply only to the currently configured exact model name. Categories with no rate and usage from other model names remain unpriced; `priced_tokens`, `measured_tokens`, and `complete` expose partial coverage. A configured zero is a valid free rate. Retained VM hours include paused time, start at the earliest recorded VM boot, and stop at destruction/missing-VM detection. Legacy records without boot events use the available timestamps. Runtime is an estimate from observation, not a provider invoice.

`SWARMFORGE_BUDGET_USD` applies to the deployment's retained history at current configured rates. Crossing it produces one durable alert per crossing/threshold. It is an alert threshold, not a spending limit. Repricing history can change an estimate; it does not change provider charges. Output and reasoning rates must reflect the provider's accounting conventions.

## Retention preview, reminders and automatic expiry

```bash
swarmforge retention preview --json
swarmforge retention preview --offset 20 --limit 20
```

The preview is read-only and works even while policies are off. Configure:

```dotenv
SWARMFORGE_RETENTION_MODE=remind
SWARMFORGE_RETENTION_SECONDS=86400
```

Modes are `off` (default), `remind` (emit cleanup-due notifications), and `auto` (attempt normal destruction after the grace period). The grace period starts after the latest settled lifecycle activity and successful artifact finalization. A worker qualifies only when its task is settled, its outputs are preserved, and it has no pending message/control action. Active, paused and unpreserved workers stay protected.

The coordinator processes at most 20 retained workers per maintenance page, about once every 30 seconds, separately from lifecycle processing. Admission rechecks current eligibility and expiry before claiming destruction. Git safety still runs; refusal leaves the VM retained, emits a blocked alert, and delays retries for at least five minutes. Changing to `auto` is an explicit configuration choice that enables deletion of eligible VMs; review the preview first. Preserved coordinator artifacts are not deleted by VM retention.

## Durable notifications

```bash
swarmforge notifications list --limit 20
swarmforge notifications watch --cursor 123 --json
swarmforge notifications list --team default --task my-task
```

Notifications include task completion/failure/cancellation, recovery-required and waiting states, explicit result follow-up requests, preservation success/failure, cleanup due/blocked/success, and estimated budget crossings. Pagination is by durable event ID. Save `next_cursor` and supply it on the next call. Keep the same filters when resuming a cursor; changing filters requires a new cursor. `has_more` tells a watcher to drain another page immediately. Watch polls every two seconds and stops on Ctrl+C/SIGTERM. It replays retained history from cursor 0 unless you supply a cursor.

In the dashboard press `n` from the overview for the inbox; `[`/`]` page through notifications and `r` refreshes. These alerts stay in the local event log. External email/chat/webhook delivery is not configured.

## Reusable task templates

```bash
swarmforge templates list
swarmforge templates show code --prompt 'Add pagination to the results endpoint'
swarmforge templates show review --json
```

Built-ins: `code`, `review`, `research`, `docs`. Each provides instructions and a required Markdown deliverable under `.swarmforge/artifacts`. Rendering a template works without credentials or a server and does not create a worker.

MCP `spawn_worker` accepts `template` alongside the usual explicit `task_id`, `prompt`, optional `request_id`, and artifact declarations:

```json
{"task_id":"pagination-review","template":"review","prompt":"Review the pagination changes","request_id":"pagination-review-v1"}
```

The recipe supplies its role when the default coder role is used and adds its required artifact without duplicating an existing declaration. Source/Git persistence and the normal structured result protocol still apply. Expanded prompts and declarations must fit normal spawn limits; idempotency fingerprints the expanded request.

## Artifact discovery and previews

```bash
swarmforge artifacts list --query summary --state preserved
swarmforge artifacts list --worker <worker-id> --kind file
swarmforge artifacts list --task my-task --offset 20
swarmforge artifacts preview <artifact-id> --length 4096
swarmforge artifacts preview <artifact-id> --offset 4096 --json
swarmforge artifacts download <artifact-id> --output ./deliverable.md
```

Search matches filename or original path, case-insensitively for ASCII, across workers unless scoped by worker/task. Kind/state filters apply before pagination. Preview is credential-screened plaintext, defaults to 4 KiB and is limited to 32 KiB per request. Binary data stays out of the preview; complete files use the authenticated, size/checksum-verified downloader. Existing destination files are refused.

In the overview press `a` to browse artifacts across workers; in worker details `a` scopes to that worker. `/` edits the filename/path query, `p` previews the selected artifact, `[`/`]` navigate pages or preview chunks, and Enter saves through the existing verified downloader. PgUp/PgDn scroll previews. Ordinary artifact listing falls back to the older `list_artifacts` tool when a server has not yet been restarted; search filters require the updated server.
