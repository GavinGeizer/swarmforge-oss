# SwarmForge OSS Review — task 33-redactor-core (reviewer role)

Sanitization note: this report was written with the production `Redactor` in the loop, then a
second manual pass removed every raw credential-shaped example URL and literal. All such values
are now described in prose only. Verification that a further `Redactor` pass is a no-op is
recorded at the end of this document and in `findings.json`.

- **Exact target reviewed:** `d428e0f730ed5649485732e95d39c32f5d6a8895` (branch `feature/binary-config-serve-20260930`)
- **Assigned workspace (left untouched, clean):** `/workspace/repo` at the bootstrap baseline `5672ead2a526e07fea9ed11e58b3725e42013527`
- **Disposable review checkout:** `/tmp/rv33/repo` (detached HEAD; `git rev-parse HEAD` confirmed the target SHA above)
- **Scope:** `src/security.ts` generic and known-secret redaction — escaping, fragments, short values, URLs, and diagnostic leak paths — plus its direct consumers: `src/settings/inspect.ts`, `src/settings/load.ts`, `src/serve-command.ts`, `src/files.ts`, `src/runtime.ts`, `src/mcp.ts`, `src/http.ts`, `src/cli.ts`, `src/config.ts`.
- **Verdict:** FINDINGS (5 reproduced: 1 HIGH, 2 MEDIUM, 2 LOW)
- Toolchain: official Bun 1.4.2 staged under `/tmp/tool` (the snapshot ships 1.3.14). `bun.lock` was verified byte-identical after a frozen install and was never rewritten.

## Findings

### F1 — HIGH — URL credential scrubbing misses username-only userinfo and every non-http(s) scheme
- **File/line at exact target:** `src/security.ts:18` — the URL userinfo rule of `Redactor.text`.
- **Trigger:** the rule only matches a credential URL when **both** conditions hold: the scheme is
  http or https, **and** the userinfo contains a colon separating a username from a password. Two
  common shapes fail at least one condition and are therefore never touched:
  1. a **username-only URL credential** — a bearer token placed in the username position with an
     empty password, the form used by Git/GitHub personal access token clone remotes;
  2. any **non-http scheme** with a `username:password@host` userinfo — ssh, git+ssh, postgres,
     redis, mongodb+srv, amqp and file were all verified unredacted.
- **Consequence:** the credential is emitted verbatim by every `Redactor.text` consumer, including
  the operator-facing inspection commands and the durable or served diagnostic surfaces:
  `swarmforge config show` and `swarmforge serve --check-config` (both via `redactedSettings`,
  `src/settings/inspect.ts:127,132`), `redactedText` (`src/settings/inspect.ts:97`),
  `redact` (`:145`), the serve command's startup/shutdown diagnostics
  (`src/serve-command.ts:151`), the event log (`src/runtime.ts:196,199`), MCP responses and error
  text (`src/mcp.ts:40,59`), and the `/events` SSE stream (`src/http.ts:45`).
- **Reproduced (end-to-end, shipped CLI):** a config file whose `git.ssh.push_url` carries a
  username-only URL credential is printed byte-for-byte by both `bun src/cli.ts config show` and
  `bun src/cli.ts serve --check-config`, i.e. the reported `SWARMFORGE_GIT_PUSH_URL` value still
  contains the token. The same happens for an ssh URL carrying a username and password. The
  classic http(s) `username:password@host` shape **is** redacted, which confirms this regex is
  the only guard for the other shapes.
- **Why existing guards/tests do not prevent it:** `tests/serve.test.ts:779-806` and
  `tests/inspect.test.ts:97` exercise only the colon-bearing http(s) form. The known-secret value
  pass covers F1 only when the credential happens to be one of the process's own resolved
  secrets: `SWARMFORGE_GIT_PUSH_URL` is added to the secret set only by `commandRedactor`
  (`src/serve-command.ts:47`), and the `redactedSettings` path used by `config show` and
  `--check-config` does not include it (`SECRET_KEYS`, `src/settings/inspect.ts:7-11`). A
  third-party credential echoed back by a provider or SDK error is outside the known-secret set
  by definition, which is exactly the case this generic rule exists to handle (see the stated
  intent at `src/serve-command.ts:36-37`).
- **Recommended correction:** scrub any userinfo regardless of scheme or the presence of a
  password component — for example match an optional scheme followed by userinfo up to the
  separating at-sign, and replace the whole userinfo with the redaction marker. Additionally
  register `SWARMFORGE_GIT_PUSH_URL` in the loader's credential context (or in `SECRET_KEYS`) so
  `redactedSettings` treats the entire value as a credential.
- **Confidence:** high — reproduced twice through the shipped CLI, and the accepted control case
  (`username:password` over http) is redacted in the same run.

### F2 — MEDIUM — Query-parameter credential scrubbing covers only four names
- **File/line at exact target:** `src/security.ts:19-22` — the query-parameter rule of `Redactor.text`.
- **Trigger:** the rule is an exact allowlist of four parameter names (the token name, the
  generic key name, the underscored API-key name, and the password name), and requires the name
  to be preceded by `?` or `&` and followed immediately by `=`. Verified unredacted: the
  `access_token`, `refresh_token` and `id_token` names; the hyphenated and unseparated API-key
  spellings; `secret`, `client_secret`, `bearer`, `auth`, `sig` and the `X-Amz-Signature` header
  parameter. The four allowlisted names are correctly scrubbed.
- **Consequence:** upstream credentials carried in the same diagnostic and report surfaces listed
  in F1. The hyphenated API-key spelling is the Azure/OpenAI convention and `sig` /
  `X-Amz-Signature` are SigV4, all of which are routinely echoed in SDK error text.
- **Reproduced:** a probe over `redactedText(settings, ...)` and `commandRedactor(config).text(...)`
  with thirteen dummy third-party query shapes returned byte-identical (unredacted) output for
  twelve of them; only the allowlisted password name was scrubbed. Log:
  `/workspace/.swarmforge/logs/rv33-probes.log`.
- **Why existing guards/tests do not prevent it:** `tests/serve.test.ts:803` asserts only the two
  allowlisted names that the implementation already lists, so the test mirrors the bug.
- **Recommended correction:** match credential-ish parameter *names* by substring rather than by
  exact allowlist — e.g. any parameter whose name contains a token, key, secret, password, auth
  or signature stem — so hyphenated, prefixed and suffixed spellings are covered.
- **Confidence:** high — reproduced.

### F3 — MEDIUM — The known-secret base64 variant matches only at 3-byte-aligned offsets and misses the URL-safe alphabet
- **File/line at exact target:** `src/security.ts:10-15`, specifically line 13 — the variant set
  built in `Redactor.text` is the raw secret, its percent-encoding, and its standard base64 encoding.
- **Trigger:** a standard base64 encoding is a stream of 3-byte groups, so the encoded form of a
  secret appears as a literal substring of a larger base64 payload **only when the secret starts
  at a byte offset that is a multiple of three**. Two consequences follow:
  1. any base64 blob that embeds the secret after a non-aligned prefix is not scrubbed — concretely
     an HTTP Basic credential whose username prefix length is not a multiple of three;
  2. the URL-safe base64 alphabet is never generated, so when the standard encoding of a secret
     contains the non-URL-safe characters, its URL-safe form is not recognised.
- **Consequence:** a complete, trivially decodable copy of a live credential survives redaction on
  every diagnostic surface: the event-log line (`src/runtime.ts:199`), MCP error text
  (`src/mcp.ts:59`), the SSE stream (`src/http.ts:45`), `config show` and `--check-config` values,
  and the artifact log tail (`src/files.ts:135`).
- **Reproduced:**
  - Alignment sweep with a 24-character dummy token: prefix lengths 0 and 3 (aligned) were
    redacted; prefix lengths 1, 2, 4 and 5 were returned unchanged and base64-decoded straight back
    to the full token. An HTTP Basic credential built from a short username prefix plus the token
    was returned unchanged.
  - URL-safe alphabet: a dummy token whose standard base64 contains the non-URL-safe characters
    was redacted in standard base64 but **not** in the URL-safe form.
  - Note on the codebase's own use: the only Basic prefix the code itself constructs is the
    OpenCode username at `src/providers/opencode.ts:66`, which is nine bytes and therefore
    aligned — the built-in path is safe by coincidence of that prefix length, not by construction.
- **Why existing guards/tests do not prevent it:** `tests/serve.test.ts:731-736` asserts only the
  standalone base64 string of a token, i.e. offset zero with no padding conflict. No test embeds a
  secret in a prefixed base64 payload, and none exercises the URL-safe alphabet.
- **Recommended correction:** add the URL-safe base64 form, and for each of the three possible
  byte offsets add the corresponding partial encodings derived from base64 of the secret preceded
  by one and by two filler bytes with the leading groups stripped. Consider the hex form too.
- **Confidence:** high — reproduced.

### F4 — LOW — `excerptText` normalizes after redacting, so a whitespace-bearing credential is reconstructed verbatim
- **File/line at exact target:** `src/security.ts:96-110` — redaction is applied at line 97, and
  the whitespace/invisible-character rewriting plus the run collapse at line 110 run afterwards.
- **Trigger:** a credential that itself contains a space, echoed by untrusted model output with a
  different whitespace separator (newline, tab, or any of the Unicode space code points the helper
  treats as space). `src/config.ts:28` and `:47` accept any non-empty credential, so a credential
  containing a space is valid configuration.
- **Consequence:** the unredacted credential is emitted in the excerpt served by the focused-worker
  view (`publicWorker`, `src/security.ts:152`) and rendered by the CLI overview.
- **Reproduced:** with a dummy multi-word token, an excerpt input in which the words were separated
  by newlines was returned as a single line containing the exact token, unredacted.
- **Why existing guards/tests do not prevent it:** the ordering is deliberate — the comment at
  `src/security.ts:95` states the intent is to redact before trimming so a secret split by
  truncation is never partially revealed — and `tests/excerpt.test.ts:91-112` only covers a token
  that appears verbatim. Partially mitigating: the excerpt is redacted a second time by
  `redactor.value` at the MCP boundary (`src/mcp.ts:40`), so the served surface is protected; the
  unredacted value still lives in process memory and is what the excerpt consumers render.
- **Recommended correction:** redact again after normalization, or normalize first and redact both
  the raw and the normalized form.
- **Confidence:** high for the mechanism; medium for practical impact, since it requires a
  whitespace-bearing credential.

### F5 — LOW — A one-to-three character credential defeats the generic query scrub and disables artifact retrieval
- **File/line at exact target:** `src/security.ts:7-22` — the known-secret substring pass at lines
  7-16 runs before the generic URL and query rules at lines 18-22, so a short credential can rewrite
  a parameter name before the generic rule gets a chance to match it. Schema-wise the credential
  settings are `z.string().min(1)` at `src/config.ts:28` and `src/config.ts:47`, so a
  one-character credential is valid configuration. Consumed by the artifact guards at
  `src/files.ts:70` and `src/files.ts:103`.
- **Trigger:** an operator configures a one- to three-character `FREESTYLE_API_TOKEN` or
  `SWARMFORGE_MODEL_API_KEY`.
- **Consequence, two distinct effects:**
  1. *Confidentiality:* the known-secret pass substitutes inside the credential **parameter name**
     before the generic rule runs, so the parameter value survives. With a one-character dummy
     secret an upstream API-key parameter's value was left fully visible, whereas the same input
     with a normal-length secret set was correctly redacted.
  2. *Availability:* `Redactor.contains()` then reports that ordinary artifacts contain
     credentials (any file with a decimal point or an import path), and the artifact path guard
     rejects essentially every path that includes a file extension, surfacing a misleading
     "artifact contains credentials" message asking the operator to edit the file inside the worker.
- **Why existing guards/tests do not prevent it:** `src/settings/inspect.ts:57-60,141-143`
  explicitly accepts over-redaction "at the cost of a diagnostic that over-redacts ordinary text",
  but that rationale covers diagnostic readability only. It does not cover the artifact gate,
  where the same behaviour turns a schema-valid configuration into a total artifact-read outage.
  No test configures a short credential.
- **Recommended correction:** require a sane minimum length for credential settings, or skip
  substring replacement below a length threshold in the `contains()` and path-guard contexts, and
  apply the generic URL and query rules independently of known-secret replacement.
- **Confidence:** high for the behaviour; medium for likelihood, since it requires operator
  misconfiguration.

## Non-findings and notes (examined, no actionable defect)

- `redactorFor` (`src/security.ts:43-50`) together with `SECRET_KEYS`
  (`src/settings/inspect.ts:7-11`) covers every credential value the loader resolves;
  `redactedSettings` marks those values wholesale and additionally scans every reported value,
  source label and config path. No missing credential key was found at the target.
- Redaction-before-slicing ordering is correct at every call site checked: the artifact log tail
  (`src/files.ts:135`) and the MCP error text (`src/mcp.ts:59-62`) both redact first, then bound.
- The artifact read overlap padding (`src/files.ts:88-95`) covers both primary tokens and all
  72-character worker server passwords. A residual edge exists only for a credential longer than
  4096 bytes (the schema sets no upper bound), where the roughly 1.33x longer base64 form could
  straddle the window; not reported separately, as impact is low and it is unverified in practice.
- `renderEvent(event, safe)` (`src/runtime.ts:196` reaching `src/runtime.ts:89-93`) prints
  `event.data` to stdout **unredacted**, while the persisted JSON line at
  `src/runtime.ts:198-200` is redacted. Not reported as a finding: all four `store.event` call
  sites (`src/store.ts:127,166,287` and `src/coordinator.ts:872`) pass either an empty payload or
  a run id and status, so no secret-bearing payload exists at the target. Latent only.
- Short secrets also produce benign false positives, such as the base64 of a one-character secret
  matching unrelated text. Same root cause as F5; not reported separately.

## Tests, probes and limitations

Tests actually executed, with honest counts (Bun 1.4.2, staged under `/tmp/tool`):

- `bun install --frozen-lockfile` — exit 0, 125 packages, `bun.lock` verified byte-identical.
- `bun test tests/excerpt.test.ts tests/api.test.ts` — exit 0, **15 pass, 0 fail**, 73 expect calls.
- `bun test tests/serve.test.ts tests/inspect.test.ts tests/settings.test.ts` — exit 0, **81 pass,
  0 fail**, 534 expect calls.
- Seven standalone probe scripts plus one end-to-end CLI reproduction under `/tmp/rv33/probes`
  (outside the source checkout) — all executed; the alignment sweep, the query-parameter sweep,
  the scheme sweep, the short-credential behaviour and the two CLI reproductions all ran as
  reported. Log: `/workspace/.swarmforge/logs/rv33-probes.log`.

Limitations, stated plainly:

- The full test suite was deliberately **not** run — that is the whole-suite reviewer's scope — and
  no packaging or compile step was run.
- Three probe scripts were rewritten after two initial authoring mistakes of my own (a wrong
  method call and an invalid test config); those were errors in my probe code, not product
  defects, and the corrected probes reproduced the findings as reported.
- Reviewer experiments live only under `/tmp/rv33/**` (disposable detached clone and probes) and
  `/tmp/tool` (Bun 1.4.2). No cloud or model provider and no real infrastructure was contacted;
  all providers were local fakes or pure-string probes. `/workspace/repo` was fetched only,
  never modified, and is clean at the assigned baseline.
- F1, F2 and F3 depend on a credential shape outside the process's known-secret set; likelihood
  beyond the reproduced trigger was not assessed. F4 requires a whitespace-bearing credential and
  F5 requires a one-to-three character credential, both legal under `src/config.ts` at the target.
- No secret file was inspected. Every example value used during review was synthetic; this
  document and `findings.json` contain no raw credential-shaped URL or literal, only prose
  descriptions.

## Sanitization verification

After the manual prose pass, both artifacts were re-processed with the production `Redactor`
(the same class used by the application, at the exact target) using the synthetic tokens from the
review probes and the fake infrastructure/model defaults from `tests/helpers.ts`, plus the
generic URL-userinfo and query-parameter fallbacks. The pass produced **no change** to either
file, and a final scan confirms no raw credential-shaped URL, query string or literal remains.
