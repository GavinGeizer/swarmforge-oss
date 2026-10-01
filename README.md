# SwarmForge

A small MCP worker control plane for trusted AI team leads. It provisions isolated Freestyle VMs, controls OpenCode sessions using an external Qwen-compatible endpoint, persists lifecycle/results in SQLite, and exposes worker visibility through MCP and Prometheus.

SwarmForge owns worker coordination. Freestyle owns VMs, OpenCode owns coding sessions, the external Git tree owns source durability, and the external inference service owns model serving. No Git hosting, pull requests, GPU deployment, or lead-management system is included.

## Run

Use Linux with Bun 1.3 or newer. Install dependencies with `bun install --frozen-lockfile`, copy `.env.example` to `.env`, and fill the six required infrastructure values described in [ENVIRONMENT.md](docs/ENVIRONMENT.md).

```sh
bun run dev
bun test
bun run check
```

Production starts with `bun start`. The MCP endpoint is `http://127.0.0.1:8787/mcp`, using Streamable HTTP. If configured, clients must send `Authorization: Bearer <SWARMFORGE_API_TOKEN>`. The server is stateless at the MCP transport layer; worker/session state is durable in SQLite. Multiple leads share the same process. Use a persistent local volume, one server process per database, and a unique instance ID per independent deployment.

Run `bun run status` to see the worker overview. In a terminal it refreshes live: use ↑/↓ to select a worker, Enter to inspect its result and timeline, `r` to refresh, and `q` to quit. Worker inspection offers pause, resume, cancel, and destroy when available; destroy asks for confirmation and still performs the normal Git safety check. Piped output prints a static snapshot; `bun run status --json` prints structured data. Set `SWARMFORGE_URL` for a remote MCP endpoint and `SWARMFORGE_API_TOKEN` when bearer authentication is enabled. The package also provides a `swarmforge status` executable when linked or installed.

The supplied snapshot must already contain `opencode` (compatible with SDK 1.18.31), Python 3, Git, Bash, systemd, and the tools needed by workers. `opencode` must be on the service's PATH. The workspace must be writable. Git access/mounts and repository credentials are externally prepared. The endpoint must support OpenAI-compatible chat completions and tool calls. No real cloud credentials are included.

## Usage

```json
{"name":"spawn_worker","arguments":{"team_id":"backend","task_id":"auth-code","role":"coder","prompt":"Implement authentication. Test and persist changes in the supplied Git tree.","request_id":"auth-code-attempt-1"}}
```

Creation returns a worker ID immediately. Read `get_worker` or `list_workers`, or block on the next transition with `wait_for_state_change`, collect `get_worker_result`, and use `send_worker_message` for follow-ups in the same session. Active turns finish before queued messages are submitted. Completed workers remain available until explicitly destroyed. A refused cleanup reports `recovery_required`; inspect/persist the work, or explicitly authorize its loss with `destroy_worker(force=true)`.

For source handoff without MCP artifact downloads, set `SWARMFORGE_GIT_PUSH_MODE=github-app` with a repository-scoped GitHub App, or `ssh` with a dedicated write key and reachable Git remote. Each worker starts on a unique branch, commits its changes, and SwarmForge pushes and verifies the remote commit before marking the run complete. `get_worker_result.git` then contains the branch, commit, base commit and (for GitHub) a review URL. See [environment configuration](docs/ENVIRONMENT.md) for setup.

All 24 tools are documented in [MCP-API.md](docs/MCP-API.md). Artifact retrieval returns resource links to chunks of at most 32 KiB, not entire files in tool responses.

Worker output is durable. Artifact paths a task declares, plus `.swarmforge/artifacts` and `.swarmforge/logs`, are copied into private coordinator storage with a verified checksum before a worker can be destroyed, without any help from the model. Leads inspect and retrieve them with `list_artifacts`, `get_artifact_metadata`, `read_artifact`, `list_worker_files`, `snapshot_worker`, `preserve_artifact` and `retry_worker_finalization`, and fetch faithful raw bytes through the authenticated `GET /artifacts/<artifact_id>/download` route, which is attachment-only, non-sniffable, uncached and range bounded. Inline reads stay capped at 32 KiB, are credential screened and never return binary payloads. See [ARTIFACTS.md](docs/ARTIFACTS.md).

## Verification and operations

Tests use real SQLite and MCP transports with injected Freestyle/OpenCode doubles; Git safety tests execute real Git commands against disposable repositories, and artifact tests drive a real temporary guest filesystem through the artifact transport with real byte streams and checksums. The optional `SWARMFORGE_RUN_SMOKE=true bun run smoke` creates one billable VM using the configured infrastructure. On success it destroys that smoke VM; on failure it retains evidence and prints identifiers. `bun scripts/artifact-salvage-smoke.ts` is a local end-to-end salvage check: it runs a real helper-backed capture against a local guest filesystem while OpenCode is dead, destroys the workspace and re-verifies the stored bytes and checksum. Adding `--freestyle <vm-id>` runs the same read-and-verify pass against one retained Freestyle VM without a worker model and never destroys it. Ordinary tests do not create VMs.

Read [ARCHITECTURE.md](docs/ARCHITECTURE.md), [WORKER-PROTOCOL.md](docs/WORKER-PROTOCOL.md), [ARTIFACTS.md](docs/ARTIFACTS.md), [OBSERVABILITY.md](docs/OBSERVABILITY.md), and the verified API decisions in [RESEARCH.md](docs/RESEARCH.md).

Limitations: no distributed scheduler or HA replicas; Git checks cannot prove remote durability; artifact storage is local to the coordinator process and its backup is an operator responsibility; inference-active counts are estimates from OpenCode; snapshot compatibility and real endpoint behavior require the opt-in smoke test. Deploy TLS and network access policy externally when exposing the MCP server, the artifact download or metrics beyond localhost.
