# SwarmForge global configuration & state architecture (research)

Inspected commit: `5672ead2a526e07fea9ed11e58b3725e42013527` ("Add vendor-neutral Swarmforge skill")
Branch: `swarmforge/packaging-research-20260930/global-config/w-5606a883-3a81-422b-a31d-09b81fbb4b48`
Workspace: `/workspace/repo` — `git status --porcelain` empty **before and after** (0 lines both times). No repo file changed; no commit made.
Date of research: 2026-09-30. Runtime used for experiments: `bun 1.3.14` (Linux x64).

## 1. Current-state evidence (file:line)

- `src/config.ts:153-164` — `loadConfig(env = process.env)` parses **the whole process environment**; unknown keys are silently dropped (non-strict) and empty strings are filtered (`:157`).
- `src/config.ts:25-93` — flat `SCREAMING_CASE` schema, no file layer, no provenance, comma-string lists (`:21`, `:92`).
- `src/config.ts:94-151` — server-only cross-field validation (`superRefine`): push mode requires cloned tree, GitHub App key requirements, metrics≠server port, and **`SWARMFORGE_API_TOKEN` required for any non-loopback accepted host** (`:135-141`).
- `src/config.ts:63-67` — secret material must be **absolute** (`startsWith("/")`): SSH key, known_hosts, App private key. Config is host-local by design.
- `src/config.ts:77` — `SWARMFORGE_DB_PATH` default `./data/swarmforge.sqlite` (**relative**).
- `src/main.ts:10-14,61` — `loadConfig()` at import → lock `` `${DB}.lock` `` → `new Store(DB)` → log `` `${DB}.log` ``. Log/lock derive from the DB string, so they inherit its anchoring.
- `src/store.ts:19-21` — `mkdirSync(dirname(path), {recursive:true, mode:0o700})`, `new Database(path)`, `chmodSync(path, 0o600)`.
- `src/runtime.ts:146-171` — lock dir `0o700`, `openSync(O_CREAT|O_NOFOLLOW)` mode `0o600`, inode identity check; `:208` log `appendFileSync(..., {mode:0o600})`, 1 MiB rotate.
- `src/cli.ts:20` — `process.env.SWARMFORGE_URL ?? "http://127.0.0.1:8787/mcp"`, `:53` `process.env.SWARMFORGE_API_TOKEN`; `src/cli/client.ts:52-59` sends `Authorization: Bearer`. **Client does zero validation** and shares the same env namespace as the server.
- `docs/ENVIRONMENT.md:3` "Bun loads `.env`"; `:61` log=`<DB_PATH>.log`, lock=`<DB_PATH>.lock`. `README.md:9` "copy `.env.example` to `.env`". `.env.example:36` cwd-relative DB default; `:58` `SWARMFORGE_RUN_SMOKE` is script-only.
- `src/config.ts:170-183` `workerEnvironment()` is an explicit secret **allowlist** for the guest — preserve this in any new design.

Conclusion: config-file selection, state location and path anchoring are all implicit in the process CWD, and server/client validation is conflated in one schema.

## 2. Decision

**Adopt a layered, XDG-anchored configuration with a TOML primary file, strict provenance, CWD-independent state, and a strict server/client schema split. Keep the flat `SWARMFORGE_*` environment as the highest-precedence override layer, and keep `.env` as a supported (explicit) compatibility input.**

Two loaders, not one:
- **server loader** (`swarmforge start`): defaults → `/etc/swarmforge/config.toml` → user config home → `~/.config/swarmforge/config.toml` → `--env-file` (repeatable) → process env → CLI flags. **CWD `.env` and project-local files are NOT consulted** (except when the launcher is explicitly invoked with `--env-file .env`, and one deprecated legacy fallback).
- **client loader** (`swarmforge status`): the same engine but additionally allows a project-local `swarmforge.toml` / `.env` discovered by walking up from CWD, because the client only selects an endpoint + token and creates no state.

### 2.1 Exact paths

| Purpose | Linux | macOS | Windows |
| --- | --- | --- | --- |
| System config | `/etc/swarmforge/config.toml` (first existing entry of `$XDG_CONFIG_DIRS`, default `/etc/xdg`) | `/etc/swarmforge/config.toml` | `%PROGRAMDATA%\swarmforge\config.toml` *(unverified — conventional, no primary doc fetched)* |
| User config | `${XDG_CONFIG_HOME:-$HOME/.config}/swarmforge/config.toml` | `$HOME/Library/Application Support/swarmforge/config.toml` | `%APPDATA%\swarmforge\config.toml` *(unverified — conventional)* |
| Project config (client only) | `./swarmforge.toml`, walking up to filesystem root, first hit wins | same | same |
| State (SQLite + `.lock` + `.log`) | `${XDG_STATE_HOME:-$HOME/.local/state}/swarmforge/<profile>` | `$HOME/Library/Application Support/swarmforge/<profile>` | `%LOCALAPPDATA%\swarmforge\<profile>` *(unverified)* |
| Secrets (files referenced by config) | `$XDG_CONFIG_HOME/swarmforge/secrets/*` | `…/Application Support/swarmforge/secrets/*` | `%APPDATA%\swarmforge\secrets\*` |

Rationale: XDG separates *config* from *state*, and `XDG_STATE_HOME` is defined as holding "logs, history, current state of the application that can be reused on a restart" — exactly SQLite + lock + log. Modes `0700` dir / `0600` files, matching existing `store.ts:19-21` and `runtime.ts:146,150,208`. XDG requires absolute values in these variables and a visible error if a directory cannot be created.

### 2.2 Precedence (lowest → highest)

1. Built-in defaults (existing zod `.default()`s in `src/config.ts`).
2. System TOML.
3. User TOML (config home).
4. `SWARMFORGE_*` from `--env-file` files, in the order given.
5. Real process environment (`SWARMFORGE_*`) — one-off overrides and systemd `EnvironmentFile=`.
6. CLI flags (`--config`, `--profile`, `--data-dir`, `--host`, `--port`, `--db`).

Rules:
- **Absolute CLI selection wins and short-circuits discovery**: `--config PATH` means *use only this file* plus layers 1,4,5,6.
- Within TOML, unknown keys are a **hard error** (typo safety). Layer merging is per-key; arrays replace, not append.
- Every resolved key records its **provenance**; `swarmforge config show --provenance` prints it, and startup prints a one-line summary (`config=/path profile=default db=/path/... `).
- List-valued keys accept real arrays in TOML; the comma-string form stays accepted in the env layer for compatibility.
- **Secrets are never literals in TOML.** Only indirections: `token = { file = "..." }` or `token = { env = "NAME" }`. `file` must be an absolute-or-`~` path resolved **against the config file's directory**; if `$CREDENTIALS_DIRECTORY` is set (systemd `LoadCredential=`), that directory is searched first by basename. Reject: symlinks, non-regular files, and any file whose mode has group/other bits (`mode & 0o077`).

### 2.3 Relative-path anchoring rule

- Paths inside a TOML file resolve against **that file's directory**, never CWD.
- Paths given on the **command line** resolve against CWD (explicit user action).
- State paths are always derived from an absolute `data_dir`; `--db` may override the file name only, never escape `data_dir` (`..` rejected, same rule already used for `SWARMFORGE_WORKSPACE` at `config.ts:72-76`).
- `SWARMFORGE_DB_PATH` remains honored as a legacy env override; a **relative** legacy value resolves against `data_dir` instead of CWD; `.lock` and `.log` still derive from the resolved DB path exactly as `main.ts:13,61` do.
- The shipped launcher must run the server with Bun's automatic `.env` loading disabled (`bun --no-env-file src/main.ts`, or `bunfig.toml` `env = false`) so a foreign repo's `.env` cannot inject `SWARMFORGE_*` into the control plane.

### 2.4 Schema (TOML v1.0.0, `schema_version = 1`)

```toml
schema_version = 1
profile = "default"          # reserves profiles for later; single "default" today

[instance]
id = "default"               # <=16 [a-z0-9], matches current regex
data_dir = "~/.local/state/swarmforge/default"

[server]
host = "127.0.0.1"
port = 8787
allowed_hosts = []
api_token = { file = "~/.config/swarmforge/secrets/api_token" }
metrics = { enabled = true, port = 9090, teams = ["default"] }

[provider.freestyle]
api_url = "https://api.freestyle.sh"
api_token = { file = "..." }
snapshot_id = "snap-123"
vpc = ""

[model]
base_url = "https://host/v1"
api_key  = { file = "..." }
name     = "model-id"

[git]
tree = "https://github.com/owner/repo.git"
push_mode = "none"          # none | github-app | ssh
push_timeout_ms = 120000
author = { name = "SwarmForge Worker", email = "swarmforge-worker@example.invalid" }
[git.github_app]
app_id = "1"; installation_id = "2"; repository = "owner/repo"
private_key = { file = "/etc/swarmforge/secrets/app.pem" }
[git.ssh]
push_url = "git@host:repo.git"; key = { file = "/etc/swarmforge/secrets/id_ed25519" }
known_hosts = { file = "/etc/swarmforge/secrets/known_hosts" }

[limits]
max_workers = 50; max_provisioning = 4; max_queue = 1000
default_timeout_seconds = 3600; provision_timeout_seconds = 300
token_idle_timeout_seconds = 300; poll_interval_ms = 2000; api_timeout_ms = 30000

[workspace]
guest_dir = "/workspace"
opencode_port = 4096
opencode_start_command = 'opencode serve --hostname 0.0.0.0 --port "$OPENCODE_PORT"'
worker_domain_suffix = ""

[client]
url = "http://127.0.0.1:8787/mcp"
api_token = { file = "..." }
```

Mapping is 1:1 with `.env.example` (58 lines) so docs/migration are mechanical: `FREESTYLE_*` → `[provider.freestyle]`, `OPENCODE_*` → `[workspace]`, etc. `SWARMFORGE_RUN_SMOKE` stays script-only and is rejected by the server schema.

### 2.5 Client vs server validation

- Split `src/config.ts` into a shared `rawSchema` + two entry points: `parseServerConfig()` (current full schema incl. every `superRefine` rule at `:94-151`) and `parseClientConfig()` (accepts only `[client]`, optionally `[server].host/port/api_token`, plus the `SWARMFORGE_URL`/`SWARMFORGE_API_TOKEN` env equivalents). The client never requires or inherits Freestyle/model/Git keys.
- Client-side validation moves into the schema: URL scheme checks (today `cli.ts:37-41` validates after `new URL`), and a missing token for a non-loopback URL warns instead of yielding a confusing 401.
- Secret hygiene: client token comes from a file or dedicated env var and server secrets are never passed to child processes; `workerEnvironment()` stays the single place that copies `SWARMFORGE_MODEL_API_KEY` outward.

### 2.6 Commands

```
swarmforge start   [--config PATH] [--profile NAME] [--env-file PATH]... [--data-dir PATH] [--db NAME] [--print-config]
swarmforge config  show [--json] [--provenance] [--secrets omit|redacted] | path | validate | migrate --from .env [--out PATH]
swarmforge status  [--config PATH] [--profile NAME] [--env-file PATH]... [--url URL] [--json] [--no-interactive]
```

`--print-config` prints the fully resolved, secret-redacted config **with provenance and exit code 0** before any listener, SQLite file or VM action — this is the safe way to test discovery.

### 2.7 Compatibility / migration from the CWD `.env`

1. **Phase 0 (behavior-preserving):** add `--config`, `--env-file`, `--no-env-file`, `--print-config`, absolute `data_dir`. Deprecation warning on stderr when CWD `.env` supplies keys.
2. **Phase 1:** `swarmforge config migrate --from .env --out <path>` writes a TOML file; secrets become `{ file = ... }` pointers to a **new** `secrets/` dir with `0600`, or `{ env = "..." }` when no file is possible. It never deletes or edits `.env`, is idempotent (byte-identical on re-run), and prints the exact `start` command to adopt it.
3. **Phase 2:** default launcher disables Bun auto-`.env`; CWD `.env` fallback becomes opt-in (`--env-file .env` or `SWARMFORGE_LEGACY_ENV=1`) for one minor, then removed.
4. **State migration:** if `./data/swarmforge.sqlite` exists in CWD and `data_dir` is unset, `start` refuses with a one-line `swarmforge config migrate --db <path>` instruction instead of silently creating a second, empty database. The `instance_id` ownership check (`main.ts:15-18`) keeps protecting the moved file.

## 3. Alternatives considered

- **A. Env-only + `--env-file`/`--no-env-file` + absolute state paths.** Cheapest diff, fine compatibility floor; but no provenance/nesting/comments, list values stay comma-strings (`config.ts:21,92`), no `config show`. Keep as layers 4-5, not as the architecture.
- **B. JSON/JSONC instead of TOML.** OpenCode (which this repo drives) uses JSON/JSONC, so ecosystem precedent is real, but JSON needs JSONC for comments and has no secret-scaffolding convention. TOML 1.0.0 is a published standard with native tables/arrays/integers. Rejected on standardization, not capability.
- **C. XDG only, zero project-local discovery.** Safest; adopted for the server. Not adopted for the client, where a per-repo endpoint override is useful and low-risk.
- **D. Full profiles/`extends` + per-project mapping now.** Right shape, wrong time. Reserved now: `profile`, `data_dir/<profile>`, `schema_version`; later `[profiles.x] extends = "default"`.
- **E. Keyring / systemd `LoadCredential` only.** Deferred; half-step adopted — honor `$CREDENTIALS_DIRECTORY` for `{ file = }`.
- **F. Per-repo self-contained state (`.swarmforge/`).** Rejected: secrets-adjacent SQLite in a Git working tree that may be cloned/committed.

## 4. Failure & security scenarios this design must satisfy

1. **Foreign-CWD hijack (demonstrated, Exp. 5):** running the server from an unrelated repo today creates `./data/swarmforge.sqlite` in that repo and locks it there; two "servers" with the same `SWARMFORGE_INSTANCE_ID` then hold *different* databases, defeating the ownership check at `main.ts:15-18`. Fixed by CWD-independent `data_dir`.
2. **Foreign `.env` injection (demonstrated, Exp. 1-3):** CWD `.env` values win over nothing and can set `SWARMFORGE_HOST=0.0.0.0`, `SWARMFORGE_ALLOWED_HOSTS=<attacker host>`, `SWARMFORGE_MODEL_BASE_URL`, or `SWARMFORGE_GIT_PUSH_MODE` → unauthenticated exposure or credential/branch exfiltration. Fixed by server-layer exclusion of CWD `.env` + `--no-env-file` launcher.
3. **Loopback-behind-proxy misconfiguration:** `config.ts:135-141` already fails closed when a non-loopback host is accepted without a token; keep that rule in the server schema and add a client-side warning.
4. **Group-readable secret file:** `{ file = }` must be rejected when `mode & 0o077`, and the config file itself must not be group/other-writable.
5. **Precedence surprise:** a stale exported shell variable silently shadows TOML. Mitigated by provenance output on every startup line and `config show --provenance`.
6. **Unknown-key typo:** today silently ignored (`config.ts:156-157`); must become a hard error with the offending key name (and line/column if the parser exposes spans — see residual uncertainty).
7. **Split-brain secrets:** a token present in both `.env` and `secrets/` with different values — resolution order plus `config show --secrets redacted` (hash suffix only) makes it visible.

## 5. Acceptance tests (meaningful, executable)

- **AT1 anchor:** `cd /tmp/other && swarmforge start --print-config` → `data_dir` under XDG state; `/tmp/other/data` is **not** created.
- **AT2 CWD `.env` ignored (server):** `/tmp/x/.env` with `SWARMFORGE_HOST=0.0.0.0` → `--print-config` shows `127.0.0.1`; with `--env-file .env` it shows `0.0.0.0` **and fails closed** without `SWARMFORGE_API_TOKEN` (existing `config.ts:135-141`).
- **AT3 precedence:** set a key in all six layers → assert the winning value and that `--provenance` names the layer, for one list key and one bool key.
- **AT4 relative anchoring:** config at `/tmp/cfg/a.toml` with `data_dir = "rel/state"` → creates `/tmp/cfg/rel/state`, never `$CWD/rel/state`.
- **AT5 secret hygiene:** 0644 secret file → refuse with actionable error; 0600 → OK; symlink → refuse; `$CREDENTIALS_DIRECTORY` file → preferred over the on-disk path.
- **AT6 locking:** two `start` on one `data_dir` → second fails with the existing `Another SwarmForge process owns this database` (`runtime.ts:153`); two profiles → both start with distinct `instance_id`/`.lock`.
- **AT7 split validation:** a config with only `[client]` makes `status` work and `start` fail listing missing server keys **without any network call**.
- **AT8 migration idempotence:** `config migrate --from .env` twice → identical TOML; `.env` mtime/content unchanged.
- **AT9 unknown key:** `limts.max_workers = 10` → non-zero exit naming `limts`.
- **AT10 back-compat:** an existing `.env` deployment starts unchanged via the deprecated fallback and prints the deprecation warning; `bun run check` and existing `tests/core.test.ts` cases pass (extend, don't replace).
- **AT11 backward-compat state:** with `./data/swarmforge.sqlite` present and no `data_dir`, `start` refuses and prints the `config migrate --db` instruction.

## 6. Experiments actually run (all in `/tmp`, repo untouched)

```
$ bun --version
1.3.14
```

```
E1  cd /tmp/sfcfg && bun /tmp/sfcfg/probe.ts                 -> {"cwd":"/tmp/sfcfg"}
    (cwd has no .env; Bun does not walk up for .env)
E2  cd /tmp/sfcfg && PROBE_B=from_shell bun /tmp/sfcfg/probe.ts -> {"cwd":"/tmp/sfcfg","B":"from_shell"}
    (real env overrides the .env value)
E3  cd /tmp/sfcfg/inner && bun --env-file=/tmp/sfcfg/explicit.env /tmp/sfcfg/probe.ts
    -> {"cwd":"/tmp/sfcfg/inner","D":"from_explicit"}        (--env-file REPLACES the CWD .env set)
E4  cd / && bun /tmp/sfcfg/probe.ts                          -> {"cwd":"/"}
```

```
E5  mkdir -p /tmp/sfcfg/run3 && cd /tmp/sfcfg/run3 && bun -e '<loadConfig + acquireProcessLock + Store>'
    cwd=/tmp/sfcfg/run3
    resolved db/lock/log = ./data/swarmforge.sqlite | ./data/swarmforge.sqlite.lock | ./data/swarmforge.sqlite.log
    files created under the FOREIGN cwd:
      /tmp/sfcfg/run3/data/swarmforge.sqlite
    cd /workspace/repo && git status --porcelain | wc -l  →  0
```
Also: `curl` extracts of systemd.exec(5), git-config(1), opencode config docs (see sources); `bun -e` run in `/tmp/sfcfg/{inner,run2,run3}` auto-installed `zod@4.6.5` into `/tmp/sfcfg/*/node_modules` — **outside the repo**, which stayed clean.

## 7. Sources (all fetched 2026-09-30)

- XDG Base Directory Spec, **Version 0.81, published 08 May 2021** — https://specifications.freedesktop.org/basedir-spec/latest/ (fetched): defaults `$HOME/.config` / `$HOME/.local/state` / `/etc/xdg`, "all paths … must be absolute", preference-ordered dirs, create missing dir with 0700, state home holds logs/history/current state.
- Bun "Environment Variables" — https://bun.sh/docs/runtime/environment-variables (fetched; banner showed v1.4.2, local runtime 1.3.14): auto `.env`, `.env.local`, `$VAR` expansion, `--env-file` "overrides which `.env` files Bun loads", `--no-env-file`, `bunfig.toml` `env = false`.
- TOML v1.0.0, published 2021-01-11 — https://toml.io/en/v1.0.0 (fetched); site lists **v1.1.0** as current, so pin to 1.0.0 semantics. Ext `.toml`, MIME `application/toml`.
- systemd.exec(5) — https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html (curl): `EnvironmentFile=` (newline assignments, `#`/`;` comments), `LoadCredential=`, `$CREDENTIALS_DIRECTORY` basename lookup.
- git-config(1) — https://git-scm.com/docs/git-config (curl): "files are read in the order given above, with last value found taking precedence"; `XDG_CONFIG_HOME` global; `--file`/`--system`.
- OpenCode config — https://opencode.ai/docs/config/ (curl): merged layers ("later sources override earlier ones only for conflicting keys"); Remote → Global `~/.config/opencode/opencode.json` → `OPENCODE_CONFIG` → Project → `.opencode/` → `OPENCODE_CONFIG_CONTENT`; macOS managed dir `/Library/Application Support/opencode/`. Ecosystem precedent for layered merge + macOS path.

## 8. Residual uncertainty / unverified

- macOS (`~/Library/Application Support`) and Windows (`%APPDATA%`, `%LOCALAPPDATA%`) paths are **not** from a fetched primary standard: macOS rests on OpenCode's documented managed dir (a project convention), Windows on common practice. Verify against Apple's *File System Programming Guide* and Microsoft's *Known folders* docs before shipping.
- Line/column reporting for unknown TOML keys needs parser spans; Bun's `TOML` import error positions are undocumented (unverified). Otherwise report the key path only.
- Whether the eventual deployment unit uses `LoadCredential=` is unverified; `$CREDENTIALS_DIRECTORY` support is defensive.
- Repeated `--env-file` ordering is specified here as "last wins" (Bun's behavior was verified only for a single `--env-file` replacing the CWD `.env` set).
- No SwarmForge source changed; all runs were read-only probes. `bun test` / `bun run check` were **not** executed, so no claim is made about suite health at this commit.
