# Configuration files

[ENVIRONMENT.md](ENVIRONMENT.md) documents the environment variables and stays valid. This
document adds an optional TOML config file that carries the same settings, so a deployment can
keep non-secret values in version control and credentials in a private environment file. Both
work together; the config file wins over the environment except where an environment file or an
explicit override says otherwise.

## Selecting a config file

1. An explicit path (`--config PATH`, or `configPath` in the API) replaces discovery. Relative
   paths anchor at the directory the command was invoked from.
2. `SWARMFORGE_CONFIG` selects a file when no explicit path is given. It is read from the
   overrides and then the process environment, never from an environment file, because the file
   to read must be known before any file is read. Relative paths anchor at the invocation
   directory. A selected file that does not exist is an error.
3. Otherwise `$XDG_CONFIG_HOME/swarmforge/config.toml` is used when `XDG_CONFIG_HOME` is
   absolute, else `~/.config/swarmforge/config.toml`. A missing default config is not an error;
   `resolveServerSettings` then reports `configPath: null` and uses defaults plus the environment.

A relative `XDG_CONFIG_HOME` or `XDG_DATA_HOME` is ignored rather than resolved against the
working directory. SwarmForge never searches the working directory or its parents for a config
file, so a checkout cannot change the configuration of a service.

Reading configuration is read-only: no directory, database, log or lock file is created, and no
existing file is modified or chmodded. Create the config and environment files yourself with
restrictive permissions (`install -m 600 …`, `chmod 600`), because they hold credentials.

## Example

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

`schema_version = 1` is required. Unknown keys and unknown tables are rejected instead of
ignored, so a typo fails immediately. Numbers accept a TOML integer or a digit string, booleans
accept a TOML boolean or `true`/`false`, and every string value follows the rules for that
setting in [ENVIRONMENT.md](ENVIRONMENT.md). An empty string means "unset", exactly as an empty
environment variable does.

## Schema

Top-level keys are `schema_version`, `env_file` and the tables below. Every key is optional
except `schema_version`.

| Key | Type | Setting | Notes |
| --- | --- | --- | --- |
| `env_file` | string | – | One environment file applied right after this file. Anchors at the config directory. |
| `client.url` | string | `SWARMFORGE_URL` | MCP endpoint, default `http://127.0.0.1:8787/mcp`. Must be http or https. |
| `client.token` | string | `SWARMFORGE_API_TOKEN` | Bearer token. Credential. |
| `server.host` | string | `SWARMFORGE_HOST` | Listen interface. |
| `server.port` | int | `SWARMFORGE_PORT` | MCP port. |
| `server.db_path` | path | `SWARMFORGE_DB_PATH` | SQLite file; `:memory:` is kept verbatim. |
| `server.allowed_hosts` | string | `SWARMFORGE_ALLOWED_HOSTS` | Comma-separated public hostnames. |
| `server.api_token` | string | `SWARMFORGE_API_TOKEN` | Trusted-lead bearer token. Credential. |
| `server.metrics_enabled` | bool | `SWARMFORGE_METRICS_ENABLED` | Prometheus listener. |
| `server.metrics_port` | int | `SWARMFORGE_METRICS_PORT` | Must differ from `server.port`. |
| `server.metrics_teams` | string | `SWARMFORGE_METRICS_TEAMS` | Team label allowlist. |
| `provider.freestyle.api_url` | string | `FREESTYLE_API_URL` | Freestyle SDK base URL. |
| `provider.freestyle.api_token` | string | `FREESTYLE_API_TOKEN` | Control-plane-only key. Credential. |
| `provider.freestyle.snapshot_id` | string | `FREESTYLE_SNAPSHOT_ID` | Prepared snapshot. |
| `provider.freestyle.vpc` | string | `FREESTYLE_VPC` | Optional existing network. |
| `model.base_url` | string | `SWARMFORGE_MODEL_BASE_URL` | OpenAI-compatible base URL. |
| `model.api_key` | string | `SWARMFORGE_MODEL_API_KEY` | Worker-scoped inference key. Credential. |
| `model.name` | string | `SWARMFORGE_MODEL_NAME` | Exact model ID. |
| `git.tree` | string | `SWARMFORGE_GIT_TREE` | Clone URL, local path, or `none[:tree]`. |
| `git.push_mode` | string | `SWARMFORGE_GIT_PUSH_MODE` | `none`, `github-app` or `ssh`. |
| `git.push_timeout_ms` | int | `SWARMFORGE_GIT_PUSH_TIMEOUT_MS` | Clone and push budget. |
| `git.author_name` | string | `SWARMFORGE_GIT_AUTHOR_NAME` | Commit author name. |
| `git.author_email` | string | `SWARMFORGE_GIT_AUTHOR_EMAIL` | Commit author email. |
| `git.github_app.repository` | string | `SWARMFORGE_GITHUB_REPOSITORY` | `owner/repo`. |
| `git.github_app.app_id` | string | `SWARMFORGE_GITHUB_APP_ID` | Numeric App ID. |
| `git.github_app.installation_id` | string | `SWARMFORGE_GITHUB_INSTALLATION_ID` | Numeric installation ID. |
| `git.github_app.private_key_path` | path | `SWARMFORGE_GITHUB_PRIVATE_KEY_PATH` | Private key on this host. |
| `git.ssh.push_url` | string | `SWARMFORGE_GIT_PUSH_URL` | SSH remote accepting pushes. |
| `git.ssh.key_path` | path | `SWARMFORGE_GIT_SSH_KEY_PATH` | Dedicated write key on this host. |
| `git.ssh.known_hosts_path` | path | `SWARMFORGE_GIT_SSH_KNOWN_HOSTS_PATH` | Pinned host keys on this host. |
| `workspace.guest_path` | string | `SWARMFORGE_WORKSPACE` | Absolute directory inside the worker; never anchored or expanded. |
| `workspace.instance_id` | string | `SWARMFORGE_INSTANCE_ID` | Ownership namespace. |
| `workspace.opencode_port` | int | `OPENCODE_PORT` | Guest server port. |
| `workspace.opencode_start_command` | string | `OPENCODE_START_COMMAND` | Guest start command. |
| `workspace.worker_domain_suffix` | string | `SWARMFORGE_WORKER_DOMAIN_SUFFIX` | Verified wildcard suffix. |
| `limits.max_workers` | int | `SWARMFORGE_MAX_WORKERS` | Retained VMs plus reservations. |
| `limits.max_provisioning` | int | `SWARMFORGE_MAX_PROVISIONING` | Concurrent provisioning. |
| `limits.max_queue` | int | `SWARMFORGE_MAX_QUEUE` | Creation queue bound. |
| `limits.default_timeout_seconds` | int | `SWARMFORGE_DEFAULT_TIMEOUT_SECONDS` | Per-turn budget. |
| `limits.provision_timeout_seconds` | int | `SWARMFORGE_PROVISION_TIMEOUT_SECONDS` | Boot and provider startup budget. |
| `limits.token_idle_timeout_seconds` | int | `SWARMFORGE_TOKEN_IDLE_TIMEOUT_SECONDS` | Quiesce budget; `0` disables. |
| `limits.poll_interval_ms` | int | `SWARMFORGE_POLL_INTERVAL_MS` | Poll and reconcile interval. |
| `limits.api_timeout_ms` | int | `SWARMFORGE_API_TIMEOUT_MS` | External call bound. |

Every setting is validated by the existing server loader, so the public bind and bearer-token
rules in [ENVIRONMENT.md](ENVIRONMENT.md) are unchanged: a non-loopback accepted hostname still
requires `server.api_token`.

Client settings need no provider, model or server settings; `resolveClientSettings` reads only
`client.url` and `client.token` (plus `SWARMFORGE_URL`, `SWARMFORGE_API_TOKEN` and the
`SWARMFORGE_MCP_URL` / `SWARMFORGE_MCP_TOKEN` aliases).

## Precedence

Later layers win, and each key is replaced rather than merged, so a comma-separated list in a
later layer replaces the earlier list:

1. Defaults, including the database default below.
2. The selected config file.
3. The config file's `env_file`.
4. Each explicit environment file, in the order given.
5. The process environment.
6. Explicit overrides.

Only `SWARMFORGE_*`, `FREESTYLE_*` and `OPENCODE_*` variables listed above are read; unrelated
variables such as `PATH` are ignored and never appear in a resolved value. An empty value counts
as unset and leaves the lower layer in place.

The database defaults to `$XDG_DATA_HOME/swarmforge/swarmforge.sqlite` when `XDG_DATA_HOME` is
absolute, else `~/.local/share/swarmforge/swarmforge.sqlite`. This replaces the environment-only
default `./data/swarmforge.sqlite`. A database path that *is* set is never relocated: a relative
value from an environment file or the environment anchors at the invocation directory and becomes
absolute there, so an existing deployment keeps using the file it has been writing to.

## Paths

| Declared in | Relative paths anchor at | `~` |
| --- | --- | --- |
| Config file (`server.db_path`, `git.*_path`, `env_file`) | The config file's own directory | Expands to the home directory |
| Command line (`--config`, `--env-file`) | The invocation directory | Expands to the home directory |
| Environment file or environment | The invocation directory | Expands to the home directory |
| `[workspace] guest_path` | Never anchored: it is a path inside the worker | Not expanded |

`:memory:` is passed through unchanged so a client or a test can use an in-memory database;
`swarmforge serve` must still refuse it, as the server requires a persistent database.

## Environment files

Environment files hold credentials and use the same syntax as `.env`:

```sh
# comments start a line
export FREESTYLE_API_TOKEN="file-token"   # trailing comment on an unquoted value
SWARMFORGE_MODEL_API_KEY='literal $HOME'
SWARMFORGE_MODEL_NAME=plain-${FREESTYLE_SNAPSHOT_ID}-model
SWARMFORGE_GIT_AUTHOR_NAME="$(echo not-run) `id`"
```

- One `KEY=value` assignment per line, with an optional `export`. A line that is not an
  assignment is an error rather than a silent no-op, and a selected file that does not exist is an
  error.
- Single quotes are literal. Double quotes and unquoted values interpolate `$NAME` and
  `${NAME}` from variables defined earlier in the same file, then from the process environment; an
  unknown name is left as written. A `#` preceded by whitespace starts a comment on an unquoted
  value.
- Nothing is executed. `$(…)`, backticks and `\` are never evaluated, and there is no shell,
  glob or command substitution. `\n`, `\t`, `\r`, `\"`, `\\` and `\$` are the escapes recognised
  inside double quotes.
- An empty value (`KEY=`) means unset, matching the environment loader.

## Redaction

`redactedSettings` in `src/settings/inspect.ts` renders resolved settings as plain
JSON-serializable data: `config_path`, `values`, `sources` and `secrets`. Credential keys
(`client.token`, `server.api_token`, `provider.freestyle.api_token`, `model.api_key`) always show
`[REDACTED]`, and every value, source label and path is scanned for resolved credential
material, so a token copied into another setting, an endpoint, a file name or a path is still
removed.

Every nonempty credential counts, however short. The loader accepts any string, so a
one-character credential is a credential and is removed from every field, source and message.
The cost is over-redaction: a very short credential also matches ordinary characters, and text
around it is replaced with `[REDACTED]`. Prefer real tokens; when a diagnostic looks heavily
redacted, suspect a short credential rather than a leak.

`values` and `sources` report exactly the same keys: a setting that resolved to no value, such as
an unset `client.token`, appears in neither. The raw `value` and `provenance` returned by the
resolvers are not safe to print; render them with `redactedSettings`.

Validation and parse errors are scrubbed the same way, including credential material that a
later layer superseded and credential material in the file path of a failed read, so a
diagnostic can be printed without leaking a token that appears in an unexpected field. Credential
values in the environment, in the overrides and in the config or environment file being read are
collected before any file is opened, so even a failure to read a selected file reports a scrubbed
path. Only emitted text is scrubbed: the path that is read and `ResolvedSettings.configPath` are
the real paths. Every
message, path and rendered field also has C0 and C1 control characters removed, so a value
carrying an escape sequence cannot drive the terminal of whoever reads the output. Diagnostics
report file paths and line numbers, never file content.

## Command integration

`src/settings/load.ts` exports the whole interface a command needs:

```ts
import {
  resolveServerSettings,
  resolveClientSettings,
  SettingsError,
} from "./settings/load";
import { redactedSettings } from "./settings/inspect";

const { value: config, configPath, provenance } = await resolveServerSettings({
  configPath: options.config, // --config, may be undefined
  envFiles: options.envFile ? [options.envFile] : undefined, // --env-file
  overrides: options.overrides, // --set KEY=VALUE, applied last
});
```

- `resolveServerSettings(options?)` returns `ResolvedSettings<Config>`; `Config` is the unchanged
  server configuration type, so existing code keeps compiling. A `serve` command must still
  reject `:memory:` and must keep the single-database and instance-ID rules.
- `resolveClientSettings(options?)` returns `ResolvedSettings<ClientSettings>` with `url` and an
  optional `token`; send the token as `Authorization: Bearer <token>`. It validates the scheme
  and leaves the path untouched, so `status --url http://host/` can still normalize `/` to
  `/mcp`.
- `configPath` is `null` when no config file contributed values, which is what a `config show`
  command should print for "defaults only".
- `provenance` is keyed by the internal setting name (`SWARMFORGE_PORT`) for server settings and
  by `url` / `token` for client settings. Values are `default`, `config:<absolute path>`,
  `env_file:<absolute path>`, `env` or `override`, which is what `config show` should display as
  the source of each value.
- `SettingsOptions.env` replaces the process environment entirely, which keeps tests and
  `config show --env-file` deterministic. Without it the process environment is used.
- `SettingsOptions.cwd` is the directory explicit paths anchor at; it defaults to the process
  working directory.

Failures throw `SettingsError` with `code` and `path`:

| Code | Meaning |
| --- | --- |
| `config_not_found` | The selected config file does not exist. |
| `config_invalid` | TOML syntax error, wrong `schema_version`, unknown key, or unreadable file. |
| `env_file_not_found` | A selected environment file does not exist. |
| `env_file_invalid` | A malformed environment file line or an unreadable file. |
| `invalid_config` | Resolved values rejected the existing server validation. |
| `invalid_client` | Client endpoint is not a valid http or https URL. |

Every message and `path` is already credential-free and control-character-free, so a command
can print `error.message` directly; `error.code` selects the exit behaviour.

## Migrating from `.env`

1. Move non-secret values into a `config.toml` with `schema_version = 1`.
2. Move `FREESTYLE_API_TOKEN`, `SWARMFORGE_MODEL_API_KEY`, `SWARMFORGE_API_TOKEN` and any other
   credential into `secrets.env`, declare `env_file = "secrets.env"`, and create both files with
   `chmod 600`.
3. Keep the process environment for anything a supervisor injects; it still wins over env files,
   so an existing systemd environment keeps working unchanged.
4. Set `SWARMFORGE_DB_PATH` in `.env` to the current database path, or leave it alone to adopt
   the new XDG default once. Verify the reported path with `config show` before deleting
   anything; SwarmForge never moves an existing database.
