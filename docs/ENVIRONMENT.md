# Environment configuration

Configuration files are explicit: use `swarmforge init` to create `.env` and register it in the global configuration, or pass `--env-file .env` to `serve`, `doctor`, or `status`. Checkout scripts and the compiled binary do not automatically load files from the current directory. Empty optional entries use their defaults. Required configuration is validated before reconciliation or listening. Never commit credentials.

| Variable | Default / requirement | Purpose |
| --- | --- | --- |
| `FREESTYLE_API_TOKEN` | Required | Control-plane-only Freestyle API key; passed as SDK `apiKey`. |
| `FREESTYLE_SNAPSHOT_ID` | Required | External prepared snapshot ID or provider-supported snapshot slug. |
| `FREESTYLE_API_URL` | `https://api.freestyle.sh` | Freestyle SDK base URL; no `/v5` suffix. |
| `FREESTYLE_VPC` | Unset | Existing private network for external Git/inference access. |
| `SWARMFORGE_WORKER_DOMAIN_SUFFIX` | Unset | Verified wildcard domain suffix for worker endpoints. A worker uses `<worker-slug>.<suffix>`; configure matching wildcard DNS and certificate in Freestyle. Defaults to a unique `style.dev` name. |
| `SWARMFORGE_MODEL_BASE_URL` | Required | OpenAI-compatible chat-completions base URL, normally ending `/v1`. |
| `SWARMFORGE_MODEL_API_KEY` | Required | Worker-scoped inference credential. Use a nonempty placeholder for an unauthenticated endpoint. |
| `SWARMFORGE_MODEL_NAME` | Required | Exact external model ID, e.g. your deployed Qwen ID. |
| `SWARMFORGE_GIT_TREE` | Required | Git URL or local Git path; SwarmForge clones it to `$SWARMFORGE_WORKSPACE/repo` on each worker. Prefix with `none:` (or set `none`) to skip cloning and pass the remainder through as an opaque mount/prepared tree. Credentials stay external. |
| `SWARMFORGE_GIT_PUSH_MODE` | `none` | `github-app` pushes a verified branch with a short-lived GitHub App token; `ssh` uses a dedicated SSH key for a GitHub or reachable machine remote. Both modes require a cloned tree. |
| `SWARMFORGE_GIT_PUSH_TIMEOUT_MS` | `120000` | Timeout for cloning and pushing Git source. |
| `SWARMFORGE_GIT_AUTHOR_NAME` | `SwarmForge Worker` | Git commit author name configured in each worker checkout. |
| `SWARMFORGE_GIT_AUTHOR_EMAIL` | `swarmforge-worker@example.invalid` | Git commit author email; commit metadata only, separate from push authentication. Set this to your preferred attribution. |
| `SWARMFORGE_GITHUB_REPOSITORY` | Required for `github-app` | `owner/repo`; `SWARMFORGE_GIT_TREE` must be the matching HTTPS GitHub URL. |
| `SWARMFORGE_GITHUB_APP_ID` | Required for `github-app` | Numeric GitHub App ID. |
| `SWARMFORGE_GITHUB_INSTALLATION_ID` | Required for `github-app` | Numeric installation ID for the repository owner. |
| `SWARMFORGE_GITHUB_PRIVATE_KEY_PATH` | Required for `github-app` | Absolute path to the App private key on the control-plane host. |
| `SWARMFORGE_GIT_PUSH_URL` | Required for `ssh` | SSH Git remote accepting branch pushes, e.g. `git@github.com:owner/repo.git` or `git@your-host:repo.git`. |
| `SWARMFORGE_GIT_SSH_KEY_PATH` | Required for `ssh` | Absolute path to a dedicated write key on the control-plane host. |
| `SWARMFORGE_GIT_SSH_KNOWN_HOSTS_PATH` | Required for `ssh` | Absolute path to pinned SSH host keys. Strict host-key checking stays enabled. |
| `SWARMFORGE_INSTANCE_ID` | `default` | Stable ownership namespace, 1–16 lowercase alphanumeric characters. Unique per independent database in an account. Do not change after deployment. |
| `SWARMFORGE_WORKSPACE` | `/workspace` | Absolute guest directory; safe path characters only. Snapshot/mount provider prepares it. |
| `OPENCODE_PORT` | `4096` | Guest server port, 1–65535. |
| `OPENCODE_START_COMMAND` | `opencode serve --hostname 0.0.0.0 --port "$OPENCODE_PORT"` | Administrator-supplied command run by the guest systemd service. Keep it compatible with the configured port. |
| `SWARMFORGE_DB_PATH` | `$XDG_DATA_HOME/swarmforge/swarmforge.sqlite`, otherwise `~/.local/share/swarmforge/swarmforge.sqlite` | Persistent local SQLite file. `init` sets an absolute path to `data/swarmforge.sqlite` in the initialization directory. Existing explicit paths stay in effect; no database is migrated. Server disallows `:memory:`. Parent directory is created. |
| `SWARMFORGE_HOST` | `127.0.0.1` | MCP and metrics listen interface. |
| `SWARMFORGE_ALLOWED_HOSTS` | Empty | Comma-separated public hostnames/IPs accepted in addition to loopback and the bind address. Set for a reverse proxy or wildcard bind; host validation prevents DNS rebinding. Any non-loopback entry here also requires `SWARMFORGE_API_TOKEN`, even when `SWARMFORGE_HOST` stays on loopback. |
| `SWARMFORGE_PORT` | `8787` | MCP HTTP port. |
| `SWARMFORGE_API_TOKEN` | Unset on loopback | Shared trusted-lead bearer token, minimum 24 characters. Required whenever any accepted hostname is non-loopback, which includes a public entry in `SWARMFORGE_ALLOWED_HOSTS` and a non-loopback `SWARMFORGE_HOST`. When it is set, every accepted hostname requires the token, so a loopback-only deployment cannot reach a proxied hostname anonymously. No per-team authorization. |
| `SWARMFORGE_MAX_WORKERS` | `50` | Retained VMs plus provisioning reservations; completed/paused/failed VMs consume capacity until destroyed or confirmed lost. |
| `SWARMFORGE_MAX_PROVISIONING` | `4` | Concurrent provisioning/booting workers. |
| `SWARMFORGE_MAX_QUEUE` | `1000` | Creation queue bound; above it callers receive an error. |
| `SWARMFORGE_DEFAULT_TIMEOUT_SECONDS` | `3600` | Per-turn wall-clock budget, overridable by spawn. Explicit pause suspends the budget. |
| `SWARMFORGE_PROVISION_TIMEOUT_SECONDS` | `300` | Budget for provisioning and OpenCode startup. |
| `SWARMFORGE_TOKEN_IDLE_TIMEOUT_SECONDS` | `300` | Quiesce an active, incomplete dispatch that records no increase in cumulative token usage for this long; `0` disables the stop. |
| `SWARMFORGE_POLL_INTERVAL_MS` | `2000` | Worker polling interval; owned-VM reconciliation also runs periodically. |
| `SWARMFORGE_API_TIMEOUT_MS` | `30000` | Bound on external operations. A timed-out provider operation may still finish remotely and is reconciled. |
| `SWARMFORGE_METRICS_ENABLED` | `true` | Exactly `true` or `false`. |
| `SWARMFORGE_METRICS_PORT` | `9090` | Separate Prometheus listener; must differ from MCP port. Protect externally if public. |
| `SWARMFORGE_METRICS_TEAMS` | `default` | Comma-separated team label allowlist; all other IDs aggregate under `other`. |
| `SWARMFORGE_ARTIFACT_DIR` | `artifacts` beside `SWARMFORGE_DB_PATH` | Absolute private storage root for preserved artifacts and diagnostics. An in-memory database uses a private temporary directory, so nothing lands in a world-readable place. |
| `SWARMFORGE_ARTIFACT_MAX_BYTES` | `1073741824` | Maximum bytes for one captured file or archive. A larger source is refused, never truncated. |
| `SWARMFORGE_ARTIFACT_MAX_ENTRIES` | `10000` | Maximum entries described by one directory listing or snapshot. |
| `SWARMFORGE_ARTIFACT_MAX_DEPTH` | `32` | Maximum directory depth a listing or snapshot may describe. |
| `SWARMFORGE_ARTIFACT_TIMEOUT_MS` | `120000` | Deadline for one capture, combining the caller's cancellation with this bound. |
| `SWARMFORGE_FINALIZATION_MAX_ATTEMPTS` | `3` | Automatic collection attempts per worker. Once exhausted, preservation reports failure, the VM is retained and `retry_worker_finalization` remains available. |
| `SWARMFORGE_FINALIZATION_RETRY_MS` | `2000` | Backoff before the next automatic attempt; it doubles with each attempt. |
| `SWARMFORGE_ARTIFACT_CONCURRENCY` | `4` | Concurrent artifact transfers, including direct MCP calls and lifecycle collection. |
| `SWARMFORGE_RUN_SMOKE` | `false` | Script-only explicit opt-in for a real billable smoke VM. |

Worker environment includes worker/team/task IDs, Git location, workspace, model API key, and the OpenCode port/config/authentication settings. The model URL/name live in the guest OpenCode configuration. Each server receives an independent random password, retained privately in SQLite. Freestyle credentials and the MCP bearer token are never deliberately copied into the guest.

## Token idle stop

A dispatched turn can stall without any provider or task error, so SwarmForge also bounds recorded token progress. Each worker keeps a durable progress timestamp and cumulative token total. The clock starts when a dispatch is claimed, which also bounds turns that never record a token; it restarts on every recorded increase, restarts for each follow-up, and shifts by the time the worker was paused. A restart reuses the stored timestamp instead of restarting the budget. Only an active dispatch without a result is eligible: completion recognized once the turn settles and any Git push or branch verification return before this check, and a failed status poll leaves the clock untouched. A turn settles when `/session/status` reports idle or no longer lists the session, while a status type this version does not recognize is never settled and is resolved by this budget instead. Long tool calls and provider retries can also have no recorded token increase, so raise the value for those workloads; set `0` to leave them to the task deadline. When the budget expires, SwarmForge stops the guest OpenCode service through the same safe path used for task timeouts, keeps the VM, and records `failed`, or `recovery_required` when the workspace holds uncommitted or unpushed work.

For branch handoff, SwarmForge creates `swarmforge/<team>/<task>/<worker-id>` from the cloned default branch before OpenCode starts. The worker commits its source changes. SwarmForge then supplies the configured credential only for Git operations, pushes `HEAD` to that branch, checks the remote SHA, and removes the temporary guest credential. The result records `git.branch`, `git.commit`, `git.base_commit`, `git.persisted=true`, and a GitHub compare URL in GitHub App mode. If a push or verification fails, completion is retried until the task deadline; the VM stays available for recovery. GitHub Apps need repository Contents write permission; the token request is restricted to the configured repository. A local machine remote needs an SSH server reachable from the worker VM and a bare repository or a server configured to accept branch updates.

To use GitHub App handoff, create an App with **Contents: Read and write**, install it on the target repository, generate a private key, and put that key on the control-plane host. Set `SWARMFORGE_GIT_TREE=https://github.com/owner/repo.git`, `SWARMFORGE_GIT_PUSH_MODE=github-app`, the repository, App ID, installation ID, and private-key path above. SwarmForge requests a new repository-scoped installation token for clone and push; it does not store that token in SQLite or the worker result.

To use SSH handoff, set `SWARMFORGE_GIT_TREE` to a cloneable Git URL, `SWARMFORGE_GIT_PUSH_MODE=ssh`, and the SSH push URL, key path, and pinned `known_hosts` path above. On GitHub, use a write-enabled deploy key for that repository. For a local machine, expose an SSH Git endpoint reachable from Freestyle VMs and point the push URL at its bare repository. The dedicated key is copied to the worker only during clone and push and then removed; protect that VM while it is running.

Preserved artifact bytes are private to the coordinator process and share its bearer access: they are only served through the authenticated, attachment-only download route described in [ARTIFACTS.md](ARTIFACTS.md). `SWARMFORGE_ARTIFACT_DIR` and its database live on the same volume as the coordinator, so include them in that volume's backups; `bun scripts/artifact-salvage-smoke.ts --freestyle <vm-id>` salvages a retained VM into a private snapshot without touching the live database or the VM itself.

Keep snapshots free of infrastructure credentials. SQLite contains prompts and worker server passwords; permissions are restricted, but disk encryption and backups are deployment responsibilities. Logs use `<DB_PATH>.log` and one rotated backup, each capped at approximately 1 MiB. The process lock is `<DB_PATH>.lock`.
