# SwarmForge reviewer report — worker environment / token isolation / logging

- **Target (exact):** `d428e0f730ed5649485732e95d39c32f5d6a8895` (branch `feature/binary-config-serve-20260930`)
- **Assigned baseline workspace:** `/workspace/repo` at `5672ead2a526e07fea9ed11e58b3725e42013527` (left untouched, clean)
- **Disposable checkout:** `/tmp/sfrev34/clone` (detached at target; `git rev-parse HEAD` verified)
- **Reviewer scope:** Worker environment allowlist, model/provider/API token isolation, child-process environments, accidental logging
- **Verdict:** FINDINGS (4) — investigation complete, all findings finished and reproduced; report delivered during bounded recovery after the original review exceeded its 30-minute deadline. **Not INCOMPLETE:** every finding below has finished evidence, recorded file/line, a reproduction or exact code trace, and a recommendation. Only the bounded limitations listed at the end remain.
- **Toolchain:** official Bun 1.4.2 unpacked at `/tmp/bun142`; `bun install --frozen-lockfile` exit 0. No lockfile rewrite, no real cloud/model provider or infrastructure call. No credentials used; all values below are synthetic dummies created for these probes.
- **Sanitization:** every credential literal and credential-shaped example in this report has been replaced with a placeholder before export. Placeholders use the forms `<PAT>`, `<user>:<pass>@`, `<token>@` and describe the *shape* that the defective pattern fails to match; they are not real or realistic credential values. See "Sanitization pass" below.

## Scope reviewed

`src/config.ts` (`workerEnvironment`, `gitTree`, schema), `src/security.ts` (`Redactor`, `redactorFor`, `excerptText`),
`src/runtime.ts` (`eventLogger`, `renderEvent`), `src/files.ts` (`WorkerFiles`), `src/mcp.ts`,
`src/providers/freestyle.ts` (`prepare`, `withGitAuth`, `pushBranch`, guest `start.sh`/`opencode.json`),
`src/providers/opencode.ts` (`openCodeConfig`, `bootstrap`), `src/git-handoff.ts`, `src/serve-command.ts`
(`commandRedactor`), `src/serve.ts`, `src/store.ts` (event writes), `src/settings/{load,inspect,paths}.ts`,
`src/cli.ts`, `scripts/{build,package,smoke}.ts`, plus `docs/ENVIRONMENT.md`, `docs/CONFIGURATION.md`,
`docs/SERVE.md`, `docs/OBSERVABILITY.md`.

Reviewer experiments live only in `/tmp/sfrev34/probe` (probes `p1.ts`–`p14.ts`, a throwaway `git init` dir) and
`/tmp/sfrev34/clone` (target checkout). Nothing was written to `/workspace/repo`.

---

## F1 — HIGH — URL-embedded credentials are not redacted: the userinfo pattern misses token-only and non-http(s) forms

- **File/line at target:** `src/security.ts:18` inside `Redactor.text`
  ```ts
  .replace(/(https?:\/\/)[^\s\/@]+:[^\s\/@]+@/g, "$1[REDACTED]@")
  ```
- **Trigger:** any deployment whose `SWARMFORGE_GIT_TREE` (or `SWARMFORGE_GIT_PUSH_URL`, or any value a worker
  echoes) contains a credential in either of these shapes:
  1. token-only userinfo — `https://<PAT>@github.com/owner/private.git` (GitHub's own documented PAT clone form;
     no `user:password` colon, so the regex does not match), and
  2. any non-`http(s)` scheme — `ssh://<user>:<pass>@host/...`, `git://`, `git+ssh://`.
- **Consequence:** the credential is printed verbatim by `swarmforge config show`, `config validate` and
  `serve --check-config` (the report the docs say "can be pasted into a ticket"), and is *not* scrubbed anywhere
  else that relies on this redactor.
- **Reproduction (reproduced, exit 0, real CLI at target):**
  ```
  env -i ... SWARMFORGE_GIT_TREE='https://<PAT>@github.com/owner/private.git' \
    bun --no-env-file --config=/dev/null src/cli.ts config validate
  → {"ok":true, ... "SWARMFORGE_GIT_TREE":"https://<PAT>@github.com/owner/private.git" ...}
  ```
  Same for `config show` and `serve --check-config` (both exit 0; the printed value still contained the token
  prefix `<PAT>`). Probe `p3.ts` shows the Redactor leaves both shapes untouched; the `user:pass@` and `?token=[REDACTED]
  shapes *are* redacted.
  Downstream reachability of the same value, all reproduced: `/tmp/sfrev34/probe/p12.ts` (a worker result
  `details` and the live excerpt both retain the token), `p9.ts` (persisted `git.tree`), `p11.ts`
  (`get_worker_artifact` returns the token to the MCP client because artifact screening uses the same Redactor).
- **Why existing guards/tests do not prevent it:** `collectSecrets` (`src/settings/load.ts:442-453`) only harvests
  values whose *key name* matches `/token|key|secret|password|credential/i`, and `SWARMFORGE_GIT_TREE` does not
  match, so the value never enters the secret set. The URL heuristic is the only remaining guard and it is
  incomplete. `redactedSettings` (`src/settings/inspect.ts:111`) marks only the three `SECRET_KEYS`, so the tree
  value is printed through `redactor.text` alone. Tests only exercise the shapes the regex does handle:
  `tests/settings.test.ts:816-834` (a `https://[REDACTED]@…` URL) and `tests/serve.test.ts:713-786`
  (a `https://[REDACTED]@…?api_key=[REDACTED] URL). Both use repository-controlled fixture values, quoted here by shape only.
- **Recommendation:** widen the pattern to any scheme and to password-less userinfo, e.g.
  `/([a-z][a-z0-9+.-]*:\/\/)[^\s\/?#@]+@/gi` → `"$1[REDACTED]@"`, and add a regression test for
  `https://<token>@host/...` and `ssh://<user>:<pass>@host/...`. Optionally also reject userinfo in
  `SWARMFORGE_GIT_TREE` at validation time (`src/config.ts:49`) with a message pointing at the Git credential
  mechanisms the project already ships (`github-app`, `ssh`).

## F2 — MEDIUM — `workerEnvironment` hands a credential-bearing `SWARMFORGE_GIT_TREE` to the guest and instructs the model to read it

- **File/line at target:** `src/config.ts:178` (allowlist entry) and `src/providers/opencode.ts:42` (bootstrap text
  for the `none:` case); schema at `src/config.ts:49`.
- **Trigger:** `SWARMFORGE_GIT_TREE=none:https://<PAT>@github.com/owner/private.git` (or the plain clone form) —
  accepted by `loadConfig`; nothing validates or rewrites userinfo.
- **Consequence:** the repository credential is exported into the guest `start.sh` (`src/providers/freestyle.ts:150-170`,
  file mode 0700 under `/opt/swarmforge`, which the guest's root-run OpenCode service can read), and in `none:`
  mode the system prompt explicitly tells the model to "inspect that environment variable". In clone mode the same
  URL is written into the clone's `.git/config` `remote.origin.url` (verified offline: `git remote add origin
  'https://<token>@…'` persists the userinfo), so the worker can also read, commit, or publish it. This contradicts
  `docs/ENVIRONMENT.md:15` ("Credentials stay external") and the isolation property asserted at
  `docs/ENVIRONMENT.md:49`.
- **Reproduction (reproduced, code-evidenced + probe):** `/tmp/sfrev34/probe/p5.ts` — `loadConfig` accepts the value;
  `workerEnvironment(...)` returns the tree target with its userinfo intact; the bootstrap mentions the variable
  (the value itself is not inlined in the prompt).
- **Why existing guards/tests do not prevent it:** the allowlist is an explicit key list, so the test at
  `tests/core.test.ts:59-68` only proves that `FREESTYLE_API_TOKEN` is absent; nothing asserts the *values* are
  credential-free, and `tests/git-handoff.test.ts:74-88` pins the opposite behaviour for GitHub App mode only
  (the tree must equal `https://github.com/owner/repo[.git]`). The `none:`-prefix path has no equivalent rule.
- **Recommendation:** reject a `SWARMFORGE_GIT_TREE` whose URL contains userinfo for every push mode (or at least
  for `none:`), and pass a credential-free tree value to the guest. Add a `tests/core.test.ts` assertion that no
  allowlisted value contains `@` userinfo.

## F3 — MEDIUM — the control-plane event console line is printed from the raw event while the file line is redacted

- **File/line at target:** `src/runtime.ts:196` (`console.log(renderEvent(event, safe))`) versus the redacted file
  write at `src/runtime.ts:197-208`. `renderEvent` reads `event.data` verbatim (`src/runtime.ts:89-94`).
- **Trigger:** any credential that reaches an event payload. `renderEvent` receives the raw `WorkerEvent`; only the
  worker *metadata* object is passed through `redactor.value` as `safe`. The console sink therefore bypasses the
  redactor for `event.data` while the file sink does not.
- **Consequence:** the control-plane stdout stream (systemd journal, container log driver, CI log) can carry a
  credential that the on-disk event log correctly redacts — an inconsistency that defeats the stated
  "structured transition logs … exclude known secrets" property in `docs/OBSERVABILITY.md:30`.
- **Reproduction (reproduced):** `/tmp/sfrev34/probe/p6.ts` seeds one event whose `data` contains the configured
  `SWARMFORGE_MODEL_API_KEY`:
  ```
  CONSOLE: … result.received … {"run_id":"r1","note":"worker echoed <MODEL_KEY> and https://[REDACTED]@h/v1"}
  FILE:    … "note":"worker echoed [REDACTED] and https://[REDACTED]@h/v1"
  console leaks configured secret: true
  file leaks configured secret   : false
  ```
  **Reachability today is limited:** the only non-empty payloads written are
  `store.event(id, "result.received", { run_id, status })` (`src/store.ts:287`), whose values are a server-generated
  UUID and a fixed enum, and the empty `{}` payloads at `src/store.ts:127,166` and `src/coordinator.ts:872`. No
  current call site writes attacker- or model-controlled text into an event payload, so this is a latent sink
  divergence rather than a demonstrated live leak — hence MEDIUM, not HIGH.
- **Why existing guards/tests do not prevent it:** `tests/core.test.ts:168-191` asserts only that `renderEvent`
  *renders* fields and colour codes; no test compares the console and file renderings of the same event, and no
  test feeds a secret-bearing `event.data`.
- **Recommendation:** render the console line from the same redacted object, e.g. build
  `const safeEvent = redactor.value(event) as WorkerEvent` once and pass that to both `renderEvent` and the file
  `JSON.stringify`. Add a test asserting both sinks redact an identical secret-bearing payload.

## F4 — MEDIUM — `redactorFor` omits `SWARMFORGE_GIT_PUSH_URL`, so a credential-bearing push URL is not scrubbed from runtime surfaces

- **File/line at target:** `src/security.ts:43-50` (`redactorFor`) — the secret list is `FREESTYLE_API_TOKEN`,
  `SWARMFORGE_MODEL_API_KEY`, `SWARMFORGE_API_TOKEN` and every worker `server_password`. Compare
  `src/serve-command.ts:45-52` (`commandRedactor`), which additionally includes `SWARMFORGE_GIT_PUSH_URL`.
- **Trigger:** `SWARMFORGE_GIT_PUSH_MODE=ssh` with `SWARMFORGE_GIT_PUSH_URL` carrying a credential
  (`ssh://<user>:<pass>@git.example.com/owner/repo.git`, or the `https://<token>@…` form). Accepted by
  `src/config.ts:62` (`z.string().min(1).max(2048).optional()`), with no scheme or userinfo validation.
- **Consequence:** that URL is not in the secret set used by the event log, the `/events` SSE stream
  (`src/http.ts:42-45`), the MCP tool results (`src/mcp.ts:40-42`), the persisted worker result
  (`src/coordinator.ts:707`) or artifact/excerpt screening. Combined with F1, a value echoed in any of those
  surfaces is disclosed in cleartext. The serve command's own startup/shutdown output *is* protected, so the
  guarantee differs by sink.
- **Reproduction (reproduced):** `/tmp/sfrev34/probe/p14.ts` —
  `commandRedactor` scrubs both a `ssh://<user>:<pass>@…` and a `https://<token>@…` push URL;
  `redactorFor` scrubs neither:
  ```
  --- ssh push url with password            commandRedactor scrubs: true   redactorFor scrubs: false
  --- https push url, token-only userinfo   commandRedactor scrubs: true   redactorFor scrubs: false
  ```
- **Why existing guards/tests do not prevent it:** `commandRedactor` was given the push URL explicitly
  (`src/serve-command.ts:50`) but `redactorFor` was not, and no test compares the two secret sets.
  `tests/git-handoff.test.ts` uses credential-free URLs (`git@example:repo.git`).
- **Recommendation:** factor one shared secret-set builder (including `SWARMFORGE_GIT_PUSH_URL`, and optionally the
  GitHub App repository URL) and use it from both `redactorFor` and `commandRedactor`; add a test asserting the two
  sets are equal for the same `Config`.

## Additional code-evidenced observation (not counted as a defect)

- `src/files.ts:94-101`: the artifact credential-screening overlap `pad` is computed only from
  `SWARMFORGE_MODEL_API_KEY.length` and `FREESTYLE_API_TOKEN.length`, while the redactor secret set also contains
  `SWARMFORGE_API_TOKEN`, whose schema (`src/config.ts:81`, `z.string().min(24).optional()`) has **no maximum**.
  A bearer token longer than `2 * pad` can straddle the window edge and a prefix is returned to the MCP client
  (reproduced in `/tmp/sfrev34/probe/p8.ts`: a 12000-byte token yields `contains(window) === false` and 5904 token
  bytes in the returned chunk). Reachability requires an operator to configure a multi-kilobyte API token, so the
  practical likelihood is very low; the cheapest hardening is to cap the token length in the schema or to size `pad`
  from the full redactor secret set. Reported for completeness rather than as a scored finding.

---

## What is correct in this scope (verified, no action)

- The worker environment is an explicit allowlist (`src/config.ts:170-183`) of exactly
  `SWARMFORGE_WORKER_ID`, `SWARMFORGE_TEAM_ID`, `SWARMFORGE_TASK_ID`, `SWARMFORGE_GIT_TREE`,
  `SWARMFORGE_WORKSPACE`, `SWARMFORGE_MODEL_API_KEY`, `OPENCODE_PORT`; `FreestyleProvider.prepare` adds only
  `OPENCODE_SERVER_USERNAME/PASSWORD`, `OPENCODE_CONFIG`, `OPENCODE_DISABLE_AUTOUPDATE`
  (`src/providers/freestyle.ts:150-156`). `FREESTYLE_API_TOKEN` and `SWARMFORGE_API_TOKEN` are never exported
  (asserted by `tests/core.test.ts:59-68`).
- Guest model config uses env indirection rather than a literal key: `apiKey: "{env:SWARMFORGE_MODEL_API_KEY}"`
  (`src/providers/opencode.ts:27`), written to `/opt/swarmforge/opencode.json` with mode 0600
  (`src/providers/freestyle.ts:157-161`); the directory is `chmod 700` in the same `prepare` exec (line 115).
- Temporary Git credentials (`/opt/swarmforge/git-secret`, `git-auth`) are removed on both the success and the
  failure path and a failed removal is a hard error (`src/providers/freestyle.ts:229-240`); the token never appears
  in the exec command line (askpass script / `GIT_SSH_COMMAND`, lines 200-223).
- `start.sh` runs with `set -eu` and no `set -x`; values are single-quote escaped by `quote()` (line 8), so
  credentials are not echoed to journald. The systemd unit has no `User=` escalation concern beyond the intended
  root guest service.
- `Redactor.value` masks credential-shaped **keys** (`src/security.ts:31`), and both the CLI and serve-command
  validate configuration before constructing a provider, opening a database or binding a listener.

## Tests actually run (this scope only; no full suite)

Toolchain: Bun 1.4.2 (`/tmp/bun142/bun-linux-x64/bun`), lockfile untouched.

```
cd /tmp/sfrev34/clone
bun install --frozen-lockfile                                  → exit 0
bun test tests/core.test.ts tests/inspect.test.ts \
        tests/adapters.test.ts tests/excerpt.test.ts \
        tests/git-handoff.test.ts tests/settings.test.ts \
        tests/commands.test.ts tests/serve.test.ts \
        tests/api.test.ts tests/http.test.ts
  → 139 pass, 0 fail, 939 expect() calls, 10 files, exit 0
```

Bounded probes (`/tmp/sfrev34/probe`, all outside the source checkout, all exit 0 unless noted):
`p1`–`p2` settings redaction, `p3` Redactor URL shapes, `p4` event-log event payload, `p5` worker env + bootstrap,
`p6` console-vs-file event sink (F3), `p7`–`p8` artifact screening window, `p9`/`p12` result/excerpt redaction,
`p10` (superseded by `p11`) artifact retrieval, `p11` `get_worker_artifact` with a token-bearing tree URL (F1),
`p13`–`p14` redactor
set comparison (F4). Two real-CLI invocations of `src/cli.ts` (`config show`, `config validate`,
`serve --check-config`) against synthetic dummies. `p1` initially exited 1 due to my own missing-config fixture
(author error, corrected in place; not a product failure).

## Sanitization pass (run before export)

Both `review.md` and `findings.json` were normalized with the production `Redactor.text` from `src/security.ts` at
the target, iterated to a fixed point, with the secret set extended by the repository's own test defaults
(`[REDACTED]`, `[REDACTED]`, the `tests/settings.test.ts` env-file and TOML fixture values) plus every dummy
canary used by the probes. Output was then hand-checked so that no credential literal and no realistic
credential-shaped example remains: URLs appear only as `https://<PAT>@host/...`, `ssh://<user>:<pass>@host/...`
or `https://<token>@…` placeholders, which describe the *shape* the defective pattern fails to match and are not
usable values. Repository-owned fixture URLs referenced from existing tests are quoted by shape only. No secret file
was read at any point.

## Limitations

- No full test suite was run (out of scope for a single reviewer); the 10 in-scope files above are the ones that
  cover this area.
- No compiled binary was produced and no packaging test was run (packaging scope). `scripts/build.ts` /
  `scripts/package.ts` were read only: their `Bun.spawn` calls (`build.ts:112`, `package.ts:116`) inherit the
  operator's environment and do not pass an explicit `env`, so nothing in the packaging path narrows or widens the
  child environment; the compiled binary is built with `autoloadDotenv/autoloadBunfig/autoloadTsconfig/autoloadPackageJson`
  all false (`scripts/build.ts:46-56`), which is the correct control for a foreign working directory.
- Freestyle/OpenCode/model providers were not contacted; the `prepare`/`withGitAuth` guest-file findings are
  code-traced plus a local `git init` check of `remote.origin.url` persistence, not a live VM observation.
- F3 is a sink divergence demonstrated with a synthetic event payload; no current call site writes
  attacker-controlled text into `event.data`, so live reachability is unproven.
- Severity reflects this deployment's documented model (single trusted lead, `SWARMFORGE_API_TOKEN` gating) and a
  guest that is by design a semi-trusted principal. No secret file was inspected; every credential-shaped string in
  this report and in the probes is a synthetic dummy that was removed before export.
- Delivery note: the original review pass exceeded its 30-minute deadline, so this file and `findings.json` were
  finalized during bounded report recovery. **No further investigation, tests, builds or code changes were
  performed during recovery** — only redaction, placeholder substitution, a schema re-validation of the result
  payload and a repository-cleanliness re-check. All findings, severities, line numbers and test counts are unchanged
  from the completed investigation.
