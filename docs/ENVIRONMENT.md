# Environment configuration

Bun loads `.env`. Empty optional entries use their defaults. Required configuration is validated before reconciliation or listening. Never commit credentials.

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
| `SWARMFORGE_INSTANCE_ID` | `default` | Stable ownership namespace, 1–16 lowercase alphanumeric characters. Unique per independent database in an account. Do not change after deployment. |
| `SWARMFORGE_WORKSPACE` | `/workspace` | Absolute guest directory; safe path characters only. Snapshot/mount provider prepares it. |
| `OPENCODE_PORT` | `4096` | Guest server port, 1–65535. |
| `OPENCODE_START_COMMAND` | `opencode serve --hostname 0.0.0.0 --port "$OPENCODE_PORT"` | Administrator-supplied command run by the guest systemd service. Keep it compatible with the configured port. |
| `SWARMFORGE_DB_PATH` | `./data/swarmforge.sqlite` | Persistent local SQLite file. Server disallows `:memory:`. Parent directory is created. |
| `SWARMFORGE_HOST` | `127.0.0.1` | MCP and metrics listen interface. |
| `SWARMFORGE_ALLOWED_HOSTS` | Empty | Comma-separated public hostnames/IPs accepted in addition to loopback and the bind address. Set for a reverse proxy or wildcard bind; host validation prevents DNS rebinding. |
| `SWARMFORGE_PORT` | `8787` | MCP HTTP port. |
| `SWARMFORGE_API_TOKEN` | Unset on loopback | Shared trusted-lead bearer token, minimum 24 characters. Required off loopback. No per-team authorization. |
| `SWARMFORGE_MAX_WORKERS` | `50` | Retained VMs plus provisioning reservations; completed/paused/failed VMs consume capacity until destroyed or confirmed lost. |
| `SWARMFORGE_MAX_PROVISIONING` | `4` | Concurrent provisioning/booting workers. |
| `SWARMFORGE_MAX_QUEUE` | `1000` | Creation queue bound; above it callers receive an error. |
| `SWARMFORGE_DEFAULT_TIMEOUT_SECONDS` | `3600` | Per-turn wall-clock budget, overridable by spawn. Explicit pause suspends the budget. |
| `SWARMFORGE_PROVISION_TIMEOUT_SECONDS` | `300` | Budget for provisioning and OpenCode startup. |
| `SWARMFORGE_POLL_INTERVAL_MS` | `2000` | Worker polling interval; owned-VM reconciliation also runs periodically. |
| `SWARMFORGE_API_TIMEOUT_MS` | `30000` | Bound on external operations. A timed-out provider operation may still finish remotely and is reconciled. |
| `SWARMFORGE_METRICS_ENABLED` | `true` | Exactly `true` or `false`. |
| `SWARMFORGE_METRICS_PORT` | `9090` | Separate Prometheus listener; must differ from MCP port. Protect externally if public. |
| `SWARMFORGE_METRICS_TEAMS` | `default` | Comma-separated team label allowlist; all other IDs aggregate under `other`. |
| `SWARMFORGE_RUN_SMOKE` | `false` | Script-only explicit opt-in for a real billable smoke VM. |

Worker environment includes worker/team/task IDs, Git location, workspace, model API key, and the OpenCode port/config/authentication settings. The model URL/name live in the guest OpenCode configuration. Each server receives an independent random password, retained privately in SQLite. Freestyle credentials and the MCP bearer token are never deliberately copied into the guest.

Keep snapshots free of infrastructure credentials. SQLite contains prompts and worker server passwords; permissions are restricted, but disk encryption and backups are deployment responsibilities. Logs use `<DB_PATH>.log` and one rotated backup, each capped at approximately 1 MiB. The process lock is `<DB_PATH>.lock`.
