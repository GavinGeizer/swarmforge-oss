# SwarmForge

A small MCP worker control plane for trusted AI team leads. It provisions isolated Freestyle VMs, controls OpenCode sessions using an external Qwen-compatible endpoint, persists lifecycle/results in SQLite, and exposes worker visibility through MCP and Prometheus.

SwarmForge owns worker coordination. Freestyle owns VMs, OpenCode owns coding sessions, the external Git tree owns source durability, and the external inference service owns model serving. No Git hosting, pull requests, GPU deployment, or lead-management system is included.

## Run

Use Linux x64 (glibc) with Bun 1.4.2 or newer. Install dependencies with `bun install --frozen-lockfile`, copy `.env.example` to `.env`, and fill the six required infrastructure values described in [ENVIRONMENT.md](docs/ENVIRONMENT.md).

```sh
bun run dev
bun test
bun run check
```

`dev`, `start`, `status` and `serve` all run the same `swarmforge` CLI with `--no-env-file --config=/dev/null`, so a `.env` or `bunfig.toml` in the directory you happen to be in cannot change how the command is configured. `start` and `dev` run `serve` under the hood and take the same flags as the packaged binary, so every option documented below works identically from a checkout. Configuration is explicit: a `config.toml` from [CONFIGURATION.md](docs/CONFIGURATION.md), its `env_file`, and any `--env-file` you pass. Pass one when you keep credentials in a file:

```sh
bun run start -- --env-file .env   # the flags reach the CLI, not the script
swarmforge serve --env-file .env
```

Bun forwards everything after `--` to the script, so `--env-file .env` is parsed by the `serve` command. A configuration error is reported without a stack trace and the process exits 1.

Production starts with `bun start`. The MCP endpoint is `http://127.0.0.1:8787/mcp`, using Streamable HTTP. If configured, clients must send `Authorization: Bearer <SWARMFORGE_API_TOKEN>`. The server is stateless at the MCP transport layer; worker/session state is durable in SQLite. Multiple leads share the same process. Use a persistent local volume, one server process per database, and a unique instance ID per independent deployment.

Run `bun run status` to see the worker overview. In a terminal it refreshes live: use ↑/↓ to select a worker, Enter to inspect its result and timeline, `r` to refresh, and `q` to quit. Worker inspection offers pause, resume, cancel, and destroy when available; destroy asks for confirmation and still performs the normal Git safety check. Piped output prints a static snapshot; `bun run status --json` prints structured data. Set `SWARMFORGE_URL` for a remote MCP endpoint and `SWARMFORGE_API_TOKEN` when bearer authentication is enabled. The package also provides a `swarmforge status` executable when linked or installed.

The supplied snapshot must already contain `opencode` (compatible with SDK 1.18.31), Python 3, Git, Bash, systemd, and the tools needed by workers. `opencode` must be on the service's PATH. The workspace must be writable. Git access/mounts and repository credentials are externally prepared. The endpoint must support OpenAI-compatible chat completions and tool calls. No real cloud credentials are included.

## Installing the standalone executable

`bun run package` compiles `src/cli.ts` into one Linux x64 executable and writes a versioned archive under `dist/`:

```sh
bun run build                       # dist/swarmforge
bun run package                     # dist/swarmforge, metadata JSON, SHA256SUMS, .tar.gz
bun run package:verify              # re-check the checksums and run the packaged binary
```

Install it manually into your own home directory. Nothing is installed system-wide and no service is created. Set `VERSION` to the version in the archive name you downloaded (for example `0.1.0`); quoting it matters, an unquoted `<version>` would be read by the shell as a redirection:

```sh
(
  set -eu
  VERSION=0.1.0
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  tar -xzf "dist/swarmforge-v${VERSION}-linux-x64-glibc.tar.gz" -C "$tmp"
  (cd "$tmp" && sha256sum -c SHA256SUMS)
  install -d "$HOME/.local/bin"
  install -m 755 "$tmp/swarmforge" "$HOME/.local/bin/swarmforge"
  "$HOME/.local/bin/swarmforge" --version
)
```

The whole block runs in a subshell with `set -e`, so a checksum that does not
verify stops it there: the shell does not carry on to `install`, and a copy-paste
fails with a nonzero status instead of reporting success. Running the subshell
also leaves your own shell's `errexit` setting alone, and the trap removes the
temporary directory whether the block succeeds or fails. The checksum is verified
inside the extracted archive, where `SHA256SUMS` and the executable sit together,
before anything is installed. Add `~/.local/bin` to `PATH` in the shell profile
you already use, for example `export PATH="$HOME/.local/bin:$PATH"` in `~/.bashrc`,
then open a new shell and `swarmforge` resolves by name. The executable needs no
Bun, no `node_modules` and no checkout: it does not read `.env`, `bunfig.toml`,
`tsconfig.json` or `package.json` from the directory it runs in, so a foreign
directory cannot reconfigure it. Only Linux x64 with glibc is built and verified;
`dist/` is ignored by Git.

Check what you installed:

```sh
swarmforge --version          # prints the packaged version
swarmforge --help
swarmforge config path        # the config file in effect, and whether it exists
swarmforge config show        # resolved values and sources, credentials redacted
swarmforge config validate    # validates the server configuration and exits
swarmforge serve --check-config
swarmforge serve --env-file .env
swarmforge status --json --url http://127.0.0.1:8787/mcp
```

### Configuration and diagnostics

`swarmforge serve` needs `FREESTYLE_API_TOKEN`, `FREESTYLE_SNAPSHOT_ID`, `SWARMFORGE_MODEL_BASE_URL`, `SWARMFORGE_MODEL_API_KEY`, `SWARMFORGE_MODEL_NAME` and `SWARMFORGE_GIT_TREE`. Put the non-secret ones in `~/.config/swarmforge/config.toml` (`schema_version = 1`) and the credentials in `secrets.env` beside it with `env_file = "secrets.env"`, both created `chmod 600`. Then `swarmforge config show` prints every resolved value with its source, with credentials replaced by `[REDACTED]`, so a ticket can carry the output.

For an existing deployment, name the database by its current absolute path before you cut over, for example `SWARMFORGE_DB_PATH=/absolute/path/to/swarmforge.sqlite` in `.env`. SwarmForge never moves, copies or relocates a database: a database path that is set is used exactly as written, so the same instance keeps the same file, the same instance ID and the same durable rows. Confirm with `swarmforge config show | grep -i db_path` before you delete anything.

### Running under systemd

SwarmForge does not install or edit a service; supply your own unit. `Type=exec` reports the main process directly (a shell wrapper type would report the wrong process and systemd could signal the wrong pid), and `TimeoutStopSec=90s` must exceed the command's own 60s shutdown deadline, so systemd waits for the drain before it kills the process:

```ini
[Service]
Type=exec
ExecStart=/home/operator/.local/bin/swarmforge serve --env-file /home/operator/.config/swarmforge/secrets.env
TimeoutStopSec=90s
Restart=on-failure
```

`Type=exec` reports that the process was executed successfully; it says nothing about startup progress, and `/health` is a liveness endpoint that answers while the server is still starting. Startup readiness is a property of the MCP surface, not of the process: until recovery and the first provisioning pass finish, every mutating request is refused with `503` and a `Retry-After` header. A client or a readiness probe should therefore wait for startup to complete — retry the mutating call while it receives `503`, and treat any other response as ready — rather than treating `Type=exec` or a `200` from `/health` as "ready". `SIGTERM` starts the graceful drain; a second signal is not needed. `TimeoutStopSec` is only the outer bound — the command's own `SWARMFORGE_SHUTDOWN_TIMEOUT_MS` (default `60000`) reports the deadline and exits `70` with the database still open.

## Usage

```json
{"name":"spawn_worker","arguments":{"team_id":"backend","task_id":"auth-code","role":"coder","prompt":"Implement authentication. Test and persist changes in the supplied Git tree.","request_id":"auth-code-attempt-1"}}
```

Creation returns a worker ID immediately. Read `get_worker` or `list_workers`, or block on the next transition with `wait_for_state_change`, collect `get_worker_result`, and use `send_worker_message` for follow-ups in the same session. Active turns finish before queued messages are submitted. Completed workers remain available until explicitly destroyed. A refused cleanup reports `recovery_required`; inspect/persist the work, or explicitly authorize its loss with `destroy_worker(force=true)`.

For source handoff without MCP artifact downloads, set `SWARMFORGE_GIT_PUSH_MODE=github-app` with a repository-scoped GitHub App, or `ssh` with a dedicated write key and reachable Git remote. Each worker starts on a unique branch, commits its changes, and SwarmForge pushes and verifies the remote commit before marking the run complete. `get_worker_result.git` then contains the branch, commit, base commit and (for GitHub) a review URL. See [environment configuration](docs/ENVIRONMENT.md) for setup.

All 17 tools are documented in [MCP-API.md](docs/MCP-API.md). Artifact retrieval returns resource links to chunks of at most 32 KiB, not entire files in tool responses.

## Verification and operations

Tests use real SQLite and MCP transports with injected Freestyle/OpenCode doubles; Git safety tests execute real Git commands against disposable repositories. The optional `SWARMFORGE_RUN_SMOKE=true bun run smoke` creates one billable VM using the configured infrastructure. On success it destroys that smoke VM; on failure it retains evidence and prints identifiers. Ordinary tests do not create VMs.

Read [ARCHITECTURE.md](docs/ARCHITECTURE.md), [WORKER-PROTOCOL.md](docs/WORKER-PROTOCOL.md), [OBSERVABILITY.md](docs/OBSERVABILITY.md), and the verified API decisions in [RESEARCH.md](docs/RESEARCH.md).

Limitations: no distributed scheduler or HA replicas; Git checks cannot prove remote durability; artifacts remain on retained VMs; inference-active counts are estimates from OpenCode; snapshot compatibility and real endpoint behavior require the opt-in smoke test. Deploy TLS and network access policy externally when exposing the MCP server or metrics beyond localhost.
