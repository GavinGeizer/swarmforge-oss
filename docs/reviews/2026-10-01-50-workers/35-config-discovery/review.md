# SwarmForge reviewer report - scope 35: config discovery

- Exact target: `d428e0f730ed5649485732e95d39c32f5d6a8895` (branch `feature/binary-config-serve-20260930`). Verified with a detached worktree at `/tmp/rev35/target` (`git rev-parse HEAD` equals target). Assigned `/workspace/repo` left at baseline `5672ead`, clean.
- Scope: XDG base resolution, `HOME`/`USERPROFILE` fallback, relative overrides, foreign-CWD independence, config-file selection and provenance.
- Files: `src/settings/paths.ts`, `src/settings/load.ts`, `src/cli.ts` (config selection/reporting), `src/config.ts` db default, `scripts/smoke.ts` config entry, `docs/CONFIGURATION.md`, `docs/ENVIRONMENT.md`, `tests/settings.test.ts`, `tests/commands.test.ts`, `tests/cli.test.ts`, `tests/inspect.test.ts`.
- Verdict: FINDINGS (2 reproduced, 1 code-evidenced). Evidence was complete for all three; no unfinished item required INCOMPLETE.

## Findings

### F1 - MEDIUM - Relative `HOME` bypasses the absolute-path guard; default config and database paths become working-directory relative

- File/line: `src/settings/paths.ts:19` (`homeDirectory`), consumed by `src/settings/paths.ts:57-73` and `src/settings/load.ts:739-741`, `src/settings/load.ts:835-841`.
- Trigger: environment where `HOME` (or `USERPROFILE`) is non-absolute, for example a relative home value exported by `HOME=.`-style shells, some container/systemd units and CI images.
- Mechanism: `paths.ts:15-18` rejects the relative value, then `return normalize(homedir())` at `paths.ts:19` reintroduces it - on POSIX `os.homedir()` returns `$HOME` verbatim when it is set, including a relative value (confirmed on the snapshot Bun, Bun 1.4.2 and Node). `defaultConfigPath`/`defaultDatabasePath` therefore return relative paths, and `load.ts:739-741` uses `defaultConfigPath(env)` unanchored while `load.ts:835-841` passes the relative database path through unchanged.
- Consequence: config selection becomes CWD-dependent, contradicting `docs/CONFIGURATION.md:21-24` ("SwarmForge never searches the working directory or its parents for a config file, so a checkout cannot change the configuration of a service"). A planted `<relative home>/.config/swarmforge/config.toml` in any directory the server starts from becomes the server's configuration, including `server.db_path` and `env_file`. `src/store.ts:19` (`mkdirSync(dirname(path))`, `new Database(path)`) then creates and opens the database relative to `process.cwd()`. Tilde expansion is also wrong: `anchorPath` with a tilde value yields `<base>/<relative home>/<name>` instead of an absolute home path.
- Reproduction (bounded, local, no network; disposable clone `/tmp/rev35/probe-copy`, fixture planted under `/tmp/rev35/repro`, run from that directory with a relative `HOME`):
  - `homeDirectory` returned a relative path for the relative `HOME`.
  - `defaultConfigPath` returned a relative config path; the resolver selected that relative file and read its values even when the `cwd` option pointed at an unrelated directory, because `readFile` resolves a relative path against `process.cwd()`.
  - The resolved `SWARMFORGE_DB_PATH` was relative; constructing a `Store` with it created the directory tree inside `process.cwd()`.
  - CLI: `config path` printed the relative config path with `exists:true`; `serve --check-config` returned `ok:true` carrying that relative `config_path`.
  - Log: `/workspace/.swarmforge/logs/rev35-f1-repro.log`.
- Why guards/tests miss it: `tests/settings.test.ts:146-172` covers relative `XDG_CONFIG_HOME`/`XDG_DATA_HOME` (the `xdgBase` guard, which works) but no test supplies a relative `HOME`/`USERPROFILE`, so `homeDirectory`'s fallback branch is never exercised. The function's own docstring (`paths.ts:10-13`) promises only an absolute `HOME` is trusted "so a relative value cannot move a database or a key path".
- Recommendation: validate the `os.homedir()` fallback with `isAbsolute` as well and fail closed with a `SettingsError` (or resolve the real account home independently of `$HOME`) rather than returning a relative value; additionally reject or re-anchor relative default config/database paths in `load.ts` so a regression cannot reintroduce CWD-relative selection.

### F2 - LOW - `config path` reports the invocation directory as an existing config file for an empty `--config`, diverging from the resolver

- File/line: `src/cli.ts:215-224` (`configPath`), reported at `src/cli.ts:231-238`.
- Trigger: `swarmforge config path --config ""` (empty flag value, e.g. an unset variable expanded as `--config "$CONFIG"`).
- Mechanism: `anchorPath` with an empty string resolves to the invocation directory, so the command prints that directory with `exists: true` and exit 0. The resolver treats the same empty `configPath` as an explicit selection and fails `config_invalid` (`EISDIR`); `serve --check-config` and `config validate` exit 1.
- Consequence: the discovery-reporting command misinforms an operator about which file is in effect while the serving command rejects the same input. No file is created; no security impact.
- Reproduction: `config path --config ""` reported the CWD with `exists: true` and exit 0; `serve --check-config --config ""` failed `EISDIR` with exit 1. Log: `/workspace/.swarmforge/logs/rev35-f1-repro.log`.
- Why guards/tests miss it: `tests/commands.test.ts:385-456` covers absent, absolute, selected, relative and default selections but never an empty `--config`. `configPath()` is a second implementation of the selection rule instead of reusing `prepare()`/`selector()` from `src/settings/load.ts`, so the two can drift.
- Recommendation: treat an empty `--config`/`SWARMFORGE_CONFIG` as unset in both places (`selector()` already skips the empty string), or reject it as a usage error in `src/cli/arguments.ts` `value()`; preferably have `configPath()` reuse the resolver's selection helper.

### F3 - LOW (code-evidenced) - `scripts/smoke.ts` bypasses the config resolver

- File/line: `scripts/smoke.ts:18` (`const config = loadConfig();`), versus `src/main.ts:7` and `src/cli.ts:194` which call `resolveServerSettings`.
- Evidence: `loadConfig()` reads `process.env` only and applies the schema default `SWARMFORGE_DB_PATH = "./data/swarmforge.sqlite"` (`src/config.ts:77`), so it ignores `SWARMFORGE_CONFIG`, the discovered config file, the config file's `env_file` and the XDG database default. Verified locally: with a valid config file declaring an absolute `server.db_path` plus `env_file`, `resolveServerSettings` returned that absolute path while `loadConfig` returned the CWD-relative default, and running the script with the opt-in variable aborted on missing provider/model values even though the config file and its env file supplied them.
- Consequence: the documented opt-in smoke path cannot validate a config-file deployment, and when it does run it opens a different, CWD-relative database than the server's, so the instance-ID ownership check inspects a different database.
- Why guards/tests miss it: `tests/smoke.test.ts` is a single `test.skipIf` that never exercises the body without the real opt-in and real infrastructure; no test asserts the script uses the same configuration entry point as `serve`.
- Recommendation: resolve the smoke script's configuration through `resolveServerSettings({ env: process.env })` and add a test asserting its resolved `SWARMFORGE_DB_PATH` matches the resolver for the same environment.

## Verified-correct behaviour in scope

- Relative `XDG_CONFIG_HOME`/`XDG_DATA_HOME` are ignored and the home fallback applies (`src/settings/paths.ts:51-55`); covered by `tests/settings.test.ts:146-172` and reproduced locally.
- Foreign-CWD independence with absolute `HOME`: the home config was selected and the CWD and its parents were never searched (`tests/settings.test.ts:186-205`), reproduced locally with a foreign `cwd`.
- An empty `SWARMFORGE_CONFIG` is treated as unset by `selector()` (`src/settings/load.ts:879-887`); a relative selector anchors at the invocation directory; a missing selected file yields `config_not_found`; `overrides.SWARMFORGE_CONFIG` wins over the environment and anchors at `cwd` - all reproduced.
- Precedence and provenance labels (`config:<abs>`, `env_file:<abs>`, `env`, `override`, `default`) behaved as documented.
- Per-declaration-site anchoring: a relative `git.ssh.key_path` in a config file anchored at the config directory, while the same value from the environment anchored at the invocation directory (`src/settings/load.ts:800-822`); tilde expansion to an absolute `HOME`; the in-memory sentinel passed through verbatim (whitespace trimmed).
- Relative override host paths were anchored at `cwd` and made absolute; reading configuration created nothing on disk in the reviewed paths.

## Tests actually run

- Toolchain: Bun 1.4.2 installed at `/tmp/opencode/bun/bin/bun`; the snapshot's Bun 1.3.14 cannot read this `lockfileVersion: 2` lockfile (settings tests fail inside its TOML API), and the lockfile was never rewritten. Disposable clone used: `/tmp/rev35/probe-copy` (outside the source checkout).
- `bun test tests/settings.test.ts tests/commands.test.ts tests/cli.test.ts tests/inspect.test.ts` -> exit 0, 78 pass / 0 fail, 656 expect() calls. Log: `logs/rev35-tests-targeted.log`.
- `bun test tests/packaging.test.ts -t binary` -> exit 0, 1 pass / 0 fail (config-relevant compiled-binary case only). Log: `logs/rev35-tests-packaging.log`.
- Local probes (all under `/tmp/rev35`, no network, no real providers): relative vs absolute `HOME`/`XDG_*`; selector empty/relative/override; foreign-`cwd` selection; config-vs-env path anchoring; in-memory sentinel pass-through; `loadConfig` vs resolver for the smoke script. Consolidated log: `logs/rev35-f1-repro.log`.

## Limitations

- Full test suite not run (whole-suite reviewer owns it); only the config-relevant packaging binary case was executed from that file.
- No real Freestyle/OpenCode/model provider or infrastructure was contacted; all probes used local fake values and disposable directories. No credential files were inspected and no real credentials were used or emitted; artifacts were passed through the production `Redactor` (`src/security.ts`) to a fixed point before export.
- F3's operational impact (billable VM smoke) is inferred from code plus a local reproduction of the configuration step; the real smoke flow was never executed.
- Windows `USERPROFILE` behaviour was reasoned from code and POSIX `os.homedir()` semantics only; not executed on Windows.
- Reviewer experiments live only outside the source checkout, in `/tmp/rev35` (detached `target` worktree, `probe-copy` disposable clone, probe scripts and fixtures).
