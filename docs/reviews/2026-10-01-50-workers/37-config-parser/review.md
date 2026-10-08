# Reviewer 37 — config parser (TOML schema/version/key validation, env-file parser)

**Verdict: FINDINGS** (1 MEDIUM, 3 LOW). No CRITICAL/HIGH.

- Exact target reviewed: `d428e0f730ed5649485732e95d39c32f5d6a8895` (`feature/binary-config-serve-20260930`)
- Baseline assigned in `/workspace/repo`: `5672ead2a526e07fea9ed11e58b3725e42013527` (left untouched, clean)
- Disposable checkout: `/tmp/rv-cfg` (detached at target, `git rev-parse HEAD` verified)
- Scope: `src/settings/load.ts` (TOML `documentSchema`, `readDocument`, `parseEnvFile`/`envValue`/`expand`/`unescapeDouble`, error codes), `src/settings/paths.ts`, `src/settings/inspect.ts` redaction boundary, `src/config.ts` server schema as the second-stage validator, `docs/CONFIGURATION.md` as the declared contract. Read-only; no source changes.

## Scope read (existing code, not just the delta)

`git diff --stat 5672ead..d428e0f` shows `src/settings/load.ts` (897 lines) is **entirely new** in this branch, so the whole file is delta. Reviewed all of it plus `config.ts`, `paths.ts`, `inspect.ts`, the `CONFIGURATION.md` contract, and `tests/settings.test.ts` / `tests/inspect.test.ts`.

---

## Findings

### F1 — MEDIUM — A `#` comment after a quoted env-file value is rejected as "unterminated quote"; the documented example itself fails

- **File / line:** `src/settings/load.ts:583-589` (`envValue`, quote branch); contract + broken example at `docs/CONFIGURATION.md:153`
- **Trigger:** a declared `env_file` (or `--env-file`) containing a quoted value followed by a trailing comment:
  `export FREESTYLE_API_TOKEN="sample-literal-value"   # trailing comment on an unquoted value`
  Same for single quotes and for `#` with no space after it.
- **Consequence:** `SettingsError{code:"env_file_invalid"}` → `swarmforge serve` refuses to start and `config validate` fails. Fails closed (no wrong value is used), but a documented, copy-pasteable input is rejected, so an operator following `docs/CONFIGURATION.md:153` verbatim gets an immediate, confusing startup failure, and any `.env` migrated from another tool that comments after a quoted value fails the same way.
- **Reproduction (reproduced):** `src/settings/load.ts:586` requires the trimmed value to *end* with the opening quote char, and no code strips a trailing comment after a closing quote, so `entry.endsWith(quote)` is false and `fail("unterminated quote")` fires.
  Probe (`/tmp/probes/p2.ts`, `p5.ts`, fake provider values only):
  ```
  [ERR] 1 doc-example quoted + trailing comment -> [env_file_invalid] Invalid environment file .../a.env at line 1: unterminated quote
  [ERR] 4 single quotes + comment                -> [env_file_invalid] ... unterminated quote
  ```
- **Why existing guards/tests do not prevent it:** `tests/settings.test.ts:676-710` covers quoting/interpolation but its only trailing comment is on an **unquoted** value (line 692); `tests/settings.test.ts:728` covers a genuinely unterminated quote (`'FREESTYLE_API_TOKEN="echoed-secret-value'`). No test puts a comment after a closing quote, so the strictness is unpinned and the doc example is never executed. The same code is also *lenient in the opposite direction*: `KEY="a"b"` is accepted with value `a"b` (probe E1) because the check only looks at the last character — inconsistent handling of text after a quoted value.
- **Recommendation:** scan for the first unescaped closing quote and accept only whitespace and/or a `#` comment after it, failing with a distinct reason otherwise:
  ```ts
  const closing = indexOfClosingQuote(entry, quote);   // honours backslash escapes
  if (closing < 0) fail("unterminated quote");
  const rest = entry.slice(closing + 1);
  if (!/^\s*(#.*)?$/.test(rest)) fail("trailing content after quoted value");
  const body = entry.slice(1, closing);
  ```
  Then fix the example at `docs/CONFIGURATION.md:153` (or leave it as-is once it parses) and add the two cases to `tests/settings.test.ts`.

### F2 — LOW — `\\` before `$NAME` suppresses interpolation inside double quotes

- **File / line:** `src/settings/load.ts:588` (`unescapeDouble(expand(body, …))` — unescape runs *after* expand) and `src/settings/load.ts:601` (the `(?<!\\)` lookbehind)
- **Trigger:** `BASE=sample-value` followed by `SWARMFORGE_METRICS_TEAMS="a\\${BASE}b"` in an env file.
- **Consequence:** the value resolves to the literal `a\${BASE}b` instead of `a\sample-valueb`. A value that composes a credential from another one silently keeps an unexpanded reference; the operator sees no warning and a wrong value reaches the server config.
- **Reproduction (reproduced):** probe `/tmp/probes/p5.ts` E11 → `teams="a\\${BASE}b"`. `docs/CONFIGURATION.md:165` lists `\\` as a recognized escape, so `\\` should mean "literal backslash" *and* still allow the following `${…}` to expand.
- **Why guards/tests do not prevent it:** no test combines an escaped backslash with a following variable; the escaping tests only cover `\n`/`\t`/`\"` and a single `\$`.
- **Recommendation:** resolve escapes and interpolation in a single left-to-right pass so a `\` always consumes the next character before `$` is examined (this also removes the current asymmetry where an unquoted `\$` keeps its backslash at `src/settings/load.ts:592`).

### F3 — LOW — `env_file = ""` is read as the config's own directory instead of "unset"

- **File / line:** `src/settings/load.ts:751-758`
- **Trigger:** `schema_version = 1` + `env_file = ""` in a config file.
- **Consequence:** `anchorPath("")` normalizes to the config directory, `readFile` on a directory yields `EISDIR`, and the operator gets `env_file_invalid: Cannot read environment file /…/conf-dir: EISDIR` — a diagnostic pointing at a directory instead of the missing file. Startup aborts for a value the contract says means "unset".
- **Reproduction (reproduced):** probe `/tmp/probes/p2.ts` case 5. The empty-means-unset rule is applied everywhere else (`setValue` at `src/settings/load.ts:662`) and is documented at `docs/CONFIGURATION.md:51`; `document?.env_file !== undefined` is the one place that skips it.
- **Why guards/tests do not prevent it:** the env-file tests cover a declared path, a missing file and a malformed file, never an empty `env_file`.
- **Recommendation:** `if (document?.env_file !== undefined && document.env_file.trim() !== "")` (or simply `if (document?.env_file)`), matching `setValue`.

### F4 — LOW — No minimum length for the client bearer credential, unlike the server one

- **File / line:** `src/settings/load.ts:83-88` (`clientFields` `client.token`, `kind: "text"`) vs `src/config.ts:81` (`SWARMFORGE_API_TOKEN: z.string().min(24).optional()`)
- **Trigger:** `[client] token = "x"` plus any `client.url`.
- **Consequence:** `resolveClientSettings` returns `token: "x"` and the CLI sends `Authorization: Bearer x`; the same value under `[server] api_token` is rejected with `invalid_config`. `docs/CONFIGURATION.md:180` even warns that one-character credentials occur, which is a consequence of this asymmetry.
- **Reproduction (reproduced):** probe `/tmp/probes/p7.ts` → `client token length accepted: "x"`; `server api_token 'x' rejected: invalid_config … expected string to have >=24 characters`.
- **Why guards/tests do not prevent it:** `resolveClientSettings` deliberately bypasses `loadConfig`, so the server schema's `min(24)` never runs; no client-token test asserts a lower bound.
- **Recommendation:** validate the client token in `resolveClientSettings` with the same documented lower bound (or state explicitly in `docs/CONFIGURATION.md` that the client credential is unvalidated).

---

## Verified sound (non-findings, evidence recorded)

- **TOML strict key/version validation holds.** Rejected with `config_invalid`: unknown top-level key, unknown nested key, unknown subtable, missing `schema_version`, `schema_version = 2`, `schema_version = "1"` (string), duplicate key, duplicate table, TOML syntax error, bare-scalar document, empty/comment-only document, `__proto__` and `constructor` keys (no prototype pollution), wrong value types (float for `int`, `1` for `bool`, TOML datetime / array / inline-table for a string field). Probe `/tmp/probes/p3.ts`, 26 cases.
- **Key-set completeness.** All 40 `Config` keys in `src/config.ts` map 1:1 to config-file paths; `resolveServerSettings` provenance reports exactly those 40 (probe `/tmp/probes/p7.ts`). No setting is unreachable from the config file.
- **No credential leakage in malformed-input diagnostics.** 10 canary probes (`/tmp/probes/p4.ts`) covered: credential at line start followed by a TOML syntax error, credential inside an inline table followed by a syntax error / an unknown-key error / a later invalid value, a multi-line-string credential plus a syntax error, a quoted credential containing ` #` plus a malformed env line, and an inline-table `client.token`/`client.url` with a bad scheme. In every case the canary was absent from `error.message` and `error.path`; `redact(path, secrets)` plus `plain()` in `SettingsError` held. (`collectSecrets` does miss inline-table credentials, but the value is registered by `setValue` before any diagnostic that can echo it.)
- **Interpolation semantics correct:** same-file variables win over the process environment, unknown names are left literal, forward references stay literal, `$(…)`/backticks are inert, unquoted `\s#` starts a comment, `""`/`KEY=` mean unset, CRLF and a UTF-8 BOM in an env file are handled. Probe `/tmp/probes/p5.ts`.
- **No catastrophic backtracking:** a 128 000-space pathological env line resolved in ~1 ms (probe `/tmp/probes/p8.ts`).
- Heavy diagnostic over-redaction seen in probes (single-character fake credentials) is documented and accepted behavior (`docs/CONFIGURATION.md:177-181`), not a defect.

## Tests run

- `bun test tests/settings.test.ts tests/inspect.test.ts` (targeted, in-scope) — Bun 1.4.2 in `/tmp/bun142` (snapshot has 1.3.14, which cannot read this lockfile). **61 pass, 0 fail, 423 expect() calls, exit 0.**
- Reviewer probes: `/tmp/probes/{lib,p1..p8}.ts`, all outside the source checkout, fake providers only (no cloud/model/infrastructure calls, no real credentials, no real network service). `p1.ts` was an invalid first attempt (no `configPath`, so no config file was read) and is superseded by `p2.ts`.
- Full suite, typecheck, lint and packaging were **not** run (out of scope for this reviewer).

## Limitations

- Reviewed only the config/settings surface; `src/serve.ts`, `src/serve-command.ts` runtime use of the resolved values, and lifecycle code were not assessed.
- `tests/commands.test.ts`, `tests/serve.test.ts` and `tests/packaging.test.ts` were skimmed for coverage only, not executed.
- Findings F2–F4 are narrow and low-impact; F1 is the only one an operator is likely to hit in normal use.
- No code was modified: `/workspace/repo` is at the assigned baseline `5672ead` with a clean tree; all edits for this review lived in `/tmp/rv-cfg` and `/tmp/probes`.