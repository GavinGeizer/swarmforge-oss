# SwarmForge review 24 — credential screening, sanitizer, binary chunking

- **Target (exact)**: `d428e0f730ed5649485732e95d39c32f5d6a8895`
- **Branch**: `feature/binary-config-serve-20260930` (https://github.com/GavinGeizer/swarmforge-oss.git)
- **Baseline (assigned branch, NOT target)**: `5672ead2a526e07fea9ed11e58b3725e42013527`
- **Verdict**: FINDINGS (1 MEDIUM, reproduced)
- **Method**: disposable detached `git worktree` at `/tmp/rev-24`, `git rev-parse HEAD` verified = target. `/workspace/repo` left untouched at the assigned baseline and clean. Bun 1.4.2 (official zip) unpacked at `/tmp/bun142`; the snapshot's Bun 1.3.14 cannot read lockfileVersion 2. Lockfile never rewritten (`bun install --frozen-lockfile`, exit 0).

## Scope reviewed

Credential screening and sanitizer behavior, binary chunking, false negatives, multi-chunk leakage, false positives:

- `src/security.ts` — `Redactor.text`/`value`/`contains`, `redactorFor`, `excerptText` (terminal-invisible / ANSI / BOM scrubbing).
- `src/files.ts` — artifact chunking, the overlap "pad" credential screen, `logs()`.
- `src/mcp.ts` — `get_worker_artifact` resource link, `worker-artifact` resource template, tool-result redaction.
- `src/settings/inspect.ts` — `redactedSettings`, `redactedText`, `redact`, `plain`, redaction-context retention.
- `src/settings/load.ts` — `collectSecrets`, per-layer credential accumulation, diagnostic scrubbing.
- `src/serve-command.ts` — `commandRedactor` (escaped/JSON variants, Git push URL).
- `src/coordinator.ts` (result/excerpt/fallback), `src/http.ts` (SSE), `src/runtime.ts` (event log), `src/config.ts` (schema bounds on secret values).

## Findings

### 1. MEDIUM — Artifact chunk screen can be defeated by a credential longer than the overlap pad, leaking credential bytes to the caller

**File / line (exact target)**: `src/files.ts:94-98` (pad derivation), `src/files.ts:99-107` (window, screen, returned slice). Root cause context: `src/security.ts:43-50` (`redactorFor` secret set, four sources), `src/config.ts:81` (`SWARMFORGE_API_TOKEN: z.string().min(24).optional()` — no maximum).

**Code trace.** `WorkerFiles.readArtifact` builds an overlap window so a credential split across a chunk boundary is still blocked:

```
src/files.ts:93   // Inspect an overlap so credentials split across chunk boundaries still block retrieval.
src/files.ts:94   const pad = Math.max(
src/files.ts:95     4096,
src/files.ts:96     this.c.config.SWARMFORGE_MODEL_API_KEY.length,
src/files.ts:97     this.c.config.FREESTYLE_API_TOKEN.length,
src/files.ts:98   );
src/files.ts:99   const start = Math.max(0, offset - pad);
src/files.ts:100  const bytes = await ...readFile(vm, full, start, length + 2 * pad);
src/files.ts:103  if (redactorFor(this.c).contains(bytes)) throw new Error("Artifact contains credentials ...");
src/files.ts:107  return bytes.slice(offset - start, offset - start + length);
```

The screen at line 103 is an **exact whole-secret substring match** over the decoded window (`Redactor.contains`, `src/security.ts:38-41`). That is only sound if the window extends at least one full secret length past each edge of the returned range. `pad` is derived from only **two of the four** secret sources in `redactorFor` (`src/security.ts:44-49`): it folds in `SWARMFORGE_MODEL_API_KEY` and `FREESTYLE_API_TOKEN` but **omits `SWARMFORGE_API_TOKEN` and the per-worker `server_password`s**. `SWARMFORGE_API_TOKEN` is the only omitted source with no schema length ceiling.

Consequence: for a `SWARMFORGE_API_TOKEN` longer than `pad`, a read whose `offset > pad` truncates the credential at the window's **left** edge, the exact match fails, no exception is thrown, and `readArtifact` returns the portion of the credential that lies inside the caller's requested range. Disclosure is `secretLength - (offset - start) - 1` bytes, i.e. up to `secretLength - 4097` contiguous credential bytes — it grows with the token, so a large token discloses proportionally more.

The **right** edge is sound: the window extends `pad` past the end of the returned range, so a credential cut at the right edge is entirely outside the returned bytes.

**Concrete trigger** (reproduced). A worker writes a `>=32 KiB` artifact containing the configured `SWARMFORGE_API_TOKEN`, which the lead reads with the documented `next_offset` walk. First chunk at `offset=0` starts at file byte 0 and is refused. The next chunk, `offset=32768`, starts its window at `28672`; a credential beginning at or before `28672` is cut and 904 bytes of it are returned.

Reproduction (probe outside the source checkout, `/tmp/probe/probe.ts`, run with Bun 1.4.2 against `/tmp/rev-24`): a fake `WorkerProvider` with a byte-range `readFile` and a real `Coordinator`/`Store`/`WorkerFiles`, `SWARMFORGE_API_TOKEN` set to a synthetic 5000-character placeholder (schema-legal: `min(24)`, no max; the two tokens folded into `pad` left short), artifact = 60000 bytes with the token at absolute bytes `[0,5000)`, request `readArtifact(id, "blob.bin", 4196, 32768)`. Observed: `pad=4096`, provider window `start=100 len=40960` (token truncated to its last 4900 bytes), **no exception**, and 804 contiguous credential bytes returned whose leading characters match the token prefix.

Controls that passed in the same run, isolating the defect to the left edge:
- same request, short configured secret placed inside the chunk -> refused (guard works for secrets <= `pad`);
- same request, the 5000-character token placed at absolute byte 5000 (well inside the window) -> refused (long tokens are caught when not truncated);
- same request, the 5000-character token straddling the **right** window edge -> refused (right edge sound);
- junk high bytes (`0xc3 0x28 0xe0 0x80 0x80 0xfe 0xff`) immediately before an ASCII secret -> still detected (rules out `Buffer.toString("utf8")` invalid-sequence consumption as an alternative cause).

**Why existing guards/tests do not prevent it.** The overlap idea is right but is derived from a hand-maintained subset of the secret set rather than from `redactorFor(c).secrets()`, so adding a secret source silently desynchronizes the pad. `tests/api.test.ts:104-127` is the only artifact-screen test: it uses `offset = 0` (where `start` clamps to 0 and no left truncation is possible) and 12-byte secrets, so it cannot observe the boundary. The tool schema (`src/mcp.ts:186-191`) permits any `offset >= 0`, and the 32 KiB default length guarantees that reading any artifact larger than one chunk reaches `offset > 4096`. Nothing asserts that every source in `redactorFor` is represented in `pad`, and no test reads a second chunk.

**Secondary note (same root cause, not separately scored)**: because the screen is an exact match on a UTF-8 decode, a credential whose final character is multi-byte and which is cut at either window edge is missed even when short. Verified at the `Redactor.contains` level (a 10-byte non-ASCII secret truncated by one byte is not detected). Not an independent leak on its own — the right-edge cut is outside the returned range — but it is the same "window must hold one full secret" invariant.

**Recommended correction.** Derive the overlap from the live secret set instead of two config fields, so the screen and the secret set cannot drift:

```ts
// src/files.ts, inside readArtifact
const secrets = redactorFor(this.c).secrets().filter(Boolean);
const pad = Math.max(4096, ...secrets.map((s) => Buffer.byteLength(s)));
```

Use `Buffer.byteLength` rather than `String.length` so the pad is in bytes, matching the byte offsets used by `readFile` and `contains`. Consider also screening in latin1 (byte-preserving) or searching the raw bytes so no decode step can drop a partial match. Add a regression test that reads a second/third chunk of an artifact holding a `SWARMFORGE_API_TOKEN` longer than the pad with the credential straddling `offset - pad`.

**Reachability / confidence**: reproduced end-to-end through the real `readArtifact` (high confidence on mechanism). Real-world likelihood is bounded by needing a `SWARMFORGE_API_TOKEN` above 4096 bytes — documented as "minimum 24 characters" with no documented maximum, so schema-legal but atypical. `server_password` is a fixed 72 characters (`src/store.ts:96`, two `randomUUID()`s) and is therefore always under the 4096 floor; that omission is latent, not exploitable. Severity held at MEDIUM for that reason.

## Verified as sound (no defect, recorded so they are not re-reviewed)

- **Return range is always inside the screened window.** For `offset < pad`, `start = 0` and the window is `[0, length+2*pad)`; otherwise `[offset-pad, offset+length+pad)`. The returned slice `[offset, offset+length)` is a subset in both cases, so screening cannot be skipped for offsets/lengths other than the length-dependent case above.
- **Right-edge straddling is caught** (A2c) — the overlap extends `pad` past the chunk end.
- **UTF-8 decode does not mask ASCII secrets.** Node's decoder emits U+FFFD for an invalid lead byte without consuming the following valid byte, so binary garbage adjacent to a secret does not hide it (D1).
- **No false positives on binary.** `Redactor.contains` returned `false` for PNG-like pseudo-random bytes, zlib magic, and 256 NUL bytes. The URL-userinfo rule `/(https?:\/\/)[^\s\/@]+:[^\s\/@]+@/g` cannot match across a `/`, so a URL embedded in binary is not spuriously flagged. The embedded-URL sample also returned `false`.
- **`get_worker_artifact` is not wrapped in `redactor.value`**, but is safe: `WorkerFiles.artifact` rejects a credential-bearing path at `src/files.ts:70-71` before the `uri`/`name` (which embed the path) are built, and the handler's `catch` returns a fixed generic string. `worker_id` is `idSchema`-constrained; `offset`/`length` are integers.
- **Directory listings expose file names unscreened** by `artifacts()`, but every read passes through `redactor.value` in the `register` wrapper (`src/mcp.ts:40`), and the path itself is screened in `artifact()`.
- **`logs()`**: redaction is applied to the full provider stdout *before* `.slice(-16384)` (`src/files.ts:135`), so slicing can only drop a redaction marker's prefix, never reveal a secret.
- **No direct artifact byte path bypasses `readArtifact`.** The only other `provider.readFile` call is the `result.json` fallback (`src/coordinator.ts:675-687`, 65537 bytes), and both of its callers route through `complete()`, which applies `redactorFor(this).value(r)` before `store.finish` and before the mirror write — so a credential in `result.json` is not persisted nor returned.
- **`w.error`** is stored unredacted in SQLite but every read surface applies `redactor.value` (`src/mcp.ts:40`, `src/http.ts:45`, `src/runtime.ts:185`/`:198`). Consistent store-raw/redact-on-read design, not a leak.
- **Settings loader retains complete credential context.** `collector.secrets` accumulates from environment and overrides (`seedCredentials`, `src/settings/load.ts:468-473`), from every file read (`collectSecrets`, `:499`, `:650`) and from every resolved layer including superseded ones (`setValue`, `:665-666`), and is handed to `withRedactionContext` (`:852-859`, `:889-896`). `redactedSettings` then scrubs values, sources, and `config_path` (`src/settings/inspect.ts:111-138`). Credential key sets match `SECRET_KEYS` + client `token`, which is exactly the credential surface of `config.ts` and `clientFields`.
- **`commandRedactor`** adds the JSON-escaped form of each secret and the Git push URL (`src/serve-command.ts:38-53`) so a secret containing a character JSON escapes is also scrubbed, and redacts payloads before serialization (`:67-68`).
- **`excerptText`** redacts before any trimming/collapsing (`src/security.ts:96-97`), takes the **tail** of the redacted text, and strips ANSI CSI/OSC via `escapeLength` plus C0/C1/bidi/zero-width/BOM via `isInvisible` (`:51-109`). Truncation cannot re-expose a secret because redaction already happened.

## Tests and probes actually run

Toolchain: official Bun 1.4.2 at `/tmp/bun142/bun-linux-x64/bun` (snapshot Bun is 1.3.14). `bun install --frozen-lockfile` in the disposable checkout, exit 0, `bun.lock` unmodified.

| Command (in `/tmp/rev-24`) | Exit | Result |
| --- | --- | --- |
| `bun test tests/api.test.ts tests/excerpt.test.ts tests/inspect.test.ts` | 0 | 20 pass, 0 fail, 92 expect() calls |
| `bun test tests/commands.test.ts tests/settings.test.ts` | 0 | 71 pass, 0 fail, 627 expect() calls |
| `bun run /tmp/probe/probe.ts` | 1 | 1 failure (probe A1 = the reproduced MEDIUM leak); 8 controls passed |

Probe A1 failing is the intended, honest signal that the finding reproduces; the probe's own `process.exit(1)` reflects that. No real cloud/model provider, no VM, no network service and no real credential was used: all providers are local fakes and all secrets are synthetic placeholders. Logs: `/workspace/.swarmforge/logs/rev24-scope-tests-a.log`, `/workspace/.swarmforge/logs/rev24-scope-tests-b.log`.

## Limitations

- Full suite **not** run (whole-suite reviewer's job). Only the four test files overlapping this scope were run; `git-handoff`, `lifecycle`, `safety`, `packaging`, `serve`, `wait`, `http`, `core`, `adapters`, `cli`, `overview`, `restart`, `process-lock`, `session-status`, `smoke`, `token-idle` were not executed.
- Nothing was compiled or packaged (packaging scope); no `tsc`/`biome` run.
- The MEDIUM finding was reproduced against a **fake** provider whose `readFile` honors the documented byte-range contract (`src/providers/freestyle.ts:302-304` forwards `{offset, length}` to the SDK `fs.readFile`; the contract is asserted from code, not exercised against the real Freestyle API, per the no-real-infrastructure constraint). The offset/length semantics of the real SDK were not independently confirmed.
- The `redactedSettings` / `collectSecrets` paths were assessed by code reading plus the passing `settings`/`inspect` suites; no adversarial TOML/env file fuzzing was performed, so rarer false negatives there (e.g. a credential inside a TOML inline table that a parse error echoes verbatim) remain unverified hypotheses rather than findings.
- `Redactor.text`'s base64 variant only covers a contiguous whole-secret encoding; a line-wrapped base64 (PEM-style) form of a credential would not be matched. Treated as an unverified design limitation, not a finding, since no code path in scope emits wrapped base64 of a configured secret.
- No `node_modules` or lockfile change was made to `/workspace/repo`; the disposable worktree at `/tmp/rev-24` was removed after the review.
