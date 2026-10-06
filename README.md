# SwarmForge

SwarmForge lets an AI lead launch isolated coding workers, follow their progress, send follow-up tasks, and collect their results through MCP. Each worker runs OpenCode in a Freestyle VM against your model endpoint and Git repository. Worker state and results are stored in SQLite; the terminal dashboard shows current activity.

The global `swarmforge` executable provides `init`, `doctor`, `serve`, and `status`, plus configuration inspection. You supply the VM snapshot, model service, and Git access. SwarmForge does not host Git, serve models, or create pull requests.

## Contents

- [Before you start](#before-you-start)
- [Quick start](#quick-start)
- [Download, build, and install](#download-build-and-install)
- [Initialize a deployment](#initialize-a-deployment)
- [Check setup and start the server](#check-setup-and-start-the-server)
- [Connect an MCP client](#connect-an-mcp-client)
- [Run a first task and collect the result](#run-a-first-task-and-collect-the-result)
- [Troubleshooting](#troubleshooting)
- [Build and packaged installation](#build-and-packaged-installation)

## Before you start

The supported host is **Linux x64 with glibc**. Building from a checkout requires **Bun 1.4.2 or newer** and Git. The installed executable includes its runtime and does not require Bun or `node_modules`.

Have these infrastructure details ready before initialization:

| Required value | What to provide |
| --- | --- |
| `FREESTYLE_API_TOKEN` | A Freestyle account API token used to manage worker VMs. |
| `FREESTYLE_SNAPSHOT_ID` | An existing snapshot ID or slug, prepared with the worker tools below. |
| `SWARMFORGE_MODEL_BASE_URL` | An OpenAI-compatible chat-completions API base URL, usually ending in `/v1`, reachable from the VMs. |
| `SWARMFORGE_MODEL_API_KEY` | A worker-scoped inference key. For an unauthenticated endpoint, use a nonempty placeholder. |
| `SWARMFORGE_MODEL_NAME` | The exact model ID accepted by the endpoint. The model must support tool calls. |
| `SWARMFORGE_GIT_TREE` | A cloneable Git URL or path available to the worker. Use `none` or `none:/prepared/path` to use a prepared workspace instead of cloning. |

The **worker snapshot** must contain OpenCode compatible with SDK 1.18.31, Python 3, Git, Bash, systemd, and the tools needed for your tasks. OpenCode must be on the service PATH and the guest workspace must be writable. Repository credentials, mounts, and networking are prepared externally. These guest prerequisites are separate from the control-plane host.

Installing and initializing create no worker VMs. Spawning a worker provisions a billable VM; completed workers retain their VMs until explicitly destroyed.

## Quick start

If you already have the required infrastructure values, the shortest path is:

```sh
git clone https://github.com/GavinGeizer/swarmforge-oss.git
cd swarmforge-oss
bun install --frozen-lockfile
bun run setup
swarmforge doctor
swarmforge serve
```

Then connect your MCP client to `http://127.0.0.1:8787/mcp` and run `swarmforge status` in another terminal.

## Download, build, and install

From a fresh checkout:

```sh
git clone https://github.com/GavinGeizer/swarmforge-oss.git
cd swarmforge-oss
bun install --frozen-lockfile
bun run setup
```

`setup` compiles the standalone command, installs it at `~/.local/bin/swarmforge`, and starts the interactive initialization questions. It installs for your user without `sudo`. Secret inputs are hidden. Enter all six required values from the table above; invalid values are explained and requested again.

For a source ZIP download, extract it, open a terminal in its directory, and run the same `bun install --frozen-lockfile` and `bun run setup` commands. A ZIP build reports an unknown Git commit because the download contains no repository metadata.

To build and install without starting initialization, or to update an existing installation:

```sh
bun run install:local
```

The installer replaces the executable atomically. An already running server continues using its old executable until you stop and start it again. The `dist/swarmforge` build also remains in the checkout.

### Make the command available in your terminal and workspace

The installer prints instructions for your shell. If `~/.local/bin` is already on PATH, the command is immediately available. Otherwise, for Bash:

```sh
printf '%s\n' 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"
. "$HOME/.bashrc"
hash -r
swarmforge --help
```

For Zsh, use `~/.zshrc` instead of `~/.bashrc`. For Fish, run `fish_add_path ~/.local/bin`.

After changing PATH, open a new terminal. In VS Code or a compatible editor, run **Developer: Reload Window** from the command palette, then open a new workspace terminal. Until PATH is refreshed, you can invoke `~/.local/bin/swarmforge` directly.

## Initialize a deployment

Once the command is installed, initialize from the directory where you want the environment file and deployment data:

```sh
mkdir -p ~/my-swarmforge
cd ~/my-swarmforge
swarmforge init
```

`init` creates `.env` in the **current directory** with permissions `0600`. It records your required settings, an absolute database path under that directory's `data/`, and a unique stable instance ID. Keep the instance ID and database path when upgrading an existing deployment.

When the global configuration is absent, `init` also creates `~/.config/swarmforge/config.toml` pointing to that environment file by its absolute path. An absolute `XDG_CONFIG_HOME` changes the configuration location. After initialization, the global command can find this deployment from any directory.

Existing `.env` files are refused before credentials are requested. Existing global configuration is preserved; in that case `init` prints commands using `--env-file` to select the newly created file explicitly. To create a separately selected configuration, use `swarmforge init --config /absolute/path/config.toml`, then pass that same `--config` to subsequent commands.

The environment file is parsed as data. Do not source it as a shell script, and do not commit it. Optional settings and verified Git branch handoff are described in [ENVIRONMENT.md](docs/ENVIRONMENT.md) and [.env.example](.env.example).

### If you already have an environment file

Keep it and skip `init`:

```sh
swarmforge doctor --env-file .env
swarmforge serve --env-file .env
```

Configuration is explicit. The binary and checkout scripts do **not** automatically load a `.env` in the working directory. Use the registered global configuration, its `env_file`, or a `--env-file` argument. Use an absolute environment-file path when invoking from another directory.

For an existing deployment, retain the original database, for example `SWARMFORGE_DB_PATH=/absolute/path/to/swarmforge.sqlite`, and its existing instance ID. No command moves or migrates a database. Inspect the selected settings with `swarmforge config show` before switching configurations. See [CONFIGURATION.md](docs/CONFIGURATION.md) for precedence, path resolution, and redacted diagnostics.

## Check setup and start the server

After a new initialization:

```sh
swarmforge doctor
swarmforge serve
```

`doctor` checks local configuration, runtime compatibility, database access, and any configured Git handoff files. It makes no network requests and starts nothing. It exits `1` when a local check fails. Snapshot contents and model compatibility are reported as unverified; a successful local check does not prove those remote systems work. `swarmforge doctor --json` prints structured results.

`serve` runs in the foreground and reconciles persisted workers before accepting normal work. Keep that terminal running. In another terminal:

```sh
swarmforge status
```

Use ↑/↓ to select a worker, Enter for details, `r` to refresh, and `q` to leave the dashboard. The detail view offers pause, resume, cancel, and destroy when available. `swarmforge status --json` or `--no-interactive` prints a snapshot.

| Surface | Default address |
| --- | --- |
| MCP, Streamable HTTP | `http://127.0.0.1:8787/mcp` |
| Liveness | `http://127.0.0.1:8787/health` |
| Prometheus metrics | `http://127.0.0.1:9090/metrics` |

Defaults bind to loopback. To use a remote MCP server, pass `swarmforge status --url https://your-host/mcp` or configure `SWARMFORGE_URL`. Non-loopback server access requires a bearer token of at least 24 characters, accepted host configuration, and externally supplied TLS/network policy. Configure `SWARMFORGE_API_TOKEN` for the clients as well. Teams share trusted access; they are labels, not security tenants.

Stop the foreground server with Ctrl+C. This drains the coordinator and releases the database lock; it does not destroy retained worker VMs. Run one server process per database on persistent local storage.

## Connect an MCP client

Point your AI lead's MCP client at `http://127.0.0.1:8787/mcp` using Streamable HTTP. For OpenCode, add this to its configuration:

```json
{
  "mcp": {
    "swarmforge": {
      "type": "remote",
      "url": "http://127.0.0.1:8787/mcp"
    }
  }
}
```

If server authentication is enabled, add `"headers": {"Authorization": "Bearer {env:SWARMFORGE_API_TOKEN}"}` to that remote entry and make the token available in the client's environment. Restart or reload the client so it reconnects and discovers the tools. Other MCP clients need the same URL, transport, and optional bearer header.

## Run a first task and collect the result

Ask your connected AI lead to call `spawn_worker`. Start with a small task to confirm the worker snapshot, model tools, and repository access:

```json
{
  "name": "spawn_worker",
  "arguments": {
    "team_id": "default",
    "task_id": "first-task",
    "prompt": "Read the repository README and return a short summary of the project. Do not change files. Follow the structured result protocol.",
    "request_id": "first-task-attempt-1"
  }
}
```

1. Keep the returned `worker_id`. Creation returns immediately in `queued`; VM provisioning and OpenCode startup happen asynchronously. Snapshot preparation and repository cloning can take tens of seconds or longer.
2. Use `get_worker`, the dashboard, or `wait_for_state_change` to follow progress. If a worker fails, read its error and `get_worker_logs` before retrying. Reuse the same `request_id` and arguments for a creation retry.
3. Call `get_worker_result` when the task finishes. Results persist in SQLite and survive VM destruction. Use `send_worker_message` for a follow-up in the same OpenCode session; follow-ups wait for the active turn to finish.
4. Collect any artifacts before cleanup. `list_worker_artifacts` paths are relative to `.swarmforge/artifacts`, and `get_worker_artifact` returns a resource link. Read it through MCP `resources/read`, following `next_offset` for files larger than 32 KiB.
5. Call `destroy_worker` when you have preserved the work. Normal destruction checks Git persistence; a refusal reports `recovery_required`. Investigate and persist the source before explicitly considering a forced deletion.

Completed, failed, cancelled, and paused workers can retain billable VMs and consume capacity. Check `get_swarm_status` for leftovers before leaving. All 17 tools are described in [MCP-API.md](docs/MCP-API.md).

For coding tasks, configure `SWARMFORGE_GIT_PUSH_MODE=github-app` or `ssh` to push and verify each worker branch automatically. `get_worker_result.git` then records the branch and commit, with a GitHub compare URL where supported. The default `none` uses your external Git workflow. See [Git handoff configuration](docs/ENVIRONMENT.md).

## Troubleshooting

| Symptom | Next step |
| --- | --- |
| `swarmforge: command not found` | Follow the printed PATH instructions; reload the workspace or use `~/.local/bin/swarmforge`. |
| `init` says `.env` exists | Keep the file and use `doctor --env-file .env`; initialization does not overwrite it. |
| Required settings are missing | Run `swarmforge config path` and `config show`, or explicitly pass `--env-file .env`. |
| The server reports a different persisted owner | Restore the existing instance ID and database path. |
| A bind fails | Check whether another server owns port 8787 or metrics port 9090. |
| Worker provisioning or execution fails | Read `get_worker_logs`; check snapshot tools, Git access, and endpoint/model tool-calling support. |
| Cleanup is refused | Inspect and persist the worker's local Git work and collect artifacts. |

`swarmforge serve --check-config` validates and prints redacted settings without opening a database or contacting a provider. `swarmforge config path|show|validate` offers further diagnostics.

## Build and packaged installation

For development in the checkout:

```sh
bun run init
bun run doctor
bun run serve
# For an existing .env that is not globally registered:
bun run serve -- --env-file .env
bun run status -- --env-file .env
bun run check
bun test
```

Source scripts use the same explicit configuration as the installed command. `bun run dev` starts `serve` with file watching. Build and archive commands are:

```sh
bun run build
bun run package
bun run package:verify
```

If you have downloaded a release archive, place it under `dist/` and set `VERSION` to its version. Verify its checksum before installing:

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

The installed executable needs no checkout or Bun runtime. Only Linux x64 with glibc is currently built and verified. `dist/` is ignored by Git.

For unattended operation, supply your own systemd unit. Use explicit paths and a working directory:

```ini
[Service]
Type=exec
User=operator
WorkingDirectory=/home/operator/my-swarmforge
ExecStart=/home/operator/.local/bin/swarmforge serve --env-file /home/operator/my-swarmforge/.env
TimeoutStopSec=90s
Restart=on-failure
```

`Type=exec` confirms execution, not readiness. `/health` reports liveness; mutating MCP requests receive `503` while startup is gated. `TimeoutStopSec` should exceed the application's default 60-second shutdown deadline. See [SERVE.md](docs/SERVE.md) for lifecycle and exit codes. Setup does not install a service.

Tests use injected provider/agent doubles, real SQLite, MCP transports, and disposable Git repositories. The optional `SWARMFORGE_RUN_SMOKE=true bun run smoke` creates a billable VM using real infrastructure; ordinary tests do not.

Further references: [architecture](docs/ARCHITECTURE.md), [worker protocol](docs/WORKER-PROTOCOL.md), [observability](docs/OBSERVABILITY.md), [configuration](docs/CONFIGURATION.md), and [product improvement list](docs/PRODUCT-ROADMAP.md).
