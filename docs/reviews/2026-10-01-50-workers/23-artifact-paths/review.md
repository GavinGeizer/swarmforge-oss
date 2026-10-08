# SwarmForge reviewer report (artifact path scope)

- **Target (exact):** `d428e0f730ed5649485732e95d39c32f5d6a8895`
- **Branch reviewed:** `feature/binary-config-serve-20260930`
- **Scope:** Artifact path canonicalization, traversal/symlinks/TOCTOU, size/range boundaries, filesystem reads.
- **Reviewer workspace:** `/tmp/rv-artifact-paths` (disposable detached clone, `git rev-parse HEAD` = target). `/workspace/repo` was left on its assigned baseline `5672ead2a526e07fea9ed11e58b3725e42013527` and verified clean.
- **Verdict:** INCOMPLETE (findings recorded; one probe did not finish before the 30-minute review deadline).

## Files in scope

- `src/files.ts` — `WorkerFiles.path/checked/noSymlinks/artifacts/artifact/readArtifact` (the artifact path resolver, symlink walk, byte-range reader). Unchanged by this branch's delta relative to baseline; reviewed as existing code.
- `src/mcp.ts` — `get_worker_artifact`, `list_worker_artifacts`, and the `worker-artifact` `resources/read` template that re-parses a URI into `(worker_id, path, offset, length)`.
- `src/security.ts` (`Redactor`), `src/providers/freestyle.ts` (`stat`/`readFile`/`listFiles` guest FS bindings), `src/settings/paths.ts` and `src/settings/load.ts` (host-side path anchoring and config/env file reads).

## Findings

### F1 — MEDIUM — TOCTOU between the symlink walk and the read; a guest-side swap makes the artifact allowlist advisory only

- **File/line (target):** `src/files.ts:24-31` (`checked`), `src/files.ts:32-40` (`noSymlinks`), used by `src/files.ts:92-101` (`readArtifact`).
- **Trigger:** `checked()` first walks every path prefix with `provider.stat` and throws on `isSymlink`, then performs a *separate* `provider.stat`, and `readArtifact` later performs a *third*, separate `provider.readFile`. Nothing binds the verified directory entries to the bytes actually read.
- **Consequence:** the artifact retrieval is confined to `<workspace>/.swarmforge/artifacts` only by convention. A worker (or any guest process) that rewrites a checked prefix into a symlink between the walk and the read makes SwarmForge return bytes from an arbitrary guest path (for example `/etc/shadow`) as a "worker artifact". The credential redaction in `readArtifact` still applies, so this is a confinement/containment failure rather than a direct secret-disclosure primitive, but it does contradict the documented contract in `docs/MCP-API.md` ("Traversal and symlink paths are rejected").
- **Reproduction (reproduced, local fake provider, no real guest):** probe `E` in `/tmp/rv-probe/probe.test.ts`. `provider.stat` returns a clean non-symlink file for every prefix on the first (checking) phase; `provider.readFile` then flips the fake into the post-check phase and returns `root:$6$...` content. Observed result: `E read after swap -> "root:$6$saltsalt$hashhashhashhashhash:19"` — content from outside the artifacts root was returned without error.
- **Why existing guards/tests do not prevent it:** `tests/api.test.ts:185` ("artifact directory listing rejects symlink roots") overrides `provider.stat` to *always* return `isSymlink: true`, which only proves the check fires when the stat itself is hostile. No test exercises a stat-then-read sequence in which the path mutates between the two calls, so a passing suite is consistent with this bypass.
- **Recommendation:** do not treat prefix `stat` results as a capability. Either re-verify after the read (read, then re-`stat` the prefixes and compare, discarding on mismatch), or — preferably — have the provider resolve and read the artifact in one guest-side operation that opens components with `O_NOFOLLOW`/equivalent, so a single call both reads and rejects symlinked prefixes. If only a mitigation is possible, at minimum perform the symlink walk and the read under a single bounded provider call and document the residual guest-side race.
- **Confidence:** high (reproduced against the target code with the repository's own fake-provider seam).

### F2 — LOW — `readArtifact` skips the credential-shaped-path check that `artifact()` enforces

- **File/line (target):** `src/files.ts:69-71` (check present in `artifact`) versus `src/files.ts:83-108` (check absent in `readArtifact`).
- **Trigger:** `artifact()` rejects a path whose redacted form differs from the input ("Artifact path contains credentials"). `readArtifact()` is the function actually bound to the MCP `resources/read` template (`src/mcp.ts:329-336`) and does not repeat that check; it calls `checked()` directly.
- **Consequence:** an asymmetry rather than a proven leak. A path that `get_worker_artifact` refuses can still be read directly through `resources/read`, so the control is advisory on the path that matters. Note the file *contents* are still credential-checked at `src/files.ts:103-106`, so this is not a demonstrated secret-disclosure path on its own.
- **Reproduction (reproduced, local fake provider):** probe `D`. With a file literally named after the configured model API key under the artifacts root: `D artifact(): rejected -> Artifact path contains credentials` and `D readArtifact(): ACCEPTED, bytes=content-here`. (Value sanitized in this report.)
- **Why existing guards/tests do not prevent it:** `tests/api.test.ts:101` covers traversal (`../start.sh`) and secret *contents*, and never asserts that `readArtifact` rejects a credential-shaped path. The two entry points are tested independently, so the gap is not visible from the suite.
- **Recommendation:** factor the path precondition used at `src/files.ts:70` into a helper and call it from `readArtifact` as well, so both entry points share one gate.
- **Confidence:** high for the behavioral asymmetry (reproduced); the security impact is bounded by the content-level redaction and is reported as low accordingly.

### F3 — LOW — One artifact request amplifies into hundreds of sequential provider `stat` round trips

- **File/line (target):** `src/files.ts:32-40` (`noSymlinks` issues one `stat` per path prefix, each individually wrapped by `this.c.bounded(...)` at `src/files.ts:36`), reached from `src/files.ts:24-31` and `src/files.ts:50`.
- **Trigger:** a legal relative path made of many single-character segments. The only length guard is `path.length > 1024` at `src/files.ts:13`; nothing bounds the *segment count*.
- **Consequence:** cost/latency amplification against the guest filesystem API rather than a traversal or disclosure bug. Each prefix is a separate awaited remote call with its own timeout, so a single `get_worker_artifact` or `list_worker_artifacts` call can occupy the MCP request for a long time and multiply provider calls. The 1024-byte cap bounds it, so this is a bounded amplification, not unbounded.
- **Reproduction (reproduced, local fake provider):** probe in `/tmp/rv-probe/amp.test.ts`, a 1023-character path with 512 segments. Observed: `readArtifact -> stat=516 readFile=0` and `artifact -> stat=516 readFile=0`. A 501-segment path produced `stat=4` before the fake's own `missing file` error, confirming per-prefix fan-out rather than a single lookup.
- **Why existing guards/tests do not prevent it:** `tests/api.test.ts` exercises only single-segment paths (`report.txt`, `secret.txt`), so the per-prefix fan-out is never measured.
- **Recommendation:** cap the number of path segments (for example reject more than 32) alongside the existing length check, or resolve the artifact root once per request instead of re-walking every prefix per call.
- **Confidence:** high for the fan-out (reproduced); the severity is capped by the 1024-byte limit, hence LOW.

### F4 — LOW / UNVERIFIED — `SWARMFORGE_WORKSPACE` may end in `/`, producing a `//` prefix in the artifact root

- **File/line (target):** `src/config.ts:72-75` (the workspace regex `/^\/(?:[a-zA-Z0-9_.-]+\/?)*$/` permits a trailing slash) consumed by `src/files.ts:22` and `src/files.ts:45` (`${workspace}/.swarmforge/artifacts/...`).
- **Trigger:** configuring `SWARMFORGE_WORKSPACE=/workspace/`.
- **Consequence:** the provider receives `/workspace//.swarmforge/artifacts/<path>`. The `..`/`.`/empty-segment guard in `files.ts:17-19` is applied to the *caller-supplied* path only, so the doubled separator is not caught there; `noSymlinks` splits on `/` and filters empties, so its walk normalizes while the path handed to the guest does not. Reachability and guest-side effect are unconfirmed.
- **Reproduction:** a `loadConfig` probe was started to print the resulting path but the command was aborted at the review deadline. No result was obtained, and no real guest was contacted. This entry is an unverified hypothesis, not a reproduced finding.
- **Why existing guards/tests do not prevent it:** no test in `tests/settings.test.ts` or `tests/api.test.ts` exercises a trailing-slash workspace value.
- **Recommendation:** normalize the workspace once at config validation (strip trailing slashes, or anchor the artifact root with `node:path.join`/`resolve` so the composed path is canonical regardless of the configured form).
- **Confidence:** low — code-evidenced only, deliberately not counted as a confirmed defect.

## Non-findings (checked and found sound)

- `files.ts:11-23` rejects absolute paths, backslashes, empty/`.`/`..` segments, NUL bytes, and over-length input; `mcp.ts:329-336` `decodeURIComponent`s the URI before that check, so percent-encoded traversal is validated after decoding. Confirmed by code trace.
- `artifacts()` (`files.ts:54-63`) additionally filters entries that are symlinks or contain path separators, and sorts before slicing.
- Range arithmetic is self-consistent. Probe `B` (`offset`/`length` at and past EOF) and probe `C` (`readArtifact` past EOF and at `Number.MAX_SAFE_INTEGER`) produced bounded results with no over-read: `length` clamps to `max(0, size - offset)` and `next_offset` is `null` on the final chunk. `readArtifact` independently enforces `Number.isSafeInteger` and `1 <= length <= 32768` at `files.ts:84-91`, so the unvalidated `offset`/`length` of `artifact()` are re-validated on the read path.
- `stats.size` is never trusted for slicing: `readArtifact` slices the *returned* buffer at `files.ts:107`, so a file that shrinks between `stat` and `read` yields a short chunk rather than stale or padded bytes.
- `redactorFor(...).contains(bytes)` is applied to the padded overlap window (`files.ts:94-102`), so a credential split across a chunk boundary still blocks retrieval. Probe `F` confirmed a mid-file read returns exactly the requested 1024 bytes.

## Tests and probes actually executed

Bun 1.4.2 (official release unpacked to `/tmp/opencode/bun-linux-x64`) was used because the snapshot's Bun 1.3.14 cannot read this `lockfileVersion: 2` lockfile. `bun install --frozen-lockfile` completed in the disposable `/tmp` clone; `bun.lock` was not modified and `/workspace/repo` was never installed into or written to.

| Command | Result |
| --- | --- |
| `bun test tests/api.test.ts` (in `/tmp/rv-artifact-paths`) | exit 0 — 8 pass, 0 fail, 32 expect() calls |
| `bun test /tmp/rv-probe/probe.test.ts` (probes A–F) | exit 0 — 6 pass, 0 fail |
| `bun test /tmp/rv-probe/amp.test.ts` (amplification probe) | exit 0 — 1 pass, 0 fail |
| `bun test /tmp/rv-probe/canon.test.ts` (F4) | **not completed** — aborted at the review deadline; no output |

The full test suite was deliberately not run (whole-suite review is out of this scope). No real cloud, model, or infrastructure provider was contacted; all probes used the repository's in-process `FakeProvider` seam.

## Limitations

- **The review exceeded its 30-minute budget and was recovered in bounded mode.** The canonicalization probe behind F4 did not finish, and no further code was inspected after the deadline.
- Findings are based on the `WorkerProvider` seam, not on a real Freestyle guest. F1 and F3 are demonstrated against `src/files.ts` logic with a fake provider; the guest-side behaviour of the real FS API (symlink resolution on read, and normalization of a `//` prefix per F4) was not observed and remains unverified.
- F4 is an unverified hypothesis and is intentionally not presented as a confirmed defect.
- Secret material in this report is sanitized: the production `Redactor` (`src/security.ts`) was run to a fixed point over the exported artifacts with the repository's test-default credentials plus dummy canaries, and residual-literal checks were asserted programmatically.
- No code changes were made. `/workspace/repo` remains at `5672ead2a526e07fea9ed11e58b3725e42013527`, clean, with nothing committed or pushed by this reviewer.
