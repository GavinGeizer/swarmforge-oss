# SwarmForge

A small MCP worker control plane for trusted AI team leads. It provisions isolated Freestyle VMs, controls OpenCode sessions using an external Qwen-compatible endpoint, persists lifecycle/results in SQLite, and exposes worker visibility through MCP and Prometheus.

SwarmForge owns worker coordination. Freestyle owns VMs, OpenCode owns coding sessions, the external Git tree owns source durability, and the external inference service owns model serving. No Git hosting, pull requests, GPU deployment, or lead-management system is included.

## Run

Use Linux. Verified with the official **Bun 1.4.2** release and `bun install --frozen-lockfile`; `engines` still allows `>=1.3.0`. For a first-time install, copy `.env.example` to `.env` and fill the six required infrastructure values described in [ENVIRONMENT.md](docs/ENVIRONMENT.md) — if you already have a working `.env`, keep it and see [Move the workers to another repository](#move-the-workers-to-another-repository).

```sh
bun run dev
bun test
bun run check
```

Production starts with `bun start`. The MCP endpoint is `http://127.0.0.1:8787/mcp`, using Streamable HTTP. If configured, clients must send `Authorization: Bearer <SWARMFORGE_API_TOKEN>`. The server is stateless at the MCP transport layer; worker/session state is durable in SQLite. Multiple leads share the same process. Use a persistent local volume, one server process per database, and a unique instance ID per independent deployment.

Run `bun run status` to see the worker overview. In a terminal it refreshes live: use ↑/↓ to select a worker, Enter to inspect its result and timeline, `r` to refresh, and `q` to quit. Worker inspection offers pause, resume, cancel, and destroy when available; destroy asks for confirmation and still performs the normal Git safety check. Piped output prints a static snapshot; `bun run status --json` prints structured data. Set `SWARMFORGE_URL` for a remote MCP endpoint and `SWARMFORGE_API_TOKEN` when bearer authentication is enabled. The package also provides a `swarmforge status` executable when linked or installed.

The supplied snapshot must already contain `opencode` (compatible with SDK 1.18.31), Python 3, Git, Bash, systemd, and the tools needed by workers. `opencode` must be on the service's PATH. The workspace must be writable. Git access/mounts and repository credentials are externally prepared. The endpoint must support OpenAI-compatible chat completions and tool calls. No real cloud credentials are included.

### Quickstart for one user

There is no installer, account or preflight step, and no second configuration file. Artifacts reuse the
`.env` you already have; the only variables that differ are the repository itself.

```sh
bun install --frozen-lockfile
bun run dev               # or `bun start` for the production entry point
```

**Already have a working `.env`? Leave it alone.** `cp .env.example .env` is for a first-time install
with no `.env` yet, and copying it over a configured one would overwrite credentials that already
work. Artifact preservation needs no new credentials and no additional service: it stores files beside
the database on the coordinator host. The Freestyle account, snapshot, VM time and the model endpoint
are what the workers themselves consume, and they stay as billable infrastructure you already hold.

Hand one task over and let a worker work in your repository:

```json
{"name":"spawn_worker","arguments":{"team_id":"default","task_id":"auth-code","role":"coder","prompt":"Implement authentication. Test and persist changes in the supplied Git tree.","request_id":"auth-code-attempt-1"}}
```

Then read it back:

```sh
bun run status                     # or set SWARMFORGE_URL / SWARMFORGE_API_TOKEN for a remote one
bun run status --json
```

To get a worker's **non-source output as files** — reports, logs, findings — instead of prose, add
`SWARMFORGE_ARTIFACT_DIR` (absolute, private; defaults to `artifacts` beside the database) to the same
`.env`, and read [ARTIFACT-QUICKSTART.md](docs/ARTIFACT-QUICKSTART.md) for the runbook and
[ARTIFACTS.md](docs/ARTIFACTS.md) for the contract. Start from
[`examples/artifact-task.json`](examples/artifact-task.json), which declares output **outside** the
repository so "commit nothing and push nothing" leaves no untracked dirt.

Artifact preservation and the finalization lifecycle are integrated here — manager surface, capture
data plane and lifecycle — and [ARTIFACT-QUICKSTART.md](docs/ARTIFACT-QUICKSTART.md) is the operator
path through them. Final real-VM release verification is still pending.

### Move the workers to another repository

SwarmForge is single-user and single-repository at a time: the repository is **global configuration**,
not a per-worker parameter. `spawn_worker` has no repository override, and every worker clones
`SWARMFORGE_GIT_TREE`. To retarget an install that already runs:

1. **Finish the old repository first.** Let running workers settle, collect their output with
   `list_artifacts`, then `destroy_worker` them. A worker still holding a VM of the old repository
   still uses the coordinator's global Git configuration for execution and source publication;
   finish it before switching targets. Stored artifacts and filesystem retrieval remain available.
2. **Stop the server.** Do not rewrite these values underneath a running process.
3. **Change only the repository fields.** Every other value in `.env` — Freestyle token, snapshot,
   model endpoint and key, push credentials, `SWARMFORGE_API_TOKEN` — stays exactly as it is.
4. **Restart.**

| `SWARMFORGE_GIT_PUSH_MODE` | Change |
| --- | --- |
| `github-app` | `SWARMFORGE_GIT_TREE=https://github.com/OWNER/NEWREPO.git` **and** `SWARMFORGE_GITHUB_REPOSITORY=OWNER/NEWREPO`. Both must name the same repository, or configuration is rejected. The App **installation must already grant access to the new repository** — add it there first, or the push fails at handoff. |
| `ssh` | `SWARMFORGE_GIT_TREE=<new clone URL>`, and separately `SWARMFORGE_GIT_PUSH_URL=<new push remote>`. The write key and known-hosts path are unchanged, so the new remote must accept that same key. |
| `none` | `SWARMFORGE_GIT_TREE=<new clone URL>` only. |

The `https://github.com/OWNER/REPO` form without `.git` is accepted too.

What does **not** move: the central SwarmForge checkout and its server stay where they are — only the
Git tree each worker clones changes. The skill lives in the repository
(`.agents/skills/using-swarmforge/`), so it arrives with the new repository automatically, while the MCP
endpoint stays the same `http://127.0.0.1:8787/mcp` — a client's `SWARMFORGE_URL` and
`SWARMFORGE_API_TOKEN` need no edit.

Switching back is the same fields in reverse. To run two repositories *concurrently*, give each its own
`SWARMFORGE_DB_PATH` and `SWARMFORGE_ARTIFACT_DIR` and run one server process per database, since a
database and artifact root belong to one instance. Switching one after the other needs no extra setup.

## Usage

```json
{"name":"spawn_worker","arguments":{"team_id":"backend","task_id":"auth-code","role":"coder","prompt":"Implement authentication. Test and persist changes in the supplied Git tree.","request_id":"auth-code-attempt-1"}}
```

Creation returns a worker ID immediately. Read `get_worker` or `list_workers`, or block on the next transition with `wait_for_state_change`, collect `get_worker_result`, and use `send_worker_message` for follow-ups in the same session. Active turns finish before queued messages are submitted. Completed workers remain available until explicitly destroyed. A refused cleanup reports `recovery_required`; inspect/persist the work, or explicitly authorize its loss with `destroy_worker(force=true)`.

For source handoff without MCP artifact downloads, set `SWARMFORGE_GIT_PUSH_MODE=github-app` with a repository-scoped GitHub App, or `ssh` with a dedicated write key and reachable Git remote. Each worker starts on a unique branch, commits its changes, and SwarmForge pushes and verifies the remote commit before marking the run complete. `get_worker_result.git` then contains the branch, commit, base commit and (for GitHub) a review URL. See [environment configuration](docs/ENVIRONMENT.md) for setup.

All 24 tools are documented in [MCP-API.md](docs/MCP-API.md). Artifact retrieval returns resource links to chunks of at most 32 KiB, not entire files in tool responses.

Artifact retrieval is designed so a worker VM is not the only copy of a worker's non-source output: artifact paths a task declares, plus `.swarmforge/artifacts` and `.swarmforge/logs`, are copied into private coordinator storage with a verified checksum before a worker can be destroyed, without any help from the model. Leads inspect and retrieve them with `list_artifacts`, `get_artifact_metadata`, `read_artifact`, `list_worker_files`, `snapshot_worker`, `preserve_artifact` and `retry_worker_finalization`, and fetch faithful raw bytes through the authenticated `GET /artifacts/<artifact_id>/download` route, which is attachment-only, non-sniffable, uncached and range bounded. Inline reads stay capped at 32 KiB, are credential screened, strip terminal escapes so a coloured log reads as text, and never return binary payloads. See [ARTIFACT-QUICKSTART.md](docs/ARTIFACT-QUICKSTART.md) and [ARTIFACTS.md](docs/ARTIFACTS.md).

## Verification and operations

Tests use real SQLite and MCP transports with injected Freestyle/OpenCode doubles; Git safety tests execute real Git commands against disposable repositories. The optional `SWARMFORGE_RUN_SMOKE=true bun run smoke` creates one billable VM using the configured infrastructure. On success it destroys that smoke VM; on failure it retains evidence and prints identifiers. Ordinary tests do not create VMs. `bun scripts/artifact-salvage-smoke.ts` is the artifact end-to-end check: locally it drives the coordinator and manager surfaces over a temporary guest directory whose every capture runs `src/providers/artifact-helper.py` as a subprocess, and `--freestyle <vm-id>` reads one retained VM instead without a worker model. Final real-VM release verification is still pending.

Read [ARCHITECTURE.md](docs/ARCHITECTURE.md), [WORKER-PROTOCOL.md](docs/WORKER-PROTOCOL.md), [ARTIFACTS.md](docs/ARTIFACTS.md), [OBSERVABILITY.md](docs/OBSERVABILITY.md), and the verified API decisions in [RESEARCH.md](docs/RESEARCH.md).

Limitations: no distributed scheduler or HA replicas; Git checks cannot prove remote durability; artifact storage is local to the coordinator process with backup an operator responsibility; OpenCode message history is a single bounded page (newest 100, one retry at 20, then status-only), so usage for older messages is never recovered; inference-active counts are estimates from OpenCode; snapshot compatibility and real endpoint behavior require the opt-in smoke test. Deploy TLS and network access policy externally when exposing the MCP server, the artifact download or metrics beyond localhost.
