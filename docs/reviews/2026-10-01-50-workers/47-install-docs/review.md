# SwarmForge review — install/docs/config/env scope

- Target: `d428e0f730ed5649485732e95d39c32f5d6a8895` (branch `feature/binary-config-serve-20260930`)
- Base reviewed alongside: `5672ead2a526e07fea9ed11e58b3725e42013527`
- Reviewer: read-only, 50-way parallel review. Verdict: **FINDINGS** (3 doc/instruction defects + 1 LOW)
- Disposable detached checkout: `/tmp/opencode/rv/review` (`git rev-parse HEAD` = target). `/workspace/repo` untouched (baseline `5672ead`, clean).

## Scope

README.md, docs/CONFIGURATION.md, docs/ENVIRONMENT.md, docs/SERVE.md, .env.example, package.json
scripts, scripts/package.ts (checksum/manifest contract), and the resolver/CLI code that those
instructions describe (`src/settings/load.ts`, `src/settings/paths.ts`, `src/cli.ts`,
`src/cli/arguments.ts`, `src/config.ts`, `src/main.ts`, `src/serve-command.ts`, `src/store.ts`).

---

## Finding 1 — MEDIUM: quickstart says `cp .env.example .env`, but no supported entry point loads `.env`

- Files/lines: `README.md:9`, `README.md:12`, `README.md:26`; contradicting `README.md:17`,
  `package.json:10-13`, `docs/ENVIRONMENT.md:3`.
- Code evidence: `package.json:10-13` runs every script as
  `bun --no-env-file --config=/dev/null src/cli.ts serve`; the compiled binary is built with
  `autoload_dotenv: false` (`scripts/package.ts:106`). SwarmForge itself has no implicit `.env`
  discovery: `src/main.ts:7` calls `resolveServerSettings()` with no options, so only a config
  file (`src/settings/paths.ts:58`), its `env_file`, explicit `--env-file`, or the process
  environment is read (`src/settings/load.ts:738-762`).
- Trigger: follow README:9 verbatim — `cp .env.example .env`, fill the six values, then
  `bun run dev` (README:12) or `bun start` (README:26).
- Consequence: exit 1 and a diagnostic naming all six required values; the server never starts.
  README:17-22 and README:20 (`bun run start -- --env-file .env`) do state this four lines later,
  so the first-run path as printed is wrong even though the corrected form exists elsewhere.
- Reproduction (reproduced, exit codes captured): with a filled `.env` in the checkout cwd,
  `bun --no-env-file --config=/dev/null src/cli.ts serve --check-config` → **exit 1**,
  "Invalid configuration: FREESTYLE_API_TOKEN … SWARMFORGE_GIT_TREE: Invalid input: expected
  string, received undefined". Adding `--env-file .env` → **exit 0**, `ok: true`.
- Why guards do not prevent it: `tests/packaging.test.ts:851` only asserts the scripts *contain*
  `--no-env-file`, and `tests/packaging.test.ts:871` tests the *corrected* `--env-file` form. No
  test parses README:9/README:12 or asserts that a plain `bun run start` can start.
- Recommendation: change README:9 to `cp .env.example .env … bun run start -- --env-file .env`
  (or export the values), fix README:26 to the same, and correct `docs/ENVIRONMENT.md:3`
  ("Bun loads `.env`") to state that no entry point loads `.env` implicitly.

## Finding 2 — MEDIUM: `docs/ENVIRONMENT.md:31` documents a database default that no longer exists (migration trap)

- Files/lines: `docs/ENVIRONMENT.md:31` vs `docs/CONFIGURATION.md:129-133` and
  `docs/CONFIGURATION.md:3`.
- Code evidence: `src/settings/load.ts:835-841` sets `SWARMFORGE_DB_PATH` to
  `defaultDatabasePath()` (`src/settings/paths.ts:66-72`) = `$XDG_DATA_HOME/swarmforge/…` when
  absolute, else `~/.local/share/swarmforge/swarmforge.sqlite`. The old `./data/swarmforge.sqlite`
  only survives as `loadConfig`'s own zod default (`src/config.ts:77`), which the resolver always
  overrides first. `CONFIGURATION.md:3` promises ENVIRONMENT.md "stays valid", and
  `CONFIGURATION.md:130-131` explicitly says the XDG default "replaces the environment-only
  default `./data/swarmforge.sqlite`" — yet ENVIRONMENT.md was not updated by this branch.
- Trigger: an existing deployment that never set `SWARMFORGE_DB_PATH` and relied on the
  documented default, upgraded to this build.
- Consequence: the server silently opens a *new, empty* database under
  `~/.local/share/swarmforge/`. Every worker row, result and instance history disappears from
  `status`/MCP. Nothing refuses the cutover: the instance-ID ownership check runs against the new
  empty file, so `SWARMFORGE_INSTANCE_ID=default` still matches and startup succeeds
  (`docs/SERVE.md` startup step 3). The old database is orphaned and still holds a stale lock file.
- Reproduction (reproduced): with no `SWARMFORGE_DB_PATH` in the environment and an isolated
  `HOME`, `bun … src/cli.ts config show` → exit 0, `SWARMFORGE_DB_PATH =
  <HOME>/.local/share/swarmforge/swarmforge.sqlite`, `source: default`.
- Why guards do not prevent it: `tests/settings.test.ts:169-184` asserts the *new* XDG default, so
  the code and the test agree; only the ENVIRONMENT.md table still prints the old value, and no
  test compares documented defaults against the resolver.
- Recommendation: update the `docs/ENVIRONMENT.md:31` default cell to the XDG value (with the
  `~`/absolute note) and add a one-line migration warning there, since ENVIRONMENT.md is the
  reference operators are pointed at for every variable.

## Finding 3 — MEDIUM: the documented systemd unit has no `WorkingDirectory`, and the shipped `db_path` is relative

- Files/lines: `README.md:95-101` (unit), `.env.example:36`, `docs/CONFIGURATION.md:132-134`.
- Code evidence: a relative `SWARMFORGE_DB_PATH` from an env file anchors at the invocation
  directory (`src/settings/load.ts:796-804` uses `prepared.cwd`), and `src/store.ts:19` creates the
  parent with `mkdirSync(dirname(path), {recursive:true})` before opening SQLite.
- Trigger: install the README unit verbatim with a `secrets.env` derived from `.env.example`
  (which ships `SWARMFORGE_DB_PATH=./data/swarmforge.sqlite`) and no `WorkingDirectory=`.
- Consequence: systemd's default working directory is `/`, so the database resolves to
  `/data/swarmforge.sqlite` (created as root) instead of the deployment's existing file — a
  second silent instance split — or, for a non-root `User=`, startup fails at `mkdir` with EACCES
  and `serve` exits 1 (`src/serve-command.ts:175-180`).
- Reproduction (reproduced, anchoring half): `--env-file ./secrets.env` run from an empty
  directory resolved `SWARMFORGE_DB_PATH = <cwd>/data/swarmforge.sqlite` (exit 0). The systemd
  `cwd=/` case is inferred from the documented default cwd plus this anchoring, not executed.
- Why guards do not prevent it: `src/cli.ts:194-201` (`--check-config`) reports the anchored path,
  but the README never tells the operator to run it for the unit, and no test covers a unit file
  or a `/` working directory. `tests/settings.test.ts:391-404` pins the anchoring behaviour as
  intended, so this is guidance, not code, that is missing.
- Recommendation: add `WorkingDirectory=/home/operator` (and `User=`) to the README unit, and
  state next to `.env.example:36` that the relative default resolves against the process working
  directory, so a service should set an absolute path.

## Finding 4 — LOW: `docs/ENVIRONMENT.md:3` still asserts "Bun loads `.env`"

- Files/lines: `docs/ENVIRONMENT.md:3` vs `README.md:17`, `README.md:67-68`,
  `scripts/package.ts:106-111`.
- Trigger/consequence: an operator reading the environment reference concludes a `.env` beside the
  binary or checkout is authoritative, and debugs a configuration that is in fact not being read.
  Same root cause as Finding 1 but a different, more authoritative page.
- Recommendation: rewrite the sentence to name `--env-file`, `env_file` and `SWARMFORGE_CONFIG`
  as the only ways a file is read.

---

## Verified correct (no finding)

- **Checksum install safety** (`README.md:44-70` vs `scripts/package.ts`): the archive is a flat
  tar (`metadata-<v>.json`, `SHA256SUMS`, `swarmforge`), and `SHA256SUMS` is
  `"<sha256>  swarmforge\n"` (`scripts/package.ts:75-77`, staging at `310-320`), so
  `sha256sum -c SHA256SUMS` inside the extracted tree matches the README block exactly.
- **Install-block errexit claim** (`README.md:58-63`): reproduced both ways on a synthetic archive
  built the way `package.ts` builds one. Good archive → `swarmforge: OK`, exit 0, binary installed
  mode 0755. Repacked archive with an edited payload and the original manifest →
  `swarmforge: FAILED` + `sha256sum: WARNING: 1 computed checksum did NOT match`, block exit 1,
  `~/.local/bin` never created. `tests/packaging.test.ts:1043` executes the README block too.
- **PATH guidance** (`README.md:64-66`): correct for the compiled binary — no Bun/`node_modules`
  needed, and ambient `.env`/`bunfig.toml` cannot reconfigure it.
- **Documented CLI surface** (`README.md:75-83`): `config path|show|validate`, `serve
  --check-config`, `serve --env-file`, `status --json --url` all exist and behave as described
  (`src/cli/arguments.ts:13,55-124`; `src/cli.ts:194-201,225-247`).
- **"Six required infrastructure values"** (`README.md:9`): matches `src/config.ts` (token,
  snapshot, model base URL/key/name, git tree).
- **`--check-config` creates nothing** (`README.md:80`, `docs/CONFIGURATION.md:25`): reproduced —
  empty cwd stayed empty after `serve --check-config --env-file ./secrets.env`.
- **Precedence, anchoring and XDG rules** (`docs/CONFIGURATION.md:113-145`): match
  `src/settings/load.ts:725-822` and `src/settings/paths.ts:39-72` as written, including
  `SWARMFORGE_CONFIG` never coming from an env file and `:memory:` pass-through.
- **ENVIRONMENT.md default values** other than `SWARMFORGE_DB_PATH` all match `src/config.ts`
  (API URL, `default` instance, ports, limits, `60000` shutdown default, 24-char bearer floor).
- **systemd claims** (`README.md:93,103`): `Type=exec` and `TimeoutStopSec=90s` vs
  `defaultShutdownTimeoutMs = 60000` and `forcedShutdownExitCode = 70`
  (`src/serve-command.ts:9,12`) are consistent.

## Tests / probes run

Toolchain: official Bun **1.4.2** at `/tmp/opencode/bun142/bun-linux-x64/bun` (host Bun is
1.3.14 and cannot read this lockfile). Lockfile never rewritten; probes ran in a copy at
`/tmp/opencode/rv/probe`.

| Command | Exit / result |
| --- | --- |
| `bun install --frozen-lockfile` (probe copy) | 0, 125 packages, `git status` clean |
| `bun test tests/settings.test.ts` | 0 — **56 pass, 0 fail**, 404 assertions |
| `bun test tests/cli.test.ts` | 0 — **2 pass, 0 fail**, 10 assertions |
| `config show` with no `SWARMFORGE_DB_PATH` (isolated `HOME`) | 0 — reports `~/.local/share/swarmforge/swarmforge.sqlite`, source `default` |
| `serve --check-config` with `.env` present but not passed | **1** — six required values reported missing |
| `serve --check-config --env-file .env` | 0 — `ok: true`, `db_path` anchored to cwd |
| `serve --check-config --env-file ./secrets.env` in empty dir | 0 — `<cwd>/data/swarmforge.sqlite`, nothing created |
| README install block, good synthetic archive | 0 — `OK`, installed 0755 |
| README install block, repacked archive, edited payload | **1** — `FAILED`, nothing installed |

Not run: full suite (whole-suite reviewer's scope), packaging/compile tests, any cloud, provider
or VM smoke.

## Limitations

- Finding 3's systemd consequence is inferred from the documented unit plus the reproduced
  anchoring and `mkdirSync` behaviour; no unit file was loaded into systemd.
- Documentation contradictions were checked against `README.md`, `docs/CONFIGURATION.md`,
  `docs/ENVIRONMENT.md`, `docs/SERVE.md` and `.env.example` only; `docs/MCP-API.md`,
  `docs/ARCHITECTURE.md`, `docs/OBSERVABILITY.md`, `docs/WORKER-PROTOCOL.md`, `docs/RESEARCH.md`
  and `docs/IMPLEMENTATION-PLAN.md` were not audited.
- `swarmforge status` against a live MCP endpoint, TLS/reverse-proxy guidance and the Git-handoff
  setup steps were reviewed by reading only; no provider or remote was contacted.
- No credentials were read, printed or produced; all probe values are placeholders in isolated
  `/tmp` directories.