# Review 45 — Archive entry validation/extraction, digest/mode/metadata checks, hostile archives, release asset selection

- Target: `d428e0f730ed5649485732e95d39c32f5d6a8895` (branch `feature/binary-config-serve-20260930`)
- Checkout: disposable detached clone at `/tmp/sf-rev` (HEAD verified = target). `/workspace/repo` untouched at baseline `5672ead2a526e07fea9ed11e58b3725e42013527`, clean.
- Scope files: `scripts/package.ts`, `scripts/build.ts`, `.github/workflows/release.yml`, `README.md` install block, `tests/packaging.test.ts`, `src/version.ts`.
- Verdict: **FINDINGS** (4).

## Finding 1 — HIGH: hostile archive entry types are accepted; verification executes an out-of-tree file

- File/line: `scripts/package.ts:126` (`archiveListing`), `:164`, `:184`–`:191`, `:232`, `:237`.
- Trigger: `swarmforge` is a tar **symlink** (or any non-regular member) instead of a regular file.
- Evidence (reproduced, target code, Bun 1.4.2): a tar.gz whose members are `swarmforge -> /tmp/sf-probe/outside/swarmforge`, `SHA256SUMS` (digest of the link target), `metadata-0.1.0.json` (matching digest/bytes) is accepted by `verifyArchive` (`VERIFIED_OK`, exit 0). `archiveListing` only parses `tar -tzf` *names*; `stat()` at `:187` follows the link, so the mode and digest checks measure the link target, and `run([binary, "--version"])` at `:232` / `[binary, "--help"]` at `:237` **executes the out-of-tree target**. Proof: the target appended `OUTSIDE-EXEC` to `/tmp/sf-probe/outside/marker` twice (both probes) while verification ran.
- Consequence: `verifyArchive` is documented as the single definition of an installable archive and the release gate (`.github/workflows/release.yml:145` `package.ts release-assets`, and `bun run package:verify`). A crafted archive reaches arbitrary file execution on the verifying host (release draft job holds `contents: write`; `package:verify` is documented for operator re-checking of a downloaded archive), and the mode/digest guarantees it advertises do not apply to what the archive actually ships.
- Why existing guards do not help: the duplicate-entry and exact-name checks (`:137`–`:143`, `:170`) only compare strings; nothing inspects tar member type. GNU tar's own `../` stripping rejects traversal entries (confirmed: rejected), and hardlink traversal is rejected by tar too, so symlink is the surviving path.
- Correction: reject any member whose tar type is not a regular file before extraction (use `tar -tvzf`/`--to-command` output type column, or extract with `--no-overwrite-dir` plus an explicit `lstat` + `isFile()` assertion on every extracted path, plus reject symlinks/hardlinks/devices/fifos); alternatively use `tar --extract --no-same-owner --no-same-permissions --keep-directory-symlink` with `--warning` escalation and assert `lstat(binary).isFile()` before any `stat`/digest/exec. The exec probes should only ever run a file that `lstat` proved to be a regular file inside `extracted`.
- Confidence: reproduced.

## Finding 2 — MEDIUM: mode check masks setuid/setgid/sticky bits

- File/line: `scripts/package.ts:187` (`(await stat(binary)).mode & 0o777`) compared against `0o755`; metadata literal at `:102` and `:224`.
- Trigger: member mode `4755` (or `2755`, `1755`).
- Evidence (reproduced): archive with `swarmforge` at mode 4755 verified OK (`SETUID_ARCHIVE_VERIFIED`, exit 0); extracted file is `-rwsr-xr-x` (`4755`) while `metadata.executable.mode` claims `"0755"`.
- Consequence: `verifyArchive` certifies a setuid-root executable as a plain `0755` binary, and the metadata assertion at `:224` only re-checks the literal string, so the two checks agree on a false statement. Extraction by a root operator (or a CI runner running as root, as here) yields a setuid binary the release notes describe as ordinary.
- Why existing guards do not help: `& 0o777` discards exactly the bits that matter; the metadata `mode` comparison is string-vs-string and never cross-checks the filesystem mode beyond the masked value.
- Correction: compare the full permission bits (`mode & 0o7777`) to `0o755`, and reject any archive whose recorded mode is not exactly `0755` (also assert `lstat` type per Finding 1).
- Confidence: reproduced.

## Finding 3 — LOW: extra archive members can hide from the "exactly three files" check

- File/line: `scripts/package.ts:132`–`:136` (`.trim()` then `filter(length > 0)`), check at `:170`.
- Trigger: a member whose name is only whitespace (e.g. `"  "`), which normalizes to the empty string and is dropped before the listing is compared.
- Evidence (reproduced): archive with the three expected members plus a fourth member named `"  "` extracted successfully and `verifyArchive` returned `files=["SHA256SUMS","metadata-0.1.0.json","swarmforge"]` — the documented "must contain exactly the executable, its metadata and SHA256SUMS" invariant is not enforced.
- Consequence: a verified archive can carry undeclared extra members. Low direct impact (a whitespace-only name cannot be used for path traversal), but it means the exactness claim and the duplicate check operate on a lossy view of the archive.
- Correction: normalize with `replace(/^\.\//, "").replace(/\/+$/, "")` and reject any member that normalizes to empty instead of silently filtering it; reject blank lines only where the line is genuinely empty.
- Confidence: reproduced.

## Finding 4 — MEDIUM: release asset selection never cross-checks the loose manifest/metadata against the verified archive

- File/line: `scripts/package.ts:356`–`:370` (`findFile`), `:388`–`:403` (`prepareReleaseAssets`).
- Trigger: a release-asset directory that contains a valid archive plus a *different* `SHA256SUMS` or `metadata-<version>.json` (or the same name nested in a subdirectory).
- Evidence (reproduced): directory with a valid archive, a `SHA256SUMS` containing an all-zero digest, and a `metadata-0.1.0.json` describing a 1-byte executable → `prepareReleaseAssets` returned `PREPARED_OK` and listed all three as `assets`. In a second probe, a top-level `SHA256SUMS` was absent and `findFile` selected `nested/SHA256SUMS`, i.e. selection follows `readdir` order and recurses.
- Consequence: the draft release published at `.github/workflows/release.yml:153`–`:159` can carry a `SHA256SUMS` and metadata JSON that do not describe the archive shipped beside them. The build job's guarantee ("the archive a release would carry is the one that was verified") holds only for the archive, so a verifying operator gets a checksum file that cannot match, and the metadata asset can misstate the shipped bytes/commit.
- Why existing guards do not help: `findFile` returns the first name match; `verifyArchive` only ever inspects the *extracted archive* copy of `SHA256SUMS`/metadata (`:192`, `:197`), and `prepareReleaseAssets` calls it without `expectedCommit`, relying on the later `repositoryCommit()` comparison at `:395` for the archive only.
- Correction: after locating the loose files, compare them byte-for-byte (digest) against the copies extracted from the verified archive; reject on any mismatch, and restrict `findFile` to the exact flat layout `actions/download-artifact` produces (no recursion, or deterministic ordering with a duplicate-name rejection).

## Tests run

- `/tmp/bun142/bun-linux-x64/bun test tests/packaging.test.ts -t "archive verification"` → **7 pass, 0 fail** (exit 0).
- `/tmp/bun142/bun-linux-x64/bun test tests/packaging.test.ts -t "release assets"` → **4 pass, 0 fail** (exit 0).
- Bun 1.4.2 unpacked to `/tmp/bun142` (snapshot `bun` is 1.3.14 and cannot parse `bun.lock` `lockfileVersion: 2`; lockfile untouched, `--frozen-lockfile` honoured).
- 8 bounded local probes against the target's own `verifyArchive`/`prepareReleaseAssets`, run outside the checkout in `/tmp/sf-probe` (hostile archives, decoy assets, hardlink, fifo, symlinked metadata). No cloud/model provider or infrastructure was contacted. Log: `/workspace/.swarmforge/logs/review-45-archive-verification.log`.

## Limitations

- Reviewer-made hostile archives in `/tmp/sf-probe` only; nothing under `/tmp/sf-rev` was modified (`git status` clean).
- The full suite was not run (whole-suite reviewer's job); only the two packaging describes above.
- Findings are about what `verifyArchive` certifies, not about a demonstrated compromise of GitHub Actions artifact handling; the release-workflow exposure is code-evidenced, the probe evidence is local.
- No credentials, tokens, or credential-shaped URLs appear in this report or in the probes.
