# Swarmforge: 50-worker repository review

Reviewed commit: `d428e0f730ed5649485732e95d39c32f5d6a8895` on `feature/binary-config-serve-20260930`.
Team: `repo-review-50-20260930`.

## Outcome

Exactly 50 isolated, read-only Swarmforge reviewers were assigned distinct scopes across the repository. All 50 reports and finding files are preserved here. Forty-five original review runs completed within their deadlines; five exceeded the 30-minute deadline and needed report-only recovery. The HTTP-limits and artifact-path reports explicitly mark their scopes **INCOMPLETE**. The Git-persistence, worker-secrets, and config-discovery reports recovered their findings but did not deliver valid structured handoffs.

This was a repository audit, including pre-existing code. It is not only a review of the recent binary milestone. No implementation fixes, commits, merges, or releases were made by this review. The feature checkout remains clean; this directory contains the review deliverables in the original checkout.

All 50 review VMs are destroyed. The final Swarmforge inventory reports 167 destroyed workers across all teams, with no active or recovery-required workers. Reports were retrieved before destruction. For the missing handoffs, live VM Git checks confirmed clean trees at the baseline commit, also verified on the actual remote. The user explicitly authorized discarding the remaining VM data. See [completion.json](completion.json) and [final-inventory.json](final-inventory.json).

Final token usage for this review, including recovery and report-sanitization follow-ups: **193,180,704** reported tokens — 5,587,197 input, 2,921,111 output, and 184,672,396 cache-read tokens. The historical all-team total at cleanup was **453,981,497**. These are Swarmforge usage counters, not a billing estimate.

The raw reports contain **173 observations**: reviewer-assigned severities are 25 HIGH, 72 MEDIUM, and 76 LOW, with no CRITICAL. These are **not 173 unique confirmed bugs**. They include duplicate mechanisms, documentation discrepancies, coverage gaps, hardening recommendations, and rejected or unverified claims. Lead triage is in [lead-triage.json](lead-triage.json); raw observations are in [findings-raw.json](findings-raw.json).

## Highest-priority fixes

| Priority | Finding | Evidence and source |
| --- | --- | --- |
| High | Failed durable control intents wedge workers: task deadlines are bypassed and cancel/destroy cannot supersede the pending intent. | Lead reproduced with a persistently failing fake pause operation. [Deadline review](08-deadline-progress/review.md); `src/coordinator.ts:440,828`. Related races are reported by reviewers 02, 03, 04, 10, 26. |
| High | Git handoff can certify a clean tree when `git status` fails. | `test -z "$(git status ...)"` checks empty stdout and ignores the command failure. Lead reproduced that shell predicate; reviewer used real Git with a corrupt index and bare remote. [Persistence review](31-git-persistence/review.md); `src/providers/freestyle.ts:255`. |
| High | Sanitizing excerpts after redaction can reconstruct a known credential. | Lead reproduced with a zero-width character splitting a synthetic credential; sanitization removes the character after the redactor has missed it. [Token/excerpt review](30-opencode-tokens/review.md), [core redactor review](33-redactor-core/review.md); `src/security.ts:97`. |
| Medium | Interactive dashboard refresh and caught errors bypass credential scrubbing. | Two reviewers independently reproduced raw endpoint reappearance after refresh; dashboard error rendering also lacks credential scrubbing. [Client review](40-cli-status/review.md), [TUI review](42-cli-tui/review.md); `src/cli/tui.ts:56,77`. |
| Medium | A provider/inspect error can complete a still-busy turn from a matching result file. | Lead reproduced completion with no idle evidence. [Idle review](29-opencode-idle/review.md); `src/coordinator.ts:519`. |
| Medium | Artifact chunk screening misses part of an API token longer than its overlap window. | Lead reproduced 804 returned credential bytes with a synthetic 5000-byte token. Unusual credential length is a likelihood limitation. [Artifact screening](24-artifact-screening/review.md); `src/files.ts:94`. |
| High at accumulated history | Scrapes and response redaction synchronously block the shared event loop as retained history grows. | Three reviewers independently measured unindexed per-worker event scans; redaction also rereads the entire worker table for each string. [Metrics](43-metrics/review.md), [SQLite retention](12-sqlite-retention/review.md), [scale](50-architecture-scale/review.md), [event replay](13-event-replay/review.md). Timings are local synthetic measurements, not production benchmarks. |
| Medium | Prepare timeouts abandon operations without cancellation, allowing overlapping bootstrap retries. | Outer timeout is shorter than cumulative inner budgets; local fake-provider reproductions used the shipped ratios. [Provider creation](25-freestyle-create/review.md). |
| Medium | Long failed summaries can exceed the tool response cap and break `swarmforge status`. | Reviewer reproduced a 133473-byte worker page against the 131072-byte cap. [Overview](15-overview-queries/review.md); `src/mcp.ts:44`, `src/cli/client.ts:77`. |
| Medium | Archive verification does not enforce regular member types and follows symlinks; build-root metadata can describe a different entrypoint. | Reproduced with local hostile archives/build fixtures. This verifier intentionally runs its input executable and is not an authenticity mechanism; arbitrary-code claims alone overstate the new trust-boundary impact. [Archive](45-archive-verification/review.md), [build](44-build-runtime/review.md). |
| Medium | Quickstart, database migration defaults, and environment-file parsing disagree with documentation. | Explicit .env selection is required; ENVIRONMENT.md retains the old DB default; quoted values with trailing comments reject a documented example. [Install docs](47-install-docs/review.md), [parser](37-config-parser/review.md). |

Additional actionable observations include paused revival retaining stale dispatches, instance/lock aliasing, raw console event payloads, credential-bearing URL shapes, malformed upstream status response handling, mutable Git-base metadata, and relative-HOME fallback. Consult their scoped reports before designing fixes.

## What tested sound

- Independent full-suite verification: **262 passed, 1 skipped, 0 failed**, 1450 assertions, 21 files; TypeScript/Biome check clean across 55 files. The sole skip is the opt-in real cloud/model smoke. [Full-suite report](49-whole-suite/review.md).
- Core SQLite transaction boundaries rolled back correctly under injected failures. [Transaction report](11-sqlite-transactions/review.md).
- State wait subscription/cursor/cancellation cleanup showed no lost wakeups in bounded randomized and concurrent local probes. [Wait report](14-state-waits/review.md).
- Event replay reproduced 301/301 events without duplicates or missing events. [Replay report](13-event-replay/review.md).
- Lifecycle startup rollback and tracked write draining were sound on the tested paths. [Startup](17-serve-startup/review.md), [drain](18-serve-drain/review.md).
- The live metrics endpoint returned HTTP 200 and Prometheus data. The user withdrew the reported exporter failure; no deployment change was made.

Passing tests do not invalidate the adversarial findings. Mutation testing showed gaps around real CLI serve wiring, build/package command entrypoints, and artifact-listing provider shapes. [Test-quality report](48-test-quality/review.md).

## Lead validation and rejected claims

[lead-probes.ts](lead-probes.ts) and [lead-probes.log](lead-probes.log) preserve six local reproductions: long-token artifact screening, default-timeout idempotency, busy-file fallback completion, failed-intent deadline bypass, invisible-character credential reconstruction, and the failing-Git-status clean guard. They used synthetic credentials and fake providers. The probe imports point to the isolated integration checkout; update those paths when reproducing elsewhere.

Examples of triage decisions:

- `serve --check-config` is intentionally read-only settings validation; not checking live locks does not make it a broken readiness check.
- Repeated signals intentionally share one stop operation. A supervisor timeout shorter than the documented drain budget is operator configuration error.
- Public metrics exposure is documented and pre-existing, with loopback the default. It merits deployment hardening; an unauthenticated response alone does not establish a new HIGH-severity exploit.
- A malicious maintainer editing a tagged workflow is inside the release source trust boundary. No untrusted-contributor bypass was demonstrated.
- Conservative normal-destruction refusal for local-tree inputs is a compatibility bug; it is not demonstrated data loss.
- Reports 13/43/50 overlap on redaction and scrape complexity; reports 03/08 overlap on failed-intent wedges; reports 40/42 overlap on TUI endpoint redaction. Repetition is corroboration, not extra defects.

## Suggested next work

Use a small implementation wave with separate ownership for (1) lifecycle/control state and completion, (2) redaction/output boundaries, (3) Git handoff/persistence, and (4) data-query performance. Follow with independent reviews and regressions that fail on this exact commit. Packaging/config/documentation corrections can follow those foundations. No fixes are included in this audit.

## All reviewer reports

| Scope | Report | Structured findings |
| --- | --- | --- |
| 01-scheduler-admission | [Report](01-scheduler-admission/review.md) | [Findings](01-scheduler-admission/findings.json) |
| 02-dispatch-delivery | [Report](02-dispatch-delivery/review.md) | [Findings](02-dispatch-delivery/findings.json) |
| 03-worker-transitions | [Report](03-worker-transitions/review.md) | [Findings](03-worker-transitions/findings.json) |
| 04-pause-resume | [Report](04-pause-resume/review.md) | [Findings](04-pause-resume/findings.json) |
| 05-cancel-ordering | [Report](05-cancel-ordering/review.md) | [Findings](05-cancel-ordering/findings.json) |
| 06-destroy-durability | [Report](06-destroy-durability/review.md) | [Findings](06-destroy-durability/findings.json) |
| 07-startup-recovery | [Report](07-startup-recovery/review.md) | [Findings](07-startup-recovery/findings.json) |
| 08-deadline-progress | [Report](08-deadline-progress/review.md) | [Findings](08-deadline-progress/findings.json) |
| 09-result-validation | [Report](09-result-validation/review.md) | [Findings](09-result-validation/findings.json) |
| 10-followup-protocol | [Report](10-followup-protocol/review.md) | [Findings](10-followup-protocol/findings.json) |
| 11-sqlite-transactions | [Report](11-sqlite-transactions/review.md) | [Findings](11-sqlite-transactions/findings.json) |
| 12-sqlite-retention | [Report](12-sqlite-retention/review.md) | [Findings](12-sqlite-retention/findings.json) |
| 13-event-replay | [Report](13-event-replay/review.md) | [Findings](13-event-replay/findings.json) |
| 14-state-waits | [Report](14-state-waits/review.md) | [Findings](14-state-waits/findings.json) |
| 15-overview-queries | [Report](15-overview-queries/review.md) | [Findings](15-overview-queries/findings.json) |
| 16-process-locks | [Report](16-process-locks/review.md) | [Findings](16-process-locks/findings.json) |
| 17-serve-startup | [Report](17-serve-startup/review.md) | [Findings](17-serve-startup/findings.json) |
| 18-serve-drain | [Report](18-serve-drain/review.md) | [Findings](18-serve-drain/findings.json) |
| 19-http-auth | [Report](19-http-auth/review.md) | [Findings](19-http-auth/findings.json) |
| 20-http-origin | [Report](20-http-origin/review.md) | [Findings](20-http-origin/findings.json) |
| 21-http-limits | [Report](21-http-limits/review.md) | [Findings](21-http-limits/findings.json) |
| 22-mcp-contract | [Report](22-mcp-contract/review.md) | [Findings](22-mcp-contract/findings.json) |
| 23-artifact-paths | [Report](23-artifact-paths/review.md) | [Findings](23-artifact-paths/findings.json) |
| 24-artifact-screening | [Report](24-artifact-screening/review.md) | [Findings](24-artifact-screening/findings.json) |
| 25-freestyle-create | [Report](25-freestyle-create/review.md) | [Findings](25-freestyle-create/findings.json) |
| 26-freestyle-controls | [Report](26-freestyle-controls/review.md) | [Findings](26-freestyle-controls/findings.json) |
| 27-guest-bootstrap | [Report](27-guest-bootstrap/review.md) | [Findings](27-guest-bootstrap/findings.json) |
| 28-opencode-protocol | [Report](28-opencode-protocol/review.md) | [Findings](28-opencode-protocol/findings.json) |
| 29-opencode-idle | [Report](29-opencode-idle/review.md) | [Findings](29-opencode-idle/findings.json) |
| 30-opencode-tokens | [Report](30-opencode-tokens/review.md) | [Findings](30-opencode-tokens/findings.json) |
| 31-git-persistence | [Report](31-git-persistence/review.md) | [Findings](31-git-persistence/findings.json) |
| 32-git-injection | [Report](32-git-injection/review.md) | [Findings](32-git-injection/findings.json) |
| 33-redactor-core | [Report](33-redactor-core/review.md) | [Findings](33-redactor-core/findings.json) |
| 34-worker-secrets | [Report](34-worker-secrets/review.md) | [Findings](34-worker-secrets/findings.json) |
| 35-config-discovery | [Report](35-config-discovery/review.md) | [Findings](35-config-discovery/findings.json) |
| 36-config-precedence | [Report](36-config-precedence/review.md) | [Findings](36-config-precedence/findings.json) |
| 37-config-parser | [Report](37-config-parser/review.md) | [Findings](37-config-parser/findings.json) |
| 38-config-redaction | [Report](38-config-redaction/review.md) | [Findings](38-config-redaction/findings.json) |
| 39-cli-parser | [Report](39-cli-parser/review.md) | [Findings](39-cli-parser/findings.json) |
| 40-cli-status | [Report](40-cli-status/review.md) | [Findings](40-cli-status/findings.json) |
| 41-cli-diagnostics | [Report](41-cli-diagnostics/review.md) | [Findings](41-cli-diagnostics/findings.json) |
| 42-cli-tui | [Report](42-cli-tui/review.md) | [Findings](42-cli-tui/findings.json) |
| 43-metrics | [Report](43-metrics/review.md) | [Findings](43-metrics/findings.json) |
| 44-build-runtime | [Report](44-build-runtime/review.md) | [Findings](44-build-runtime/findings.json) |
| 45-archive-verification | [Report](45-archive-verification/review.md) | [Findings](45-archive-verification/findings.json) |
| 46-release-workflow | [Report](46-release-workflow/review.md) | [Findings](46-release-workflow/findings.json) |
| 47-install-docs | [Report](47-install-docs/review.md) | [Findings](47-install-docs/findings.json) |
| 48-test-quality | [Report](48-test-quality/review.md) | [Findings](48-test-quality/findings.json) |
| 49-whole-suite | [Report](49-whole-suite/review.md) | [Findings](49-whole-suite/findings.json) |
| 50-architecture-scale | [Report](50-architecture-scale/review.md) | [Findings](50-architecture-scale/findings.json) |
