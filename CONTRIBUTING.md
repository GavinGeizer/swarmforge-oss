# Developing SwarmForge

SwarmForge's coordinator is a Bun/TypeScript application with local SQLite state, MCP tools, and Freestyle/OpenCode adapters. You can build and run its ordinary tests without a Freestyle account, model credentials, or a prepared worker VM. Running real coding workers requires the infrastructure in the [README](README.md#before-you-start).

## Set up a checkout

Use Linux x64 with glibc, Git, and [Bun](https://bun.sh/docs/installation) **1.4.2 or newer**. CI pins 1.4.2; use that version when reproducing a release build. macOS, Windows, ARM64, and musl development are not verified by this project's CI.

```sh
git clone https://github.com/GavinGeizer/swarmforge-oss.git
cd swarmforge-oss
bun --version
bun install --frozen-lockfile
bun run check
bun --no-env-file --config=/dev/null test
bun run build
./dist/swarmforge --version
./dist/swarmforge --help
```

Expected results: dependency installation preserves `bun.lock`, TypeScript/Biome checks pass, tests report no failures, and the compiled executable prints the version from `package.json`. Some tests compile standalone executables and create disposable Git repositories, so they take longer than simple unit tests. The build writes `dist/swarmforge`; it does not install a global command or initialize a deployment.

Use `--no-env-file --config=/dev/null` for tests so Bun does not automatically load a real `.env` or local Bun configuration. Ordinary tests use injected VM/agent doubles, real SQLite, HTTP/MCP transports, and temporary Git repositories. Live smoke tests are opt-in and may incur VM/inference charges. Do not enable `SWARMFORGE_RUN_SMOKE` for routine development.

`bun run setup` is the operator installation flow: it builds, installs to `~/.local/bin`, then runs interactive initialization. Contributors do not need it to check changes. The package is private; the supported installation paths are the release executable and source build.

## Run a coordinator from source

Gather the required provider/model/repository settings first. In a new deployment directory, initialize with an explicit configuration path; this keeps the selection independent of any existing global deployment:

```sh
mkdir -p ~/swarmforge-dev
cd ~/swarmforge-dev
/absolute/path/to/swarmforge-oss/dist/swarmforge init --config "$PWD/config.toml"
```

Back in your checkout, select that deployment explicitly:

```sh
bun run doctor -- --config "$HOME/swarmforge-dev/config.toml"
bun run serve -- --config "$HOME/swarmforge-dev/config.toml"
```

In a second terminal, from the checkout:

```sh
bun run status -- --config "$HOME/swarmforge-dev/config.toml"
```

`serve` runs in the foreground; stop it with Ctrl+C. To watch source files during development, use `bun run dev -- --config "$HOME/swarmforge-dev/config.toml"`. Connect your lead's MCP client to `http://127.0.0.1:8787/mcp`; the terminal dashboard is for inspection, not task entry. Keep one server per database. Configuration is explicit: source scripts do not automatically load `.env` from the checkout. See [configuration precedence](docs/CONFIGURATION.md) and [first-task instructions](README.md#run-a-first-task-and-collect-the-result).

Keep configuration, credentials, databases, and artifacts outside commits. If you put a deployment outside the checkout, the repository's `.gitignore` does not protect that directory.

## Find the implementation

| Area | Files |
| --- | --- |
| CLI parsing, initialization, and diagnostics | `src/cli.ts`, `src/cli/`, `src/settings/` |
| Server startup, ownership lock, and shutdown | `src/serve.ts`, `src/serve-command.ts`, `src/runtime.ts` |
| Durable worker queue and lifecycle | `src/coordinator.ts`, `src/store.ts`, `src/domain.ts` |
| MCP tools and HTTP transport | `src/mcp.ts`, `src/http.ts` |
| VM provisioning and OpenCode sessions | `src/providers/freestyle.ts`, `src/providers/opencode.ts` |
| Artifact preservation and verified downloads | `src/artifacts.ts`, `src/finalization.ts`, `src/artifact-store.ts`, `src/providers/artifact-helper.py` |
| Standalone build, install, and packaging | `scripts/build.ts`, `scripts/install.ts`, `scripts/setup.ts`, `scripts/package.ts` |
| Regression and integration coverage | `tests/` |

Start with [the architecture](docs/ARCHITECTURE.md), [the MCP contract](docs/MCP-API.md), and [the worker protocol](docs/WORKER-PROTOCOL.md). `WorkerProvider` and `CodingAgent` allow injected implementations; shipping a new harness/provider also requires runtime preparation, lifecycle, recovery, and artifact compatibility work.

Cloud account/linking development is kept on separate branches and is excluded from this public release. Cloudflare is not required to develop or operate the local coordinator.

## Check and submit a change

Run focused tests during development, then the checks relevant to your final change:

```sh
bun --no-env-file --config=/dev/null test tests/onboarding.test.ts tests/packaging.test.ts
bun run check
git diff --check
```

For runtime changes, run the ordinary full suite shown above. For binary or archive changes, also run `bun run build`, `bun run package`, and `bun run package:verify`. Packaging requires a Git checkout with a resolvable commit; a source ZIP can build the executable but reports an unknown commit.

Describe the problem, changed behavior, and validation in your pull request. For documentation changes, verify commands against the scripts/CLI and exercise affected installation paths. Preserve the existing license and notices; read [LICENSE](LICENSE) and [licensing notes](docs/licensing/README.md) before using or distributing modified copies. No additional contributor agreement is defined here.
