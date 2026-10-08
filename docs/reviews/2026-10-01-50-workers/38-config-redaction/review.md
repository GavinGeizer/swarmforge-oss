# SwarmForge review — scope: WeakMap credential context, overwritten credentials, cross-client/server inspection, error provenance/path redaction

- Exact target: `d428e0f730ed5649485732e95d39c32f5d6a8895` (branch `feature/binary-config-serve-20260930`)
- Verified with `git rev-parse HEAD` in a disposable detached clone at `/tmp/rev38/t`
- Assigned checkout `/workspace/repo` left at its baseline (`5672ead`) and clean
- Verdict: **FINDINGS** (2 reproduced, 1 code-evidenced)
- No source changes made (`files_changed: []`)
- Sanitization: this document and `findings.json` were passed through the target's production
  `Redactor.text` to a fixed point. Every example is described in prose only: no URL carrying
  userinfo, no query string carrying a credential, and no literal secret value appears anywhere.
  All reproduction steps refer to placeholder values, never real credentials.

Reviewer experiments (all outside the source checkout, disclosed):
`/tmp/rev38/t` (detached clone at target), `/tmp/rev38/probe/p1.ts`, `p2.ts`, `p3.ts` (also archived
in `/workspace/.swarmforge/logs`), `/tmp/rev38/cfg/s.toml` (throwaway config holding made-up
credential-shaped placeholders), `/tmp/rev38/bun` (official Bun 1.4.2, unpacked in /tmp; the
snapshot's 1.3.14 cannot read this lockfileVersion 2 — the lockfile was never rewritten).

## Surfaces read

`src/settings/inspect.ts` (147 L), `src/settings/load.ts` (897 L), `src/cli.ts` (323 L),
`src/cli/client.ts`, `src/cli/arguments.ts`, `src/serve-command.ts`, `src/security.ts`,
`src/config.ts`, `src/runtime.ts` (event log redaction), `src/git-handoff.ts`,
`src/providers/freestyle.ts` (git auth/push), `docs/CONFIGURATION.md`, `docs/SERVE.md`,
`docs/ENVIRONMENT.md`, `tests/inspect.test.ts`, plus grep-level coverage checks in
`tests/settings.test.ts`, `tests/commands.test.ts`, `tests/serve.test.ts`.

## Findings

### F1 — MEDIUM — Credential-shaped URLs are only scrubbed in two narrow shapes, so `config show` / `config validate` / `serve --check-config` can print a live credential verbatim

- File/line (target): `src/security.ts:17-22` (the two fallback regular expressions in
  `Redactor.text`), surfaced by `src/settings/inspect.ts:117,127,132` and printed by
  `src/cli.ts:198,265,278`
- Trigger: an operator puts a credential in a setting whose key is **not** one of the three
  `SECRET_KEYS` (`FREESTYLE_API_TOKEN`, `SWARMFORGE_MODEL_API_KEY`, `SWARMFORGE_API_TOKEN`).
  Two schema-legal, realistic instances: `git.ssh.push_url` for the `ssh` push mode
  (`src/config.ts:62,131`) and `client.url` (the `--url` flag / `SWARMFORGE_URL`).
- Why it leaks: the loader only ever learns credential *values* from two sources —
  (a) the credential-named settings keys (`src/settings/load.ts:459-473`), and
  (b) `collectSecrets`, which requires the assignment key to match
  `/token|key|secret|password|credential/i` (`src/settings/load.ts:442-453`). Neither
  `push_url` nor `url` matches either source, so a credential embedded inside those values is
  never learned. What remains is the shape-based fallback in `Redactor.text`, which covers
  exactly two shapes: URL userinfo that includes a password component, and query parameters
  named token, key, api-key-style, or password. Two shapes are missing: userinfo that carries
  only a username (the common pattern of placing a token in the username position of a remote
  URL), and any other query parameter name — for example a generic signature, an
  access-token-style name, or a header-style api-key name — including namespaced variants such
  as a prefixed access-token parameter. In all of those cases the value survives verbatim.
- Reproduction (reproduced, exit code 0, no network, placeholder values only):
  - probe `p2.ts` — `Redactor.text` with an empty secret set over eight inputs: the
    userinfo-with-password form was redacted; the username-only userinfo form was returned
    unchanged; the four recognised query names were redacted; the access-token-style,
    header-style api-key and signature query names were returned unchanged.
  - real CLI, `swarmforge config show --config <throwaway>/s.toml` (exit 0): the reported
    client `url` value was printed in full, including its username-only userinfo and its
    access-token-style query value, and the reported `client.secrets` list was empty.
  - real CLI, `swarmforge config validate --config <throwaway>/s.toml` (exit 0): the reported
    `SWARMFORGE_GIT_PUSH_URL` value was printed in full, with its username-only userinfo intact;
    the reported `secrets` list named only the two environment-sourced credentials.
- Consequence: `swarmforge config validate` / `config show` / `serve --check-config` output is
  documented as safe to paste into a ticket (`src/cli.ts:276-277`,
  `docs/CONFIGURATION.md:173-195`). A real push credential or endpoint credential therefore
  reaches a terminal, a CI log, or a ticket in cleartext — and because the loader never learned
  the value, every later redacted render of the same setting leaks it again. The same gap
  applies to the endpoint that `swarmforge status --url` reports (`src/cli.ts:160`).
- Why existing guards/tests do not prevent it: the shape fallbacks are exercised only with the
  userinfo-plus-password form and with the recognised query names
  (`tests/api.test.ts:148-153`, `tests/serve.test.ts:728,792-803`). No test uses userinfo
  without a password, or any other query name. `tests/inspect.test.ts` proves only that
  *known* credential values are removed, which is a different property.
  The serve logger takes the opposite position: `commandRedactor` deliberately treats
  `SWARMFORGE_GIT_PUSH_URL` as a secret (`src/serve-command.ts:50`), which shows the value is
  known to be credential-bearing — the inspection path simply is not.
- Recommendation: (1) when resolving a value, extract URL userinfo and
  credential-looking query values and add them to `collector.secrets`, so the existing
  value-based redaction covers them on every surface; and (2) broaden the two fallbacks in
  `Redactor.text` to username-only userinfo and to any query key matching
  `/token|key|secret|pass|auth|sig|credential/i`. Both keep the documented over-redaction
  tradeoff.
- Confidence: high (reproduced end to end through the real CLI at target).

### F2 — LOW — `plain()` keeps bidi overrides and zero-width characters, so a hostile endpoint can spoof `swarmforge status` output

- File/line (target): `src/settings/inspect.ts:41-48`
- Trigger: the remote MCP endpoint returns tool-error text (or a `status` payload string)
  containing U+202E/U+202C or U+200B. That text is raised as an `Error`
  (`src/cli/client.ts:45`) and printed through `scrub` → `redactedText` → `plain`
  (`src/cli.ts:121-132,184-186`).
- Reproduction (reproduced): `redactedText` on a client result, given a message containing a
  right-to-left override, its terminator and a zero-width space, returned the string with all
  three code points intact; only C0 and C1 are stripped. The same helper covers
  `config show`/`config validate` values via `src/cli.ts:265,278`.
- Consequence: terminal display spoofing in the CLI — an attacker-chosen string can visually
  reverse or hide part of a diagnostic. No credential is exposed; impact is limited to
  operator deception.
- Why existing guards/tests do not prevent it: the doc comment claims only "one printable
  line" / "cannot carry a terminal escape sequence", which holds. The same repository already
  treats these code points as dangerous for untrusted text: `isInvisible` in
  `src/security.ts:63-70` strips C0/C1, bidi, zero-width and BOM for model output in
  `excerptText`; `plain` does not. `tests/inspect.test.ts:99-101` only tests ESC/BEL/C1.
- Recommendation: reuse the same invisible-code-point filter in `plain()` — it is applied to
  already-redacted strings, so widening it cannot affect redaction — or export the predicate
  from `security.ts` and share it.
- Confidence: high for the behaviour; low for practical impact (requires a hostile or
  compromised endpoint).

### F3 — LOW (code-evidenced, no concrete trigger found) — The long-running server rebuilds a weaker secret set than the CLI, so the loader's all-layer credential context is dropped at the `serve` boundary

- File/line (target): `src/cli.ts:194,205` (`resolveServerSettings(...)` → `runServe(settings.value)`,
  discarding the `ResolvedSettings` object that carries the WeakMap context),
  `src/serve-command.ts:45-52` (`commandRedactor`), `src/security.ts:43-51` (`redactorFor`)
- Evidence: `commandRedactor` builds its secret list from four resolved fields
  (`FREESTYLE_API_TOKEN`, `SWARMFORGE_MODEL_API_KEY`, `SWARMFORGE_API_TOKEN`,
  `SWARMFORGE_GIT_PUSH_URL`); `redactorFor` adds worker passwords. Neither can reach
  `credentialContexts` (`src/settings/inspect.ts:14-22`), i.e. neither knows credentials from
  *superseded* layers or from any setting whose key is not credential-named. A credential the
  loader knew about can therefore still reach a serve log line, the event-log file
  (`src/runtime.ts:172-212`) or an SSE/MCP payload.
- Reachability: not demonstrated. Every startup error path I traced
  (`src/providers/freestyle.ts:186-267`, `src/git-handoff.ts`) raises fixed messages that echo
  neither the remote URL nor a token, and a superseded value is by construction not held by the
  serve process, so nothing can echo it. This is a defence-in-depth gap and an internal
  inconsistency with the documented guarantee (`docs/CONFIGURATION.md:180-195`), not a proven leak.
- Recommendation: pass the recorded credential context into the serve process (or have
  `commandRedactor`/`redactorFor` accept it) so all three surfaces redact the same set; at
  minimum add `SWARMFORGE_GIT_PUSH_URL` to `redactorFor` so the server matches the serve logger.
- Confidence: low (design gap; exploitability unverified).

## Investigated and cleared

- `isServer` (`src/settings/inspect.ts:35`) keys the surface off whether the value carries the
  server host key. A cross-surface confusion would be a real leak — the server branch would
  print the client `token` value in cleartext, because `SECRET_KEYS` has no `token` entry — but
  it is **not reachable**: the server surface always resolves that host key (schema default,
  `src/config.ts:78`) and the client surface is built as exactly the url/token pair
  (`src/settings/load.ts:891`). Only a future surface matching neither shape would hit it; a
  surface tag on `ResolvedSettings` would be more robust than a structural probe.
- WeakMap identity loss by cloning: no caller spreads or copies a `ResolvedSettings`
  (grep over `src/` and the settings tests); `redactedSettings`/`redactedText` always receive the
  object the resolver registered.
- Dotted TOML keys (a credential assigned under its fully-qualified dotted name in one line) are
  missed by `collectSecrets` (`src/settings/load.ts:442-453`), but `Bun.TOML.parse` errors do not
  echo source lines (probed: only a generic parse-error string) and zod `strictObject` issues
  report key names, not values — so no leak path was found.
- Overwritten/superseded credentials on the CLI paths: correct. `setValue`
  (`src/settings/load.ts:656-667`) adds every written credential value, so superseded values stay
  in the context; `tests/inspect.test.ts:38-78` pins this.
- `SettingsError` `path`/`message` are redacted before construction in every `load.ts` throw
  (`:485-497`, `:506-525`, `:637-648`, `:849`, `:883`); the raw env-file path reaches provenance
  only and is scrubbed at render (`src/settings/inspect.ts:128`).

## Tests and limitations

Commands (official Bun 1.4.2 from `/tmp/rev38/bun`, run in `/tmp/rev38/t`):

- `bun test tests/inspect.test.ts tests/settings.test.ts` → 61 pass, 0 fail, 423 expects (exit 0)
- `bun test tests/commands.test.ts -t config` → 6 pass, 9 filtered, 0 fail, 79 expects (exit 0)
- probes `p1.ts`, `p2.ts`, `p3.ts` (outside the checkout) → exit 0; CLI invocations for
  `config show` / `config validate` → exit 0

Limitations: I did not run the whole suite (reserved for the whole-suite reviewer) and did not
compile/package (reserved for packaging scopes). F1 and F2 were reproduced locally with fake
credential-shaped placeholders and no network, real provider, or real credential; every literal
example has been replaced by prose in this sanitized export. F3 is code-evidenced only. F1's
practical weight depends on operators putting a credential in `git.ssh.push_url` or `client.url`,
for which the docs show only SSH / no-credential forms — the value is schema-legal and the serve
logger already treats it as secret, so I rated it MEDIUM rather than HIGH. I did not review the
VM-side worker environment, the Freestyle/OpenCode adapters beyond their error text, or the
packaging changes.