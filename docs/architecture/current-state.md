# Current implementation audit

Audited 2026-10-08 against application commit `9f2953e` and documentation snapshot `9216ed5`. References identify implementation symbols and baseline line locations; Phase 1 changes are listed separately in [the summary](phase-1-summary.md). Existing design documents were treated as context, not proof of implemented features.

## Repository and execution boundaries

Bun 1.4.2 / strict TypeScript ESM application, version 0.1.2. `package.json:3-9` pins runtime/package manager and identifies the PolyForm Small Business license. There is one deployable coordinator process, not a distributed scheduler or collection of microservices.

| Boundary | Implementation evidence | State |
| --- | --- | --- |
| CLI and packaged entry | `src/cli.ts:39-90`, `scripts/build.ts:17-56`; alternate serve entry `src/main.ts:5-12` | Implemented |
| Server lifecycle / composition | `src/serve.ts:startServer` (`115-214`), `ServeOptions` (`21-25`) | Implemented; provider and agent injectable |
| Core scheduler | `src/coordinator.ts:Coordinator` constructor (`54-75`), queue admission (`199-222`), worker serialization (`280`), provisioning admission (`368`) | Implemented, global instance scope |
| Worker infrastructure | `src/domain.ts:WorkerProvider` (`275-304`); `src/providers/freestyle.ts:FreestyleProvider` | Implemented Freestyle; no production local-container, SSH-host or customer-enrollment adapter |
| Agent runtime | `src/domain.ts:CodingAgent` (`334-339`); `src/providers/opencode.ts:OpenCodeAgent` | Implemented OpenCode; external OpenAI-compatible model endpoint |
| Durable state | `src/store.ts:Store` (`43-86`), request idempotency (`231`), results (`601`), usage (`616`) | Implemented Bun SQLite, WAL, local disk |
| Artifact data plane | `src/artifacts.ts:ArtifactService`, `src/artifact-store.ts`, `src/finalization.ts:Finalizer`, `src/providers/artifact-transport.ts` | Implemented, private disk, checksums, bounded transfers and independent finalization |
| Cloud account / organizations / subscription authority | No implementation in `src`, dependencies or store schemas | Missing |
| Distributed execution / metered enforcement | Current coordinator config limits and estimated usage only | Partial foundations; commercial enforcement missing |

## CLI, configuration and bootstrap

The CLI implements GitHub login/status/logout; init; doctor; serve; status and TUI; config path/show/validate; artifact list/preview/download; retention preview; usage; notifications list/watch; task templates; help/version. See `src/cli.ts:39-74`, command parsing in `src/cli/arguments.ts` and transport in `src/cli/client.ts:connectSwarmForge`. Worker mutation is available through MCP and dashboard controls; there is no cloud login, checkout or cloud-tier command.

`src/settings/load.ts:resolveClientSettings` and `resolveServerSettings` load defaults → global config → its env file → explicit env files → environment → explicit overrides. Global paths use XDG conventions (`src/settings/paths.ts:57-72`). Client defaults to `http://127.0.0.1:8787/mcp`. Reading settings creates nothing. Config/diagnostics carry redaction context, including superseded credentials (`src/settings/inspect.ts:68-143`). `serve --check-config` does not start a listener or provider; doctor live probes are opt-in.

Required server settings are Freestyle API token/snapshot, model base URL/key/name and Git tree (`src/config.ts:35-57`). Git tree supports clone URLs/paths or opaque `none` trees. `.env.example` documents ports, timeouts, artifact bounds, Git modes, limits, rates and retention. Configuration requires no SwarmForge account. “Self-hosted” currently means a locally/customer-run coordinator using customer-paid Freestyle VMs and inference; arbitrary on-machine agent execution is not yet implemented.

`startServer` constructs default Freestyle/OpenCode adapters, acquires an advisory process lock (`src/runtime.ts:acquireProcessLock`), checks persisted instance ownership, recovers state, starts listeners and opens the mutation gate after recovery. It refuses an in-memory server DB. Shutdown releases resources in reverse order and waits for writers. This relies on Bun SQLite, Bun HTTP and Bun FFI/libc; it cannot run unchanged in Cloudflare Workers.

## Orchestration and worker lifecycle

The actual states are queued, provisioning, booting, ready, running, waiting, completed, failed, cancelled, paused, destroyed and recovery_required (`src/domain.ts:8-23`). Spawn validates Zod schemas, records a request fingerprint and supports team-scoped `request_id` retries; changed payload under the same key is rejected (`src/store.ts:create`). Team/task/role are user-supplied labels. There is no task dependency DAG, org ownership, per-user authorization, per-task infrastructure/model selection or role-aware scheduling.

Follow-ups are durable dispatches with run/message identity, reusing the session. Delivery ambiguity is inspected rather than replayed blindly (`src/coordinator.ts:626-679`). Controls persist intent, serialize against teardown, and reject messages that would be lost. Recovery rediscovers owned VMs, handles interrupted creation, missing/external pauses and orphan VMs conservatively (`src/coordinator.ts:recover`, `434`). Configured limits bound queued requests, retained workers and simultaneous provisioning; task/provision timeouts and durable token-idle timers exist. Cancellation stops execution but retains the VM; destruction separately checks preservation and Git safety.

Freestyle creates persistent VMs from an externally prepared snapshot, with TTL and idle deletion disabled; metadata links instance/worker ownership (`src/providers/freestyle.ts:97-149`). Preparation expects Git, Python, Bash, systemd and OpenCode, stages repository cloning, assigns deterministic worker branches, writes protected configuration and starts a service (`163-239`). Snapshot building, managed cloud provisioning and remote-worker enrollment are not implemented.

OpenCode sessions use per-worker endpoint passwords, async prompts, authoritative session status and bounded result validation (`src/providers/opencode.ts:71-211`; `src/coordinator.ts:654-820`). History observes the newest 100 messages, then 20 on a supported-error fallback, with no historical backfill (`src/providers/opencode.ts:178-199`). This matters for usage accuracy. VM preparation and persisted `opencode_session_id` remain OpenCode-specific. Baseline coordinator quiescence embeds a systemd stop command (`src/coordinator.ts:861`); Phase 1 adds an optional provider hook while retaining its legacy fallback.

## Repository identity and Git operations

Existing Device Flow in `src/github-oauth.ts:deviceLogin` requests GitHub `repo`, polls for user authorization, verifies the selected repository permits push and saves credentials in a protected local file (`154-259`). `src/cli/github.ts` and init integrate it. It authenticates repository access, not a SwarmForge Cloud account. It is unchanged by this phase.

Push modes are `none`, GitHub App, GitHub OAuth and SSH (`src/config.ts`, `src/git-handoff.ts:17-74`). GitHub App private key stays on the coordinator; installation tokens are minted for the configured repository. Freestyle installs temporary clone/push material in the guest and removes it afterward (`src/providers/freestyle.ts:241-302`). Workers have a privileged runtime and can access credentials while operations run; selected-repository OAuth binding does not narrow the actual broad token.

Automatic handoff requires the assigned clean branch, validates base ancestry, pushes and verifies remote SHA (`src/providers/freestyle.ts:304-342`). Results are saved before push and subsequently updated with verified metadata (`src/coordinator.ts:820`). `review_url` is a compare link, not an opened PR. No first-class PR creation, merge or source integration operation is implemented in the coordinator; tools in the external worker environment can do repository work subject to operator instructions.

## API, auth and persistence

| Current surface | Actual behavior |
| --- | --- |
| `POST /mcp` | Stateless MCP Streamable HTTP / JSON-RPC; new server/transport per request, no MCP session identity. Zod tool validation, bounded input/output. `src/http.ts:75-126`, `src/mcp.ts:124-183`. |
| `/health` | Liveness JSON after the common host/auth/origin checks. Handler does not restrict this path to GET. Startup refuses mutating requests globally. |
| `GET /events` | At most 100 durable events, SSE-formatted replay; reconnect using cursor/Last-Event-ID. It is not an indefinitely open push stream. `src/http.ts:45-63`. |
| `GET /artifacts/:id/download` | Attachment bytes, no-store/nosniff, size/checksum-aware client, bounded ranges. Same instance auth; no tenant-level authorization. `src/http.ts:65-74`, `151-220`. |
| Separate `/metrics` listener | Prometheus on configured bind host, without API bearer/host/origin checks. `src/serve.ts:177-189`. Treat as private operational endpoint. |

The shared API bearer authorizes the entire instance; comparison is timing-safe (`src/http.ts:31-39`). Loopback may omit it. Any non-loopback accepted host requires a configured token (`src/config.ts:191-197`), including a public reverse-proxy hostname. A present cross-origin Origin is rejected. MCP HTTP bodies are bounded at 128 KiB. Existing protocols are not tenant-safe public cloud APIs.

SQLite persists team/task/worker JSON with indexed fields, dispatches/results, events, model-token usage, settings, artifact records and credential screening values (`src/store.ts:43-86`). Database permissions are 0600. Screening stores OAuth token copies to detect historical output; removing the OAuth credential file does not erase these DB copies. Artifact bytes live separately on private local disk; results/artifacts survive VM destruction. Existing migrations/backfills belong to local startup; no D1 schemas or tenant migrations exist.

Usage max-upserts per worker/message prevent double counting repeated snapshots (`src/store.ts:616-669`). Configured token prices and retained VM hours produce estimates (`src/operator-insights.ts:usageEstimate`), not reconciled invoices. `complete` means pricing coverage of recorded usage, not complete session observation. `checkBudget` emits a deduplicated alert and does not reject or stop work (`src/notifications.ts:66-88`). Prometheus is observability, not billing.

## Deployment, tests and limitations

CI on master/PR runs frozen install, TypeScript/Biome, tests and build (`.github/workflows/ci.yml`). Release workflow checks tag/version, builds Linux x64/glibc, packages checksums/metadata/license, tests isolated binaries and creates a draft release (`.github/workflows/release.yml:35-176`). No SaaS deployment workflow, Stripe dependency or D1/Workers application exists here.

Website is maintained separately. `docs/WEBSITE-DEPLOYMENT.md` describes Pages; local site checkout also contains Workers static asset configuration and preview/deploy scripts. Its plan records dry-run validation and outstanding owner deployment/domain/release steps. This audit does not claim a live production deployment. See [deployment](deployment.md).

Existing tests cover lifecycle/races/restart, dispatch status/history, Git handoff/safety, files/artifacts/finalization, HTTP/MCP, dashboard/CLI/settings/redaction, locking and packaging. No direct Device Flow test was found. Baseline run: 582 pass, 2 skip, 0 fail. Final checks and exclusions are recorded in [validation](validation.md).

Confirmed security/architecture gaps: terminal event payload redaction (fixed in Phase 1), separate unauthenticated metrics, broad OAuth token exposure to privileged guests, incomplete App/SSH arbitrary-output screening, retained credential copies in DB, no tenant authority and incomplete usage observation. These are distinct from claims that all CLI output or all worker content is safe; raw artifact downloads intentionally return bytes to authorized operators. Hosted deployment must not simply publish this instance API.
