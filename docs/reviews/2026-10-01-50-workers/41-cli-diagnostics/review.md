# Review 41 — `config path|show|validate` and `serve --check-config`

- **Exact target reviewed:** `d428e0f730ed5649485732e95d39c32f5d6a8895`
  (`origin/feature/binary-config-serve-20260930`), verified with `git rev-parse HEAD`
  in a disposable detached clone at `/tmp/rev41`.
- **Assigned workspace:** `/workspace/repo` at `5672ead2a526e07fea9ed11e58b3725e42013527`,
  left unmodified and clean (this reviewer makes no source changes).
- **Scope:** `src/cli.ts` (config/serve command branches), `src/cli/arguments.ts`,
  `src/settings/load.ts`, `src/settings/paths.ts`, `src/settings/inspect.ts`,
  `src/serve-command.ts`, and the pre-flight refusals in `src/serve.ts` / `src/config.ts`
  that those commands are supposed to predict. Focus: partial-invalid settings handling
  and filesystem side effects.
- **Verdict: FINDINGS** (4 MEDIUM, 1 LOW). No CRITICAL/HIGH.
- **No filesystem side effects were found.** Verified by snapshotting the working
  directory, `HOME`, `$XDG_CONFIG_HOME` and `$XDG_DATA_HOME` before and after running
  `config path`, `config show`, `config validate` and `serve --check-config` in both the
  explicit-`--config` and default-discovery forms: the only difference was this reviewer's
  own snapshot file. No directory, database, lock file or log is created and no existing
  file is chmodded, as `docs/CONFIGURATION.md` promises. `:memory:` is refused for `serve`
  and accepted for `config validate`, both trimmed forms included.

## Findings

### 1. MEDIUM — `config show` produces no structured report for any failure except server value validation

- **File / line:** `src/cli.ts:247` (unguarded `resolveClientSettings`) and
  `src/cli.ts:249-264` (the `try` wraps only the *server* resolution).
- **Trigger:** any of — a config file with an unknown key (`server.prot = 8787`),
  malformed TOML, a selected config file that does not exist, a declared `env_file` that
  is missing or has a malformed line, or an invalid `client.url`.
- **Consequence:** exit `1` with a bare `SwarmForge: …` line on stderr and **nothing on
  stdout**. The `server: {ok:false, code, message, hint}` inspection report the command
  exists to produce is unavailable for the most common configuration-*file* mistakes.
  README:78 tells operators the output is safe to paste into a ticket; here there is no
  output, and any automation that parses `config show` JSON silently gets `null`.
- **Code trace:** `prepare()` (`src/settings/load.ts:725-774`) raises `config_not_found`
  / `config_invalid` / `env_file_not_found` / `env_file_invalid`, and
  `resolveClientSettings` (`src/settings/load.ts:866-897`) raises `invalid_client`. All
  five are `SettingsError`s, but line 247 runs before the guarded block, so only
  `invalid_config` (raised by the server resolver) is caught and reported.
- **Reproduction (reproduced, exit codes captured):**
  ```
  # [server] with a typo'd key
  swarmforge config show --config typo.toml
    exit=1  stdout=(empty)  stderr=SwarmForge: Invalid configuration file …/typo.toml: server: Unrecognized key: "prot"
  # [client] with malformed TOML   -> exit=1, stdout empty, "Invalid TOML in …/bad.toml: …"
  # env_file = "missing.env"      -> exit=1, stdout empty, "Environment file not found: …/missing.env"
  # env_file with a non-assignment-> exit=1, stdout empty, "Invalid environment file …/s.env at line 2"
  # client.url = "ftp://host/mcp" -> exit=1, stdout empty, "Client endpoint must use http or https: …"
  # SWARMFORGE_CONFIG=<absent>    -> exit=1, stdout empty, "Config file not found: …/absent.toml"
  ```
- **Recommended correction:** resolve both surfaces inside one guarded block. Catch
  `SettingsError` from the client resolution too and emit
  `{client:{ok:false,code,message,hint}, server:{…}}` (or a top-level `errors` array),
  keeping the `if (!(error instanceof SettingsError)) throw error;` rethrow for genuine
  bugs. `reportConfigShow` already renders `error.message` safely, and
  `src/settings/load.ts` guarantees it is credential- and control-character-free.
- **Why existing guards/tests do not prevent it:** the only covering test,
  `tests/commands.test.ts` "config show explains an incomplete server configuration
  safely", uses a *valid* document whose server values are incomplete — precisely the one
  code (`invalid_config`) that is inside the `try`. No test drives a `config_invalid`,
  `config_not_found`, `env_file_*` or `invalid_client` error through `config show`.

### 2. MEDIUM — `config path` omits the config file's own `env_file` and never reports env-file existence

- **File / line:** `src/cli.ts:235-237` inside `reportConfigPath`; the contradiction is
  documented at `src/cli.ts:209-210`.
- **Trigger:** a config file declaring `env_file = "secrets.env"` — the exact layout
  README:87 recommends for production.
- **Consequence:** `config path` prints
  `{"config_path":"…/config.toml","exists":true,"env_files":[]}` — the credentials file
  that will actually be layered on is neither listed nor checked, and no existence flag is
  reported for the explicit `--env-file` entries that *are* listed. This directly
  contradicts the command's own doc comment ("Reports the config file in effect, **and
  the environment files layered on it**") and README:77 ("the config file in effect, and
  whether it exists"). An operator uses it as the pre-deploy file-layout check, sees
  `exists: true`, and only discovers the missing `secrets.env` when `config show`,
  `config validate` and `serve --check-config` all exit 1 with no JSON (see finding 1).
- **Code trace:** `reportConfigPath` derives `env_files` purely from
  `command.envFiles` (the `--env-file` flags captured by `src/cli/arguments.ts:118-121`).
  The `env_file` declared by the document is only read later, inside `prepare()`
  (`src/settings/load.ts:751-758`), which `config path` never calls.
- **Reproduction (reproduced):**
  ```
  # withenvfile.toml:  schema_version = 1 \n env_file = "secrets.env"
  swarmforge config path --config withenvfile.toml
    exit=0  {"config_path":"/tmp/…/withenvfile.toml","exists":true,"env_files":[]}
  # secrets.env is absent; `config validate --config withenvfile.toml` then exits 1
  ```
- **Recommended correction:** in the `--check-config`-free path branch, parse the selected
  document (reusing the loader's read-only parse, or at minimum
  `Bun.TOML.parse`) and prepend its `env_file`, resolved with
  `anchorPath(value, dirname(configPath), homeDirectory(process.env))`, to `env_files`;
  emit a per-entry existence flag. If a parse failure must not be fatal for `config path`,
  fall back to today's output plus a `notes` field. Cheapest acceptable alternative: amend
  the doc comment, the `--help` text and README:77 to say `env_files` lists only
  `--env-file` flags, so the field is not read as a completeness check.
- **Why existing guards/tests do not prevent it:** `tests/commands.test.ts` "config path
  reports the selected file without creating it" asserts exact `env_files: []` output for
  every case it covers, and none of its fixtures declares `env_file`, so the omission is
  invisible to the suite.

### 3. MEDIUM — `serve --check-config` reports `ok: true` for deployments `startServer` refuses at startup steps 2 and 3

- **File / line:** `src/cli.ts:195-200` (only the `:memory:` refusal is reproduced);
  the unreproduced refusals are `src/serve.ts:161` and `src/serve.ts:163-166`.
- **Trigger:** either (a) another SwarmForge process holds the `flock` on
  `<SWARMFORGE_DB_PATH>.lock`, or (b) the existing database's persisted
  `settings.instance_id` differs from the configured `SWARMFORGE_INSTANCE_ID`.
- **Consequence:** `--check-config` exits 0 with `ok: true` for a deployment that will not
  start. The refusal appears only later, in the service log, after systemd `Type=exec`
  has already reported success (README:96-100) — precisely the failure mode the check is
  advertised to catch (README:80, `src/cli.ts:52-53`). `docs/SERVE.md:33-34` lists both as
  startup *validation* steps 2 and 3, and `docs/CONFIGURATION.md:225-226` explicitly
  requires a serve command to "keep the single-database and instance-ID rules".
- **Code trace:** `startServer` refuses in this order — `acquireProcessLock(lockPath)`
  throws `"Another SwarmForge process owns this database"` (`src/runtime.ts:147-152`),
  then `store.setting("instance_id") !== config.SWARMFORGE_INSTANCE_ID` throws
  `"Instance ID differs from persisted database owner"`. The `--check-config` branch
  (`src/cli.ts:195-200`) reads only the resolved settings, and the `import("./serve-command")`
  that would reach those checks is deliberately placed after the early return
  (`src/cli.ts:204`), so the checks are never executed.
- **Reproduction (reproduced):** built a durable `data/swarmforge.sqlite` whose
  `settings.instance_id` was `blue` against a config declaring `instance_id = "green"`, and
  separately held the `flock` on `data/swarmforge.sqlite.lock` from a live Bun process.
  In both states `swarmforge serve --check-config --config c.toml` returned exit `0` with
  `{"ok":true,"config_path":"…/c.toml",…}`.
- **Recommended correction:** inside the `--check-config` branch, when the database file
  already exists, open it read-only (`new Database(path, { readonly: true })` behind an
  `existsSync` guard) and compare `settings.instance_id` with the resolved value, failing
  with the same message `startServer` uses; then attempt a non-blocking `flock(LOCK_EX|LOCK_NB)`
  on `<DB_PATH>.lock` and refuse when it is already held. Both are read-only, so the
  "without creating a database, lock file or listener" promise is preserved. Also state in
  the `--help` text which steps remain unverified (port availability, recovery).
- **Why existing guards/tests do not prevent it:** the comment at `src/cli.ts:64-67`
  deliberately scopes the reproduction to the in-memory database only, and
  `tests/commands.test.ts` "serve --check-config validates the server intent and starts
  nothing" asserts only that refusal plus the absence of created files. There is no test
  in which a pre-existing database or a held lock is present during `--check-config`.

### 4. MEDIUM — `config validate` (and `serve --check-config`) report `ok: true` for an invalid client endpoint

- **File / line:** `src/cli.ts:273` — `reportValidation` calls only
  `resolveServerSettings`; client validation is a separate surface
  (`src/settings/load.ts:866-897`, field list `src/settings/load.ts:76-89`).
- **Trigger:** `client.url = "ftp://host/mcp"` in an otherwise complete server config.
- **Consequence:** `config validate` exits `0` with `ok: true`, so a deployment gate
  built on it passes, while `swarmforge status` fails hard with
  `Client endpoint must use http or https`. `config show` *does* detect it, but only by
  aborting with no JSON (finding 1) — so no command reports an invalid client endpoint in
  the structured, redacted form the project documents. Note the related split: a bearer
  token set only as `server.api_token` is never surfaced as `client.values.token`, because
  `client.token` is a distinct config key.
- **Reproduction (reproduced):**
  ```
  swarmforge config validate --config serverok.toml
    exit=0  {"ok":true,"config_path":"/tmp/…/serverok.toml",…}
  swarmforge config show --config serverok.toml
    exit=1  stdout=(empty)  stderr=SwarmForge: Client endpoint must use http or https: …
  ```
- **Recommended correction:** have `reportValidation` also resolve client settings and
  include the redacted result under a `client` key, or add a boolean such as
  `client_ok: false` alongside a `client_error.code`; reuse the same graceful
  `SettingsError` branch proposed in finding 1. Keep the server values as the primary
  payload so existing consumers of `values`/`sources` do not change.
- **Why existing guards/tests do not prevent it:** the test is named "config validate
  checks every **server** setting without touching the system"
  (`tests/commands.test.ts`), and no test declares a `[client]` table for `config validate`
  or `serve --check-config`. Server-only validation is deliberate in the code, but it is
  undocumented in `docs/CONFIGURATION.md` and in `--help`.

### 5. LOW — `config path` reports `exists: true` when the selected config path is a directory

- **File / line:** `src/cli.ts:234` — `existsSync(path)`.
- **Trigger:** `swarmforge config path --config somedir`.
- **Consequence:** the inspection command asserts a usable config file is present; the
  same path then fails in every other command with
  `Invalid configuration file …: Cannot read …: EISDIR`. `existsSync` performs no
  regular-file test.
- **Reproduction (reproduced):**
  ```
  swarmforge config path --config adir
    exit=0  {"config_path":"/tmp/…/adir","exists":true,"env_files":[]}
  ```
- **Recommended correction:** use `statSync(path, { throwIfNoEntry: false })?.isFile() ?? false`
  for the `exists` field (or rename it to `present` and add `is_file`).
- **Why existing guards/tests do not prevent it:** no test passes a directory to
  `config path`.

## Checked and cleared (no defect)

- **In-memory SQLite bypass.** `file::memory:`, `:MEMORY:` and
  `file::memory:?cache=shared` are all accepted by `serve --check-config`. Probed with
  `bun:sqlite` directly: each creates a real on-disk file, so the `:memory:` refusal
  cannot be side-stepped while keeping non-durable state. `" :memory: "` is trimmed and
  correctly refused. `src/store.ts:18-20` also guards the same literal before `mkdirSync`
  / `chmodSync`, so a name such as `file::memory:` gets a normal 0700 directory and a
  0600 database.
- **Read-only guarantee.** No directory, database, lock file or log is created by
  `config path|show|validate` or `serve --check-config` (see header).
- **Redaction on these paths.** Credential values, values, sources and paths are rendered
  through `redactedSettings`, and `SettingsError` applies `plain()`; a credential copied
  into `server.db_path` is replaced with `[REDACTED]` in the reported value, and
  `config show` never printed any of the canaries used in these probes.
- **`:memory:` intent split.** `config validate` accepts it (client/test use), `serve
  --check-config` and `serve` refuse it, and the wording matches `startServer`.

## Tests and limitations

- **Ran (targeted, in scope only):**
  `bun test tests/commands.test.ts tests/settings.test.ts tests/inspect.test.ts`
  → **76 pass, 0 fail, 646 expect() calls, exit 0** (6.18 s), using official Bun 1.4.2
  unpacked at `/tmp/bun142` (the sandbox's 1.3.14 cannot read this `lockfileVersion: 2`
  snapshot; the lockfile was not modified).
- **Probes:** 6 disposable shell probes under `/tmp/probe1`…`/tmp/probe6`, all outside
  the source checkout, each running the real `src/cli.ts` with `--no-env-file
  --config=/dev/null`, an isolated `HOME`/`XDG_*` and a scratch working directory. Exit
  codes and stdout/stderr are quoted verbatim above. No cloud, model or infrastructure
  provider was contacted; no `serve` process was started and no real database, lock or
  listener was produced. The only database and lock fixtures were created by hand under
  `/tmp` to demonstrate finding 3.
- **Limitations:** `serve` itself was not executed (out of scope for this reviewer and it
  would need provider doubles), so findings 1-4 rest on the CLI runs plus a code trace to
  `src/serve.ts` / `src/runtime.ts`; finding 3 is reproduced as "`--check-config` returned
  ok:true" plus a source-level trace of the refusal it fails to predict. The full test
  suite was not run (that is the whole-suite reviewer's job) and no packaging/build scope
  was compiled. Findings 2, 4 and 5 are behavioural-contract findings: they rest on
  `src/cli.ts` versus the project's own documentation (`src/cli.ts:52-53,209-210`,
  `README.md:77-80,87`, `docs/CONFIGURATION.md:225-226`, `docs/SERVE.md:33-34`) and are
  rated MEDIUM/LOW because the impact is operator confusion and a false-green deploy
  gate, not data loss or a credential leak.
- **Reviewer experiments are disclosed:** `/tmp/rev41` (detached clone at the target),
  `/tmp/bun142` (Bun 1.4.2), `/tmp/probe1`-`/tmp/probe6`, `/tmp/memprobe*.ts`,
  `/tmp/probe*.sh`, `/tmp/sfraw`. No secret file was inspected; all credentials in the
  probes were synthetic per-command canaries, and the exported artifacts were passed
  through `Redactor` from `src/security.ts` at the target.
