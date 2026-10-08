# Review 39 — CLI grammar / argument parsing (read-only)

- Exact target: `d428e0f730ed5649485732e95d39c32f5d6a8895` (branch `feature/binary-config-serve-20260930`, verified `git rev-parse HEAD`)
- Assigned checkout (untouched, clean): `/workspace/repo` at `5672ead2a526e07fea9ed11e58b3725e42013527`
- Disposable review checkout (all experiments here): `/tmp/rev39/target` (detached, `git clone --shared` from `/workspace/repo`, node_modules installed there only)
- Bun used: official `1.4.2` at `/tmp/rev39/bun-linux-x64/bun` (snapshot `bun` is 1.3.14; lockfile untouched)
- Scope: `src/cli/arguments.ts`, `src/cli.ts` argument dispatch/usage text, and the flag defaults/overrides that reach the resolver (`src/settings/load.ts` entry points used by CLI flags). No lifecycle, packaging, MCP or provider behaviour reviewed.
- Verdict: **FINDINGS** (2 actionable, 1 minor; no critical/high)

## Finding 1 — MEDIUM — An empty flag value is accepted and silently ignored; `status --url ""` targets the wrong endpoint

- File/line at target: `src/cli/arguments.ts:48-53` (`value()`), call site `src/cli/arguments.ts:66`; effect at `src/settings/load.ts:662` and `src/settings/load.ts:871`.
- Trigger: any value-taking flag with an empty string value, e.g. `swarmforge status --url "" --json` (typical when a shell variable is unset: `--url "$ENDPOINT"`). Also `swarmforge status --config ""` and `swarmforge status --env-file ""`.
- Consequence: `value()` only rejects an exhausted iterator (`next.done === true || next.value === undefined`), so `""` is returned as a legal value. For `--url`, the loader treats an empty override as *unset* (`setValue`: `if (value === "") return;`, `src/settings/load.ts:662`) and falls back to `SWARMFORGE_URL` or `DEFAULT_CLIENT_URL` (`src/settings/load.ts:871`, `http://127.0.0.1:8787/mcp`). The command therefore silently queries a *different* endpoint than the operator wrote instead of failing as a usage error; with a local instance running, `status --url "" --json` returns the local swarm's data as if it were the requested deployment's. `--config ""`/`--env-file ""` anchor to the invocation directory and report `Cannot read <cwd>: EISDIR`.
- Reproduction (reproduced, exit codes captured):
  - `status --url "" --json` → stderr `SwarmForge: Unable to connect. Is the computer able to access the url?`, exit 1 (i.e. it attempted the *default* endpoint; no usage error).
  - `SWARMFORGE_URL=http://127.0.0.1:9/mcp status --url "" --json` → same message, exit 1 (the empty override is discarded entirely).
  - `status --config ""` → `SwarmForge: Cannot read /tmp/rev39/target: EISDIR`, exit 1.
  - `status --env-file ""` → `SwarmForge: Cannot read environment file /tmp/rev39/target: EISDIR`, exit 1.
- Code trace: `parseArguments` → `status()` → `value(iterator, "--url", "an endpoint")` returns `""` → `overrides: { SWARMFORGE_URL: "" }` → `selection(command)` → `resolveClientSettings({overrides})` → `merged()` applies overrides via `setValue` (empty ⇒ ignored) → `url = values.url ?? DEFAULT_CLIENT_URL`.
- Backward compatibility: this is a regression against the pre-target parser. At baseline `5672ead` `argumentsFor()` used `const value = rest.shift(); if (!value) throw new Error("--url requires an endpoint");`, so `--url ""` was a usage error. Defaults themselves are unchanged (`DEFAULT_CLIENT_URL` matches the old hardcoded default) and all previously accepted status flags (`--json`, `--no-interactive`, `--url`, `--help`, `-h`) still work, including the implicit `status` form.
- Why existing guards/tests do not prevent it: `tests/commands.test.ts:227-238` and `:295-306` cover only an *absent* value (flag at end of argv) and unknown flags; no case supplies an empty or flag-shaped value. The "empty means unset" rule is documented for config files and environment variables (`docs/CONFIGURATION.md`), not for CLI flag values, so nothing asserts the old refusal.
- Recommendation: in `value()` refuse an empty string (`if (next.value === "") throw new UsageError(\`${flag} requires ${noun}\`)`), restoring the baseline behaviour and keeping flag values from being silently dropped.

## Finding 2 — LOW — A flag in a value position is consumed as the value, silently voiding `--check-config`

- File/line at target: `src/cli/arguments.ts:48-53` (`value()`), call sites `src/cli/arguments.ts:66,68,70,93,94,95,118,119`; contrast the deliberate guard for the action position at `src/cli/arguments.ts:110`.
- Trigger: a value-taking flag followed by another flag instead of a value, e.g. `swarmforge serve --config --check-config`, `swarmforge serve --env-file --check-config`, `swarmforge status --url --json`.
- Consequence: `value()` takes the next token unconditionally, so `--check-config` becomes the value of `--config` and `checkConfig` stays `false`: the documented guarantee "Validate … and exit without creating a database, lock file or listener" (`src/cli.ts:52-53`) and the "a rejected command never constructs a provider, opens a database, takes a process lock or binds a listener" intent (`src/cli.ts:201-203`) never apply because the command is accepted as a normal `serve`. In practice it fails later with an unrelated message (`Config file not found: <cwd>/--check-config`, `Environment file not found: …`, `Client endpoint must use http or https: --json`), so an operator's dry-run preflight reports a path error instead of the intended validation. Note the asymmetry: the config *action* position already rejects a flag (`arguments.ts:110`, "A flag in the action position is a missing action"), so this is an inconsistency rather than an intended grammar.
- Reproduction (reproduced; no state created, nothing bound):
  - `serve --config --check-config` → `SwarmForge: Config file not found: /tmp/rev39/target/--check-config`, exit 1.
  - `serve --env-file --check-config` → `SwarmForge: Environment file not found: /tmp/rev39/target/--check-config`, exit 1.
  - `status --url --json` → `SwarmForge: Client endpoint must use http or https: --json`, exit 1 (the `--json` request is lost).
  - `serve --check-config --config <real file>` and `serve --config <real file> --check-config` both parse to `checkConfig: true` (correct order works).
  - Verified `/tmp/rev39/state` stayed empty (no database, lock file, event log or listener) in all failing cases, so severity is limited to diagnostic quality; the only path to a silently started server would require a real file literally named `--check-config` in the working directory (hypothetical, not reproduced).
- Why existing guards/tests do not prevent it: `tests/commands.test.ts:724` ("serve --check-config validates the server intent and starts nothing") only exercises the correct flag order, and the usage-error table only covers a flag at end of argv. No test places a flag in a value position.
- Recommendation: reuse the existing action-position rule inside `value()` — treat a next token that starts with `-` as a missing value (`throw new UsageError(\`${flag} requires ${noun}\`)`); this fixes Finding 1's empty-value case in the same place.

## Finding 3 — LOW — `--version`/`--help` discard all remaining arguments

- File/line at target: `src/cli/arguments.ts:144-145` (head match returns before the remainder is scanned); `src/cli/arguments.ts:106-108` behaves the same for `config --help`.
- Trigger: `swarmforge --version --nonsense`, `swarmforge -V status`, `swarmforge --version serve`.
- Consequence: exit 0 with the version/help printed and unknown arguments silently ignored, which is inconsistent with the strict "unknown argument" refusal used everywhere else and can mask a typo or a misplaced subcommand in a script. `-h` and `-V` are also accepted but undocumented (usage lists only `--help` and `--version`).
- Reproduction: pure-parser probe (`/tmp/rev39/probe/parse.ts`) → `parseArguments(["-V","--nonsense"])` = `{kind:"version"}`, `parseArguments(["--version","status"])` = `{kind:"version"}`.
- Why existing guards/tests do not prevent it: `tests/commands.test.ts:214-215` asserts only the accepted forms; nothing asserts behaviour for trailing arguments.
- Recommendation: after matching help/version, reject leftover arguments with a usage error, or state in `--help` that further arguments are ignored; document `-h`/`-V`.

## Notes (no defect claimed)

- Repeated `--url`/`--config` are last-wins without warning (`["status","--url","http://a/mcp","--url","http://b/mcp"]` → `b`), `--json`/`--no-interactive`/`--check-config` are idempotent, and `--env-file` accumulates in order as documented. Only `--env-file` repeatability is documented; last-wins for the others is unstated but conventional.
- No `--flag=value` form is accepted (`--url=http://a/mcp` → `Unknown argument`), although the repository's own `package.json` scripts use `--config=/dev/null`. `--check-config=yes` is deliberately refused (`tests/commands.test.ts:233`), so this is a consistency observation, not a defect.
- No `--` end-of-options terminator: `swarmforge -- --json` → `Unknown argument: --`. Acceptable for this flag set (no positional values) but undocumented.
- `config path|show|validate` correctly refuses a missing action, a flag in the action position, an unknown action and a second action; `config PATH` (case) is refused with a clear message.
- `mcpEndpoint()` (`src/cli.ts:138-142`) no longer validates the scheme itself, but `resolveClientSettings` (`src/settings/load.ts:874-887`) rejects anything that is not http/https, so the baseline behaviour (`ftp://host/mcp` refused) is preserved; only the message wording changed.

## Tests / probes run (Bun 1.4.2, from `/tmp/rev39/target`)

- `bun test tests/commands.test.ts` → exit 0, 15 pass / 0 fail, 223 expect() calls (log: `/workspace/.swarmforge/logs/rev39-commands-test.log`)
- `bun test tests/cli.test.ts` → exit 0, 2 pass / 0 fail, 10 expect() calls (log: `/workspace/.swarmforge/logs/rev39-cli-test.log`)
- Pure parser probe `bun run /tmp/rev39/probe/parse.ts` (37 argv cases, exit 0) and nine bounded CLI invocations of `src/cli.ts` with `HOME`/`XDG_CONFIG_HOME`/`XDG_DATA_HOME` and the database path pointed at `/tmp/rev39`, fake placeholder settings only, no provider or network calls; the status cases only ever attempted a loopback connection.
- No full-suite run (whole-suite reviewer's scope), no packaging build, no real cloud/model provider contacted.

## Limitations

- Findings are reproduced on Linux/Bun 1.4.2 with a POSIX shell; argv handling on Windows (where `\` and quoting differ) was not probed.
- The "silently started server" variant of Finding 2 was *not* reproduced (it needs a file named `--check-config` to exist and be valid TOML); it is a code-evidenced consequence of `checkConfig: false` reaching `serveCommand`, not an observed run.
- Consequence of Finding 1 for a *running* local server (wrong-server status output) is derived from the resolver trace plus the observed fallback, not from an end-to-end run against a live instance.
- Reviewer artifacts live only under `/tmp/rev39` and `/workspace/.swarmforge`; `/workspace/repo` is unchanged, clean and still at its assigned baseline. No secrets or credential-shaped examples appear in this report.