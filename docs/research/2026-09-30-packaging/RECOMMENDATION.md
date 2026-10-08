# Binary packaging, global configuration, and serve

Research date: 2026-09-30. Repository baseline: `5672ead2a526e07fea9ed11e58b3725e42013527`.

## Recommendation

Ship one standalone `swarmforge` executable compiled with Bun. Its `status` command remains a remote MCP client, and a new `serve` command runs the control plane in the foreground. Load configuration explicitly from a global TOML file, keep the database at an absolute persistent location, and disable automatic loading of files from the invocation directory. Start with a tested Linux x64 release; expand platform support only after running the packaged program on those platforms.

This is a research recommendation, not an implemented feature. The local source was not changed. Build probes were isolated under `/tmp`.

## Evidence and decisions

Three Swarmforge researchers examined packaging, configuration, and lifecycle independently. Their original reports are retained as evidence, with caveats below:

- [Packaging report](binary-packaging.md): compile/distribution alternatives and isolated build experiments on Bun 1.3.14. The run exceeded its deadline; the artifact was recovered, but there is no settled structured success result.
- [Configuration report](global-config.md): paths, precedence, schemas, and migration. The first run was quiesced for no token progress. A follow-up wrote the report, but did not settle its Git handoff; it was cancelled after evidence collection. No settled structured success result is claimed.
- [Serve report](serve-lifecycle.md): module boundaries and startup/shutdown gaps. This worker completed with run ID `57149483-10ef-49ce-af6a-4d154252ca37` and a structured result. Its lifecycle experiments used a synthetic harness, not the real provider-backed service.

The lead checked the repository, official Bun/XDG/systemd documentation, and built a unified dispatcher using Bun 1.4.2. Worker recommendations are proposals; findings below distinguish measured behavior from inference.

### One executable

The packaging report recommends two executables, while the lifecycle report recommends one. Choose one for the requested `swarmforge serve` UX. Load server modules only after selecting `serve`; `status`, help, and version must work without server credentials, SQLite initialization, or process-lock acquisition.

The claim that combining entrypoints adds roughly another entire Bun runtime is incorrect. Both standalone programs already embed Bun. The lead measured:

| Probe | Unminified compiled size |
| --- | ---: |
| Current client entrypoint | 81,917,408 bytes |
| Client plus dynamically selected existing server entrypoint | 82,658,784 bytes |
| Difference | 741,376 bytes, about 0.71 MiB |

Both builds used `--no-compile-autoload-dotenv --no-compile-autoload-bunfig`. The unified probe's `--help` exited 0 from `/tmp` without requiring infrastructure settings. This verifies bundling and command isolation on Linux x64, not successful server startup or portability to another operating system.

The probe imported the current `main.ts` only when `serve` was selected. Production should extract an explicit server API instead of relying on the current module's import side effects.

### Distribution

Use versioned GitHub Release archives with a `swarmforge` binary, version/commit metadata, and SHA-256 checksums. Provide manual installation to `~/.local/bin` first; an installer can follow with platform detection, checksum verification, and atomic replacement. It should explain a missing PATH entry without automatically editing shell startup files.

Pin the build toolchain, initially Bun 1.4.2, and run a clean frozen dependency install before compilation. The worker's Bun 1.3.14 rejected this repository's version-2 lockfile. Treat that as an advertised minimum-version/toolchain compatibility issue; do not downgrade the lockfile based on one older worker environment. Test and document the exact supported source-build version.

Example build shape, after the unified CLI is implemented:

```sh
bun build --compile \
  --no-compile-autoload-dotenv \
  --no-compile-autoload-bunfig \
  ./src/cli.ts --outfile ./dist/swarmforge
```

Keep bytecode/startup optimization optional until measured. Compile success alone is insufficient to advertise macOS, Windows, arm64, or musl support. A unified binary can retain a portable client path while explicitly rejecting `serve` on unsupported platforms before server initialization.

The current lock uses `bun:ffi` to call libc `flock` (`src/runtime.ts:106`). Generic `libc.so.6` can work on Linux glibc architectures beyond x64; its presence does not prove arm64 failure. The hardcoded musl x64 fallback warrants testing on arm64 musl. Do not replace the proven advisory lock with a weaker stale-PID or exclusive-create mechanism merely to expand packaging targets.

Worker VM prerequisites such as OpenCode, Git, Bash, Python, and systemd belong to the external snapshot. They are not automatically requirements on the control-plane host. Verify actual host-side dependencies separately.

### Global configuration

Use a versioned TOML file and the existing Zod validation rules. Bun provides TOML parsing; the local Bun 1.4.2 probe successfully parsed the example format. Keep a client loader and server loader separate: status needs an endpoint and optional bearer credential, while serve requires provider/model/repository configuration.

Recommended initial Linux locations, respecting absolute XDG overrides:

| Purpose | Default |
| --- | --- |
| Config | `~/.config/swarmforge/config.toml` |
| Protected environment file | `~/.config/swarmforge/secrets.env` |
| SQLite and its adjacent lock | `~/.local/share/swarmforge/swarmforge.sqlite` and `.lock` |
| Logs | Initially the existing `<db>.log`; optionally move to `~/.local/state/swarmforge/` with an explicit log-path setting |
| Installed executable | `~/.local/bin/swarmforge` |

Using XDG data home for the database is a design choice: worker history, ownership, and results must be backed up, not treated as disposable cache. XDG state home is a reasonable alternative for application state, but the location must be explicit and durable. XDG config/data/state paths must be absolute; ignore invalid relative overrides according to the specification. Preserve existing directories' permissions, create private application directories with `0700`, and protect newly created credential/database files with `0600`.

Default file discovery should select one global user config. `--config PATH` replaces that selection; administrators can explicitly choose `/etc/swarmforge/config.toml`. Avoid automatic merging of system, user, and project configurations in the first release.

Precedence, lowest to highest:

1. Built-in defaults.
2. The selected TOML file.
3. A protected environment file selected by the TOML file, if present.
4. Explicit `--env-file PATH` inputs in their documented order.
5. Actual process environment using the existing supported variable names, including `FREESTYLE_*` and `OPENCODE_*`.
6. Explicit command flags.

Replace arrays rather than concatenating them. Reject unknown keys in the dedicated TOML schema while ignoring unrelated process environment variables. Preserve the existing token requirement for accepted public hosts and the worker credential allowlist.

Resolve relative file paths in TOML against that file's directory. Resolve explicit CLI paths against the invocation directory and immediately make them absolute. Document `~` expansion; do not execute shell substitutions. Preserve legacy relative database paths when an existing deployment explicitly selects its old environment file, with an instruction to pin the database path absolutely. Silently reinterpreting an old path against a new directory can create a second database.

Neither client nor server should automatically read arbitrary repository `.env` or project configuration in this release. A client endpoint override can redirect where its bearer token is sent, so project discovery needs an explicit trust model. Project registration is later work.

Provide `swarmforge config path`, `config show`, `config validate`, and `serve --check-config`. Inspection output should be redacted by default, name value provenance, and never reveal token fragments or execute remote work. Help/version/config inspection must not create a database or lock.

Minimal proposed TOML shape:

```toml
schema_version = 1
env_file = "secrets.env"

[client]
url = "http://127.0.0.1:8787/mcp"

[server]
host = "127.0.0.1"
port = 8787
db_path = "~/.local/share/swarmforge/swarmforge.sqlite"

[git]
tree = "https://github.com/owner/repo.git"
push_mode = "none"
```

This is a proposed public schema. Map it explicitly to the existing internal config fields; server secrets and the remaining required infrastructure settings can use the selected protected environment file initially. Credentials should not be embedded in release artifacts. OAuth/keyring integration is a later extension.

Migration must preserve the existing database, instance ID, worker ownership, and known credential files. Do not automatically move a live SQLite database or copy only its main file while WAL writes are active. Start with explicit old-path configuration; offer a separate, quiesced migration or SQLite backup workflow later.

### Foreground serve

Extract `src/main.ts` into an import-safe server module exporting an explicit startup function and handle with an idempotent asynchronous stop operation. Retain a thin `main.ts` wrapper so `bun start` and the existing development workflow continue working.

Proposed commands:

```sh
swarmforge serve
swarmforge serve --config /absolute/path/config.toml
swarmforge serve --env-file /absolute/path/legacy.env
swarmforge serve --check-config
swarmforge status
swarmforge --version
```

Install signal handling before long startup work. Establish one resource cleanup path for every partial startup failure: database open, ownership mismatch, reconciliation, API bind, metrics bind, or logger creation. Avoid starting the coordinator's periodic provisioning before discovering that a required listener cannot bind. If listeners are reserved before recovery completes, return not-ready responses and reject mutating requests until startup succeeds.

On shutdown, stop accepting new work, stop/drain coordination, flush logs, close the database, and release the process lock. Repeated signals should share one cleanup promise. A shutdown deadline does not cancel pending operations: do not close SQLite while an in-flight worker operation can still write to it. If drain cannot finish, use a documented bounded process-exit policy and rely on durable intent plus kernel lock release for restart recovery. Pick a deadline based on actual API timeouts/drain behavior rather than an arbitrary value shorter than normal provider calls.

Keep `/health` as liveness. Add `/ready` only with explicit startup/shutdown readiness semantics. In the current implementation the API starts after initial recovery; claims that `/health` is reachable during that initial recovery are not demonstrated. Partial startup and shutdown are the concrete gaps.

Use external supervision. A systemd unit can run `swarmforge serve --config ...` with `Type=exec`, `Restart=on-failure`, explicit state/config paths, and a stop timeout greater than the application deadline. `Type=exec` detects failure to invoke the binary, but does not prove application readiness. Do not use `Type=notify` until Swarmforge actually sends notifications. Builtin daemonization, PID-based stop commands, and automatic service installation add complexity without solving the existing process-lock requirement.

Systemd hardening that blocks executable mappings can conflict with Bun's JIT/FFI; test the actual compiled service before shipping a hardened unit. Service installation and release publication remain separate actions from building the binary.

## Implementation sequence and acceptance gates

1. **Configuration boundary:** global path resolution, TOML/env layering, source provenance, client/server validation, explicit compatibility path. Verify two unrelated working directories resolve the same config/database, ambient `.env` is ignored, overrides behave consistently, and diagnostic output reveals no secrets or creates state.
2. **Server boundary:** extract explicit startup/stop, add foreground serve and thin old wrapper. Verify API/metrics port conflicts unwind resources; early/repeated signals settle; database-owner mismatch does not leak resources; second processes are refused; restart retains results; shutdown cannot write through a closed store.
3. **Binary build:** pin Bun, clean frozen install, version/commit metadata, compile with runtime autoload disabled. Run the compiled help/status/config/serve paths in a clean environment without Bun or node_modules. Validate SQLite and advisory locks inside the packaged runtime.
4. **Release packaging:** archives, checksums, manual install instructions, native execution tests for each advertised target. A tag workflow may prepare a release draft; actual publishing follows the repository's release authority.
5. **Optional supervision:** a documented systemd unit with tested shutdown and explicit config/state paths. Expand OS/architecture support only when runtime gates pass.

A first implementation can remain one-repository-per-server. Multiple-repository project identity and GitHub OAuth need separate designs; changing CWD must not silently change an active server's repository or database.

## Corrections to raw researcher reports

- Packaging's approximately 95 MB incremental-size claim is contradicted by its own separate-binary sizes and by the lead's measured 741,376-byte increase. One executable is practical.
- Reaching `main.ts`'s recovery-failure handler does not prove `Bun.serve` executed: listener binding occurs afterwards.
- Packaging's snapshot prerequisites were described as host prerequisites; those are separate environments.
- Configuration's semicolon-separated TOML assignments are invalid. The lead's Bun TOML probe rejected them. Its sample is not an implementation-ready schema.
- The inspected XDG page identifies version 0.8; the raw report's 0.81 claim is not adopted. `/etc/swarmforge` is an application convention, not the same path as the XDG default `/etc/xdg`.
- Client endpoint validation already exists in `src/cli.ts:37`; the required change is client config loading/schema separation, not a claim that the client does no validation.
- Automatic project-file discovery, silent reanchoring of legacy DB paths, token hash fragments in diagnostics, and arbitrary DB-filename restrictions are not adopted.
- Missing architecture-qualified libc paths do not establish Linux glibc arm64 failure. The source already includes generic `libc.so.6`; platform-specific execution is still required.
- Synthetic lifecycle failures indicate areas to test; they are not independent proof of every claimed real coordinator shutdown failure.

## Verified lifecycle and preservation

Team: `packaging-research-20260930`.

| Task | Worker | Final state |
| --- | --- | --- |
| Packaging | `w-99abcec6-8d73-4f9d-a887-568f8f2229f8` | destroyed |
| Configuration | `w-5606a883-3a81-422b-a31d-09b81fbb4b48` | destroyed |
| Serve | `w-f6f7cc4e-8010-437b-b64e-dcbf1a1495f6` | destroyed |

All artifacts were read through Swarmforge resource handles and saved before cleanup. The completed serve worker passed normal destruction. Normal destruction refused the other two because no verified branch handoff was recorded. The lead then independently inspected each VM's current Git status and HEAD: both trees were clean and HEAD was exactly the baseline SHA. `git ls-remote origin refs/heads/master` confirmed that exact commit was durable remotely. With reports preserved and no source work to lose, forced cleanup completed. A final scoped inventory reported all three destroyed, and aggregate status reported no live workers.

## Primary sources checked by the lead

- [Bun standalone executables](https://bun.com/docs/bundler/executables): compilation, platform targets, native SQLite support, and explicit runtime autoload controls.
- [Bun environment variables](https://bun.com/docs/runtime/environment-variables): ambient dotenv behavior and explicit environment-file loading.
- [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir/latest/): config/data/state distinctions, absolute paths, and user executable location.
- [systemd.service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html): foreground service types, supervision, stop deadlines, and readiness notifications.

Those pages were fetched on 2026-09-30. Researcher experiments used Bun 1.3.14; lead compile/TOML probes used Bun 1.4.2. Other OS/architecture execution and the real provider-backed compiled serve lifecycle remain unverified.
