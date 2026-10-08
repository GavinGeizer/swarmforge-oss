# Review 36 — Config precedence, empty values, path anchoring, legacy DB

- **Target SHA:** `d428e0f730ed5649485732e95d39c32f5d6a8895`
- **Branch:** `feature/binary-config-serve-20260930`
- **Scope:** TOML / env-file / process-env / flag precedence; empty-value handling;
  path anchoring; legacy database compatibility.
- **Verdict:** FINDINGS (2 MEDIUM, 3 LOW). No CRITICAL/HIGH.
- **Reviewer checkout (disposable, outside source):** `/tmp/opencode/rev36/repo`
  (detached at target, `git rev-parse HEAD` = d428e0f7…, verified).
  `/workspace/repo` left untouched at assigned baseline `5672ead`, working tree clean.
- **Toolchain:** Bun 1.4.2 unpacked to `/tmp/opencode/bun142/` (snapshot Bun is 1.3.14 and
  cannot read `bun.lock` lockfileVersion 2). `bun install --frozen-lockfile` in the /tmp
  clone; `bun.lock` byte-identical before/after (verified with `diff -q`).

## Files in scope

`src/settings/load.ts` (897), `src/settings/paths.ts` (73), `src/settings/inspect.ts` (147),
`src/cli/arguments.ts` (152), `src/cli.ts` (323, config/serve wiring), `src/config.ts` (183,
legacy loader), `docs/CONFIGURATION.md` (266).

## What is correct (verified)

The documented precedence ladder and the path-anchoring matrix both reproduce exactly.

- Ladder `config < config.env_file < --env-file < process env < overrides`
  (probe 5, `src/settings/load.ts:785-822`): with a config setting `port=1111`,
  `env_file` `2222`, `--env-file` `3333`, process env `4444`, override `5555`, each layer
  won in order and `provenance` named the winning layer exactly.
- Empty value in an environment/override layer leaves the lower layer intact and the
  provenance label stays on the lower layer (probe 5 "empty in later layer"; matches
  `tests/settings.test.ts:623`).
- Comma-separated lists replace, never merge (`merged()` assigns whole values).
- Anchoring matrix (probe 6, `docs/CONFIGURATION.md:135-143`): config-file paths anchor at
  the config dir (`cfg/cfg-relative.sqlite`), the config's own `env_file`, an explicit
  `--env-file` and process-env paths all anchor at `cwd`; `:memory:` passes through verbatim
  (`paths.ts:41`); `~` expands with no shell.
- Legacy relative DB paths are *not* relocated when set (config-dir for config, cwd for
  env/env-file) — `docs/CONFIGURATION.md:131-133` holds.
- `SWARMFORGE_CONFIG` is read only from overrides/process env, never from an env file
  (`selector()`, `load.ts:776-783`) — matches docs.
- Non-loopback `allowed_hosts` without `api_token` is still refused by the unchanged
  `loadConfig` superRefine (observed in a probe that failed with `invalid_config`).

## Findings

### F1 — MEDIUM — An empty string in a TOML `int`/`bool` field is a hard error, not "unset"

- **File/line:** `src/settings/load.ts:370-376` (`kinds.int` / `kinds.bool`); the
  empty-means-unset rule lives only in `setValue` (`load.ts:656-667`) and is reached via
  `applyDocument` (`load.ts:679-680`).
- **Trigger:** a templated config such as `port = "${PORT}"`, `metrics_port = "${MPORT}"`
  or `max_workers = ""` with the shell variable unset.
- **Consequence:** `resolveServerSettings` throws `SettingsError(config_invalid)` and
  `swarmforge serve` refuses to start. An operator cannot express "unset" for a numeric or
  boolean key at all, and the diagnostic is a schema error rather than a missing value.
- **Reproduction (probe 1, reproduced):** `[server] port = ""` →
  `code=config_invalid … server.port: Invalid string: must match pattern /^-?\d+$/`.
  `[server] metrics_enabled = ""` → `config_invalid … Invalid input`.
  `[server] allowed_hosts = ""` (`kind: "text"`) resolves fine to the default.
  So the "empty means unset" rule holds for `text`/`host_path` and silently does not for
  `int`/`bool`.
- **Why guards/tests do not prevent it:** `tests/settings.test.ts:623` exercises the empty
  value only through an `env_file` and `overrides`; there is no test with an empty TOML
  scalar. The `int`/`bool` unions reject `""` during `documentSchema.safeParse`
  (`load.ts:513`) before `setValue` can drop it, so the schema and the documented rule
  disagree.
- **Doc conflict:** `docs/CONFIGURATION.md:51-52` states "An empty string means 'unset',
  exactly as an empty environment variable does."
- **Recommendation:** accept `""` for `int`/`bool` (e.g. add `z.literal("")` to the unions
  and skip it in `applyDocument`), or narrow the doc sentence to text settings. Prefer
  making the code match the documented rule.

### F2 — MEDIUM — Legacy database default is relocated silently, with no runtime signal

- **File/line:** legacy default `src/config.ts:77` (`"./data/swarmforge.sqlite"`) versus
  `src/settings/load.ts:835-841` + `src/settings/paths.ts:67-73`
  (`$XDG_DATA_HOME/…` else `~/.local/share/swarmforge/swarmforge.sqlite`).
- **Trigger:** an existing deployment that never set `SWARMFORGE_DB_PATH` and relies on the
  relative default, upgrading to this binary. `.gitignore:6` ignores `data/`, confirming
  `./data` was the working convention in this repository.
- **Consequence:** the control plane opens a brand-new empty SQLite file at a different
  path; all prior teams, workers and event history appear to vanish and the old database is
  orphaned. `provenance` is only `"default"`, the startup banner from `renderStartup`
  (`src/serve-command.ts:151-160`) prints host/port/metrics but **not** the database path,
  so nothing at runtime tells the operator the path moved.
- **Reproduction (probe 2, reproduced):** legacy `loadConfig(...)` →
  `SWARMFORGE_DB_PATH = ./data/swarmforge.sqlite`; new `resolveServerSettings({env, cwd})`
  → `/tmp/…/.local/share/swarmforge/swarmforge.sqlite`, `provenance = default`.
- **Why guards/tests do not prevent it:** the change is documented
  (`docs/CONFIGURATION.md:129-133` and migration step 4 at :264) but only in prose;
  `tests/settings.test.ts:407` asserts an *explicitly set* path is not relocated and no test
  covers the unset default. Nothing at `serve` startup detects the pre-existing legacy file.
- **Recommendation:** in `serveCommand`/`resolveServerSettings`, if the DB path resolved to
  the default and `./data/swarmforge.sqlite` exists relative to `cwd`, refuse startup (or log
  a prominent warning) naming both paths; at minimum include the resolved database path in
  the startup banner.

### F3 — LOW — `--url ""` is accepted and then silently ignored, so `status` targets a different endpoint

- **File/line:** `src/cli/arguments.ts:66` and `:77` (value stored verbatim as an
  override); ignored at `src/settings/load.ts:701` (`if (!value) continue`).
- **Trigger:** `swarmforge status --url ""`.
- **Consequence:** the flag is neither honoured nor refused. The empty override is treated
  as unset, so the resolver falls back to `client.url`/env/default and `status` connects to
  an endpoint the operator did not name. Inconsistent with the sibling flags: `--config ""`
  and `--env-file ""` both fail loudly (`--config ""` → `config_invalid … EISDIR`).
- **Reproduction (probe 3, reproduced):**
  `parseArguments(["status","--url",""])` → `{"overrides":{"SWARMFORGE_URL":""}}`;
  with a config declaring `client.url = "http://config.example/mcp"` the resolved url is
  `http://config.example/mcp`, `provenance = config:…`, no error.
- **Why guards/tests do not prevent it:** `value()` in `arguments.ts:48-53` only rejects a
  *missing* value, and the "empty means unset" rule in the loader is correct for environment
  layers but wrong for an explicit flag.
- **Recommendation:** reject an empty `--url` in the parser with `UsageError` (the parser is
  documented as total and pure), or normalise empty flag values consistently across all
  flags.

### F4 — LOW — `server.api_token` in a config file never reaches the client surface

- **File/line:** `src/settings/load.ts:869` (`merged(prepared, clientFields, options)`)
  vs `:278-283` (`server.api_token` → key `SWARMFORGE_API_TOKEN`).
- **Trigger:** a deployment that sets `server.api_token` in `config.toml` (required by
  `loadConfig` for any non-loopback accepted host) and then runs `swarmforge status`.
- **Consequence:** `resolveClientSettings` reads only `client.*`, so no bearer token is sent
  to the operator's own server and `status` fails with an opaque 401. There is no
  config-side hint that `client.token` must be duplicated.
- **Reproduction (probe 4, reproduced):** config with `server.api_token` →
  `client.value = {"url":"http://127.0.0.1:8787/mcp"}` (no `token`),
  `client.provenance = {"url":"default","token":"default"}`, `secrets: []`; the same file
  yields `server SWARMFORGE_API_TOKEN present = true`.
- **Why guards/tests do not prevent it:** the prose at `docs/CONFIGURATION.md:109-111` does
  say the client surface reads only `client.*`, but the schema table maps **both**
  `client.token` (:63) and `server.api_token` (:68) to the same setting
  `SWARMFORGE_API_TOKEN`, implying one shared value. No test asserts the split.
- **Recommendation:** disambiguate the "Setting" column for the two rows, and/or have
  `redactedSettings`/`config show` report a hint when the server token is set but the client
  token is not.

### F5 — LOW — `config path` omits the config file's own `env_file` from `env_files`

- **File/line:** `src/cli.ts:235-237` (maps only `command.envFiles`), against the function's
  own comment at `src/cli.ts:209-210` ("the environment files layered on it") and
  `docs/CONFIGURATION.md:61`.
- **Trigger:** `swarmforge config path --config cfg/config.toml --env-file extra.env` where
  `cfg/config.toml` declares `env_file = "secrets.env"`.
- **Consequence:** the layering report lists only the flag env files and hides the config's
  declared environment file — the one that normally holds credentials. An operator auditing
  which files feed the configuration gets an incomplete answer.
- **Reproduction (reproduced, local CLI, exit 0):** input produced
  `{"config_path":"…/cfg/config.toml","exists":true,"env_files":["…/extra.env"]}` with
  `cfg/secrets.env` absent.
- **Why guards/tests do not prevent it:** `reportConfigPath` never reads the document; it
  only formats the parsed flags, so the omission cannot be caught by the resolver tests.
- **Recommendation:** parse the selected config and prepend its anchored `env_file` to the
  reported `env_files` (keeping it redacted).

## Tests / probes run

| Command | Exit | Result |
| --- | --- | --- |
| `bun test tests/settings.test.ts` (Bun 1.4.2, /tmp clone) | 0 | 56 pass, 0 fail, 404 assertions |
| `bun run /tmp/opencode/rev36/probes/probe.ts` (probes 1-6) | 0 | 6/6 probes ran; F1, F2, F3, F4 reproduced |
| `bun repo/src/cli.ts config path …` (local, exit 0) | 0 | F5 reproduced |

Probe log: `/workspace/.swarmforge/logs/rev36-probe.log`.

## Limitations

- Read-only scope review of the target's config subsystem. No whole-suite run (not this
  reviewer's role), no packaging/build, no provider or infrastructure smoke. No real cloud
  or model provider was contacted.
- `bun install --frozen-lockfile` in the /tmp clone installed 125 packages from the network;
  `bun.lock` unchanged.
- F1/F3/F4 are reachable through the CLI as described; only F5 was exercised end-to-end via
  the CLI. F2's *consequence* (an empty control plane after upgrade) is code-evidenced and
  probe-confirmed for the path, not reproduced against a populated legacy database.
- Over-redaction of short credentials in probe output (e.g. `h[REDACTED][REDACTED]p://…`)
  is documented, intended behaviour (`docs/CONFIGURATION.md:184-188`) and is **not** counted
  as a finding.
- Paths/line numbers are from the detached checkout at the exact target.