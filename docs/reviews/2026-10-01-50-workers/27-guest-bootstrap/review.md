# Review 27-guest-bootstrap — bootstrap/launcher/systemd permissions, quoting, environment isolation, guest credential boundaries

**Exact target reviewed:** `d428e0f730ed5649485732e95d39c32f5d6a8895`
(`feature/binary-config-serve-20260930`, head commit `d428e0f Bound compiled fixture teardown independently of test assertions`)

**Verdict: FINDINGS** (1 reproduced, LOW; no CRITICAL/HIGH/MEDIUM found in scope)

**Checkout used:** disposable detached clone at `/tmp/sfrev/tgt`, `git rev-parse HEAD` = `d428e0f730ed5649485732e95d39c32f5d6a8895`. `/workspace/repo` was left on the assigned branch at baseline `5672ead2a526e07fea9ed11e58b3725e42013527`, `git status --porcelain` empty. No source files were changed, committed, pushed, merged or tagged. No production or system configuration was touched. No real cloud/model provider or infrastructure was contacted; every probe used local fakes.

## Scope actually examined

- `src/providers/freestyle.ts` — guest bootstrap, `prepare()` systemd unit, `start.sh` generation, `withGitAuth` temporary credential lifecycle, `pushBranch`, `quote()`.
- `src/providers/opencode.ts` — guest bootstrap prompt text, guest client auth.
- `src/safety.ts` — guest `python3 -c` exec and quoting of untrusted worker-reported paths.
- `src/config.ts` — env validation, `workerEnvironment` (what reaches the guest).
- `src/settings/load.ts`, `src/settings/inspect.ts`, `src/settings/paths.ts`, `src/cli.ts`, `src/cli/arguments.ts` — config/env-file layering, precedence, anchoring, credential redaction context.
- `src/serve.ts`, `src/serve-command.ts`, `src/main.ts` — launcher, process lock, event log, signal/exit policy.
- `src/store.ts`, `src/runtime.ts` — on-disk permission boundaries (DB, lock, event log).
- `scripts/build.ts`, `scripts/package.ts`, `scripts/smoke.ts`, `.github/workflows/release.yml` — only the permissions/quoting/install/launcher parts.

Not in scope and not reviewed: HTTP/MCP auth surface, metrics, coordinator state machine, packaging correctness beyond permissions, and the other 49 reviewers' areas.

## Finding 1 — LOW — Event log file mode is never re-asserted, so a pre-existing loose-mode log keeps its permissions and keeps receiving worker prompts

**File/line at target:** `src/runtime.ts:208` (`appendFileSync(path, \`${line}\n\`, { mode: 0o600 })`), reached from `src/serve.ts:192` (`eventLogger(coordinator, \`${config.SWARMFORGE_DB_PATH}.log\`)`). Contrast `src/store.ts:21`, which does re-assert the mode on every construction.

**Concrete trigger:** `<DB_PATH>.log` exists with a mode other than `0600` when the server starts appending to it. Reachable ways to get there: an operator restores or copies the database directory from a backup using an ordinary `cp`/`tar` restore (the README explicitly walks operators through relocating an existing database), a pre-existing log from an earlier build or another tool, or an operator who points `SWARMFORGE_DB_PATH` at a file inside a directory they manage by hand.

**Why the guard does not prevent it:** `fs.appendFileSync`'s `mode` option is applied by `open(..., 'a', mode)` and therefore only takes effect when the file is **created**. The code has no `chmod` on the append path, so an existing file keeps whatever mode it had, and `renameSync(path, \`${path}.1\`)` at `src/runtime.ts:207` preserves that same mode onto the rotated backup. The sibling SQLite database shows the intended pattern: `src/store.ts:21` calls `chmodSync(path, 0o600)` unconditionally on every start, so the database is re-tightened but the log beside it is not.

**Consequence:** the log receives one JSON line per durable event, and event payloads carry worker prompts — my probe produced `{"prompt":"..."}` in the appended line. Prompts are credential-free by design (they are redacted via `redactor.value`), so this is a permissions/consistency defect rather than a credential leak. Impact is bounded in the default layout because `Store` creates the parent directory `0700` (`src/store.ts:19`), which stops other local users traversing into it. Impact becomes real when `SWARMFORGE_DB_PATH` is placed in a directory that is not `0700` (for example a home directory that is `0755` on many systems, or an operator-managed `/var/lib/...`): there the database is `0600` while the adjacent log holding the same prompts is world-readable.

**Reproduction (reproduced, local, exit 0):** `/tmp/sfrev/probe/p6.ts`, run with Bun 1.4.2 against the target checkout. It created a `Store`, recorded an event whose data contained a prompt marker, pre-created `<DB>.log` at `0644` to model a restore, then drove `eventLogger` and printed modes:

```
swarmforge.sqlite-shm  0600
swarmforge.sqlite      0600
swarmforge.sqlite-wal  0600
swarmforge.sqlite.log  0644     <-- stays 0644 across three flushes
db: 0600                          <-- database is re-tightened, log is not
```

**Recommended correction:** mirror the database's pattern in `eventLogger` — after (or before) the first append, `chmodSync(path, 0o600)` when the path exists, and apply the same to the rotated `${path}.1` after `renameSync`. A one-line assertion at the top of the returned flush closure (or once at logger construction) removes the asymmetry with `src/store.ts:21`.

**Confidence:** high — reproduced directly against the target source, and the cause is the documented creation-only semantics of the `mode` option.

## Reviewed and judged NOT a defect (so the next reviewer does not re-open them)

- **SQLite sidecar permissions.** `src/store.ts:19-22` creates the parent `0700`, opens the DB, then `chmodSync(path, 0o600)` before `PRAGMA journal_mode=WAL`. I verified with a real `Store` under `umask 0022` that `swarmforge.sqlite`, `-wal` and `-shm` all end at `0600` and the directory at `0700`. The `-wal`/`-shm` files inherit the database's mode, so the "worker server passwords" the docs call out are not exposed here.
- **Process lock.** `src/runtime.ts:145-171` opens with `O_NOFOLLOW`, re-validates the inode/device after `flock`, retries, and only unlinks if the handle still names the same file. Correct hardening against symlink and rename races.
- **Guest credential boundary holds.** Drove the real `FreestyleProvider.prepare()` against a capturing local fake client (`/tmp/sfrev/probe/p2.ts`). With `FREESTYLE_API_TOKEN` and `SWARMFORGE_API_TOKEN` set to distinctive non-credential canary strings, neither appeared anywhere in the generated guest files or exec commands. `workerEnvironment` (`src/config.ts:170-183`) passes only worker/team/task ids, git tree, workspace, the model key and the port. The model key does reach the guest, which is the documented design ("Worker-scoped inference credential").
- **Guest secrets are kept out of systemd introspection.** `/etc/systemd/system/swarmforge-opencode.service` contains no `Environment=` lines and no secrets; credentials live in `/opt/swarmforge/start.sh` written `0700` inside a `chmod 700 /opt/swarmforge`. So `systemctl cat`/`systemctl show` do not expose them. The unit is written without an explicit mode, but the pinned `freestyle@0.2.13` SDK defaults `WriteFileOptions.mode` to the target's existing mode or `0o600`, and systemd reads the unit as root.
- **Quoting.** `quote()` at `src/providers/freestyle.ts:8` is textbook POSIX single-quote escaping (`'` → `'\''`). I drove `prepare()` with a deliberately hostile `SWARMFORGE_GIT_AUTHOR_NAME` (`evil'; touch /tmp/pwned; echo '`) and every interpolated value in the clone/checkout commands and the `export K=…` lines stayed correctly quoted; newlines and single quotes inside values remain inside the quotes. `branchFor` (`src/git-handoff.ts:12-14`) additionally strips non-`[A-Za-z0-9_-]` characters, and `team_id`/`task_id` are already restricted by `idSchema` (`^[a-zA-Z0-9_.:-]+$`).
- **Temporary Git credential lifecycle.** `withGitAuth` (`src/providers/freestyle.ts:186-242`) writes the GitHub App token or SSH key `0600` into the `0700` `/opt/swarmforge`, runs the action, then `rm -f` both paths, and raises `Failed to remove temporary Git credential from worker` if the cleanup cannot be confirmed. The original failure is rethrown only after the cleanup attempt, so a failure never skips the removal. The App token is fetched per operation and never stored in SQLite.
- **Guest firewall direction.** `{ source: {}, destination: { public: true } }` in `createWorker` is an **egress** allow (per the pinned SDK's own semantics: `{ source: { public: true }, destination: {…} }` is the inbound form). Guest ingress is constrained by the `tls.rules` entry that maps only `<worker-slug>.<suffix>` to `OPENCODE_PORT`, so this is not an open-inbound rule.
- **Guest OpenCode server password.** `src/store.ts:96` generates `randomUUID() + randomUUID()` (72 hex chars) per worker; the basic-auth header in `src/providers/opencode.ts:66` is built per request.
- **Configuration redaction boundary holds under indirection.** Built a real `config.toml` + `secrets.env` fixture (`/tmp/sfrev/probe/cfg`) whose credential appeared both as a `*_TOKEN` line and under a non-resolved key name (`DB_ALIAS_TOKEN`). `redactedSettings` and `redactedText` redacted all three canaries, including the indirect one, in both the reported values and free-text diagnostics, while the `FREESTYLE_API_TOKEN` / `SWARMFORGE_MODEL_API_KEY` values themselves were replaced by `[REDACTED]`. `collectSecrets` runs before parsing, so a malformed file cannot echo a value out of a file that failed to parse.
- **Launcher environment isolation is real.** The compiled binary sets `autoloadDotenv`/`autoloadBunfig`/`autoloadTsconfig`/`autoloadPackageJson` to `false` (`scripts/build.ts:46-56`) and `.github/workflows/release.yml:78-81` exercises the binary under `env -i` with a synthetic `HOME`. Dev scripts use `bun --no-env-file --config=/dev/null`. `SWARMFORGE_CONFIG` is deliberately read only from overrides and the process environment, never from an environment file.
- **CI does not interpolate untrusted text into shell.** `RELEASE_TAG` and `github.ref_name` are passed as quoted `argv` (`release.yml:48`, `:145`), and the release title/notes are built by `gh release create` arguments, not string-interpolated shell. No credential is placed in a tag, asset name or note.
- **Guest `mkdir -p` without an explicit mode** for `${workspace}/.swarmforge/{artifacts,logs}` (default `0755` under a `0700`-capable workspace) is noted but is not a boundary violation: a guest VM has a single principal (the root OpenCode agent) and artifacts are read back through the provider API, not through the guest filesystem by other users.

## Tests and probes actually executed

Toolchain: official Bun 1.4.2 unpacked to `/tmp/bun142/bun-linux-x64/bun` (`--version` = `1.4.2`), because the sandbox `bun` is 1.3.14 and cannot read this lockfile. `bun.lock` was never rewritten. Dependencies installed with `--frozen-lockfile` into the disposable checkout only.

| Command | Result |
| --- | --- |
| `bun test tests/settings.test.ts tests/inspect.test.ts tests/commands.test.ts` | exit 0 — 76 pass, 0 fail, 646 expect() calls, 3 files |
| `bun test tests/serve.test.ts tests/adapters.test.ts tests/safety.test.ts tests/lifecycle.test.ts tests/process-lock.test.ts` | exit 0 — 66 pass, 0 fail, 261 expect() calls, 5 files |
| `/tmp/sfrev/probe/p1.ts` (Store on-disk modes) | exit 0 — DB, `-wal`, `-shm` all `0600`, dir `0700` |
| `/tmp/sfrev/probe/p2.ts` (prepare() with fake client, credential canaries + hostile author name) | exit 0 — control-plane secrets absent from guest; quoting intact |
| `/tmp/sfrev/probe/p3.ts` (config/env-file redaction with indirect credential) | exit 0 — all three canaries redacted |
| `/tmp/sfrev/probe/p6.ts` (event log mode) | exit 0 — reproduced Finding 1 (`0644` retained) |

I did not run the full suite (that belongs to the whole-suite reviewer), did not compile the binary (packaging scope), and did not run `SWARMFORGE_RUN_SMOKE` smoke (real billable infrastructure).

Reviewer experiments are disclosed and live **outside** the source checkout: `/tmp/sfrev/tgt` (detached target clone), `/tmp/sfrev/probe` (probes `p1`–`p6` and the `cfg` fixture), `/tmp/sfrev/dbg` (a throwaway instrumented copy of `src/` used only to debug my own mistyped fixture key, never a conclusion source), `/tmp/bun142` (Bun 1.4.2).

## Limitations

- All findings are from static reading plus local fakes. No guest VM, no real Freestyle control plane, no systemd inside a guest, and no real model provider were exercised, so runtime-only behaviour of `vm.fs.writeTextFile` mode handling and of `systemctl` inside a real guest remains unverified.
- The guest-side view (what the OpenCode agent can actually read at runtime) was not observed; conclusions about it are inferred from the generated `start.sh`, unit and opencode config.
- Example credential-shaped strings in this report are synthetic local canaries created for probing (`infra-…`, `model-…`, `indirect-…`, `mcp-…`, `SECRET-PROMPT-TEXT`). No real credential, token, key or URL was read, and no secret file was inspected.
