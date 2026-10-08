# Review: GitHub Actions trust boundaries, tag/input injection, job permissions, artifact reuse, draft release gates

- Exact target reviewed: `d428e0f730ed5649485732e95d39c32f5d6a8895` (branch `feature/binary-config-serve-20260930`, repo `swarmforge-oss`)
- Detached disposable checkout: `/tmp/rev46` (`git rev-parse HEAD` = `d428e0f730ed5649485732e95d39c32f5d6a8895`)
- Assigned workspace `/workspace/repo` left untouched at baseline `5672ead`, clean, no commits.
- Scope files: `.github/workflows/release.yml` (only workflow in the repo; no composite actions), `scripts/package.ts`, `scripts/build.ts`, `tests/packaging.test.ts` (workflow/release-gate assertions), `README.md` install/verify flow, `package.json` scripts.
- Verdict: **FINDINGS** (3 MEDIUM, 1 LOW; no CRITICAL/HIGH)

## Surface reviewed (facts, verified)

- Triggers: `push` on tags `v*` and `workflow_dispatch` (no `pull_request`, `pull_request_target`, `issue_comment`, `workflow_run`). YAML parsed locally; `permissions: contents: read` at workflow level, `contents: write` only on `draft-release`, which additionally requires `github.event_name == 'push'` and `needs: build`.
- Every `${{ }}` in the workflow is safe: `github.ref_name` appears only as `RELEASE_TAG: ${{ github.ref_name }}` env values (3x), `env.ARTIFACT_NAME` in `with:` blocks, and the workflow token placeholder in one step env. No `${{ }}` appears inside any `run:` script body.
- Tag gate: `bun scripts/package.ts tag "$RELEASE_TAG"` in both jobs, re-checked inside `prepareReleaseAssets` (`scripts/package.ts:386`). `releaseTagMismatch` requires `^v\d+\.\d+\.\d+$` after stripping `refs/tags/` (`scripts/package.ts:414-424`).
- Artifact path: build job uploads 4 `dist/` files under a fixed artifact name; `draft-release` downloads by that exact name (run-scoped store) and never rebuilds; the draft is created with `--draft` only (no `--publish` anywhere).

## Findings

### F1 — MEDIUM — No digest is published for the downloadable archive; the release notes tell users to verify with a manifest that cannot check what they downloaded
- File/line: `.github/workflows/release.yml:156` (and `:157-159`), root cause `scripts/package.ts:75-77`, `:304`, `:351`, `:402`.
- Trigger: publish a draft release for `v*` and download the three attached assets.
- Consequence: the only `.tar.gz` an installer can obtain has no published checksum. `SHA256SUMS` contains exactly one line, for the *extracted* executable, so `sha256sum -c SHA256SUMS` in the download directory fails outright; an operator who follows the release notes sees a failure and cannot authenticate the archive before extracting it. A substituted or corrupted archive is undetectable, and the executable digest in `metadata-<v>.json` is only usable *after* extracting an already-unverified tarball.
- Reproduction (local, `/tmp/probe46`, no compile needed):
  - `checksums({...sha256:"b"*64,...})` returns `"<64 hex>  swarmforge\n"` — one line, `swarmforge` only, no `.tar.gz` entry.
  - `release.yml:157-159` attaches `swarmforge-v${version}-linux-x64-glibc.tar.gz`, `SHA256SUMS`, `metadata-${version}.json` — no archive digest file.
  - Synthesized that exact 3-file asset directory and ran `sha256sum -c SHA256SUMS` → exit 1, `swarmforge: FAILED open or read` / `No such file or directory`. `grep -c tar.gz` over `SHA256SUMS` and `metadata-*.json` → 0 matches in both.
  - `PackagedRelease.archiveSha256` is computed twice (`scripts/package.ts:242`, `:351`) but only ever returned on stdout; it is never written to any file under `dist/` and never attached.
- Why existing guards do not prevent it: `verifyArchive` (`scripts/package.ts:158-251`) and `prepareReleaseAssets` (`:380-404`) both prove things *inside* the tarball (listing, mode, `sha256sum -c`, metadata agreement, commit == `HEAD`). None of them emits or checks a digest *of* the tarball, and the workflow attaches only the three files above. `tests/packaging.test.ts:763-836` asserts the asset file *names* and `:1000-1045` asserts workflow substrings; no test asserts that a published digest covers the downloadable archive. `README.md:51` is self-consistent (`sha256sum -c` runs inside the extracted tree, per `README.md:63`), so the defect is specific to the release-notes wording and to the absence of an archive-level digest.
- Recommendation: emit an archive-level digest as part of packaging (e.g. add a `swarmforge-v${version}-linux-x64-glibc.tar.gz` entry to `dist/SHA256SUMS`, or write `dist/<archive>.sha256`), attach it in the `gh release create` step, and have `prepareReleaseAssets` re-check the downloaded archive against that digest before the release is created; reword the notes to say the archive digest verifies the download and `SHA256SUMS` verifies the extracted executable.

### F2 — MEDIUM — A third-party action pinned to a mutable tag runs inside the only job that holds `contents: write`, after the write-scoped token was persisted on disk
- File/line: `.github/workflows/release.yml:125-127` (`oven-sh/setup-bun@v2` in `draft-release`); also `:31-33` in the read-only job. Checkout steps at `:121-123` set no `persist-credentials`.
- Trigger: the upstream `v2` tag of `oven-sh/setup-bun` is moved or compromised (or a maintainer repoints it without review). `oven-sh` is Bun's org, not GitHub, so it is not covered by GitHub's own reviewed-actions guarantee.
- Consequence: arbitrary third-party code executes in the one job that can write to the repository. `GH_TOKEN` is scoped to the final `gh` step, but that does not contain the exposure: `actions/checkout@v4` defaults to `persist-credentials: true` and writes an `Authorization: basic …` `http.https://github.com/.extraheader` entry into `.git/config` using the job's write-scoped token, so every later step in that job — including the third-party setup step — can read it. Result: repository write and release creation from a compromised non-GitHub action.
- Why existing guards do not prevent it: `tests/packaging.test.ts:932-953` ("the workflow grants write access only to the draft job") asserts only that `contents: write` does not appear in the build job and that no `github.token` appears there; it asserts nothing about action pinning or credential persistence. No step sets `persist-credentials: false`.
- Reproduction / confidence: code-evidenced at the target (workflow text quoted above); the compromise precondition cannot be reproduced locally and was not attempted.
- Recommendation: pin third-party actions to a full 40-hex commit SHA with the version in a trailing comment (`oven-sh/setup-bun@<sha> # v2.x.y`; likewise the `actions/*@v4` pins), and add `persist-credentials: false` to the `draft-release` checkout so the write-scoped token is not left in `.git/config` for subsequent steps.

### F3 — MEDIUM — The release workflow runs from whatever commit the tag names, so the draft-only gate is not a trusted boundary
- File/line: `.github/workflows/release.yml:7-11` (`on: push: tags: v*`), `:45`, `:109-119` (the only gates: event-name check + `package.ts tag` version match).
- Trigger: a collaborator with branch-write access creates branch `evil` whose `package.json` version is bumped to match a tag they push on that branch, and whose `.github/workflows/release.yml` drops `--draft` (or adds `gh release upload` / `gh workflow run`).
- Consequence: GitHub loads the workflow definition from the tagged commit, so the attacker also controls the draft gate and the `contents: write` job body. `gh release create` without `--draft` publishes immediately, turning branch-write access into published releases — and releases are the documented distribution channel (`README.md:34-57`), so installers following it would fetch attacker-controlled binaries under a trusted release page. The `package.ts tag` version check does not help: it too is inside the workflow file the attacker supplied.
- Why existing guards do not prevent it: nothing in the workflow requires the tagged commit to be reachable from the protected default branch; there is no `github.ref_protected` check, no `environment:` with required reviewers, and no separate trusted-definer workflow. The in-workflow `--draft` assertion in `tests/packaging.test.ts:1000-1045` only tests the file at the default-branch/merge commit, not the file at an arbitrary tag.
- Reachability caveat (unverified): whether an arbitrary tag can actually trigger depends on repository rulesets / tag-protection rules and default workflow permissions, which are outside the repository contents and were not inspected (read-only review, no infrastructure calls). If tag protection or a "tags must point into the default branch" ruleset is configured, this is mitigated at the platform layer. Code-evidenced at the workflow level; platform configuration unverified.
- Recommendation: add a repository ruleset (or tag-protection rule) requiring release tags to target commits reachable from the protected default branch; as defense in depth gate `draft-release` on `if: github.ref_protected == true` (and/or verify `github.sha` is contained in the default branch), and move the write step behind a protected `environment:` with required reviewers so publishing is never a single unattended step.

### F4 — LOW (unverified hypothesis) — The published `SHA256SUMS`/`metadata` are the loose top-level copies, which are never compared with the copies inside the verified archive
- File/line: `scripts/package.ts:388-390` and `:402` (recursive `findFile` result becomes the published asset) with `.github/workflows/release.yml:157-159`.
- Trace: `verifyArchive` checks the manifest and metadata *extracted from the tarball*; `prepareReleaseAssets` returns `assets: [archivePath, checksumsPath, metadataPath]` where the latter two are whatever the recursive search found first under `release-assets/`, and the `gh` step attaches exactly those paths. Those loose files are never digest-compared against the archive's own copies.
- Impact if reachable: a release could ship a manifest that does not describe the archive it ships (verification noise, or a manifest that silently blesses a different executable digest than the one in the tarball).
- Reachability: not demonstrated. `packageCli` writes both copies from the same in-memory content (`scripts/package.ts:303-304` then `:315-319`), and the build job uploads a single artifact, so today they are identical. Filed as a hardening gap, not a live bug.
- Recommendation: have `prepareReleaseAssets` read the manifest and metadata out of the verified archive and compare digests with the loose copies before returning them as assets (or publish only the archive and let `SHA256SUMS` come from inside it).

## Verified-clean (no defect)

- Tag/input injection: `releaseTagMismatch` rejects `v0.1.0`-style and every injection shape tested — `v1.2.3;id`, `v1.2.3$(id)`, backticks, embedded newline, single/double quotes, `--title=x`, `-v1.2.3`, `refs/tags/…evil`, `v01.2.3`, `v1.2.3-rc1`. Only an exact `vMAJOR.MINOR.PATCH` == `package.json` version is accepted, which also means a tag can never begin with `-` and so cannot become a flag to `gh`. Local probe, exit 0. The workflow additionally passes it only as a quoted argument.
- Job permissions: write is confined to `draft-release`, which requires a pushed tag and a completed `build`; the build job never references the token.
- Artifact reuse: `download-artifact` fetches one run-scoped artifact by exact name and the draft job contains no `bun run build` / `bun run package`; `verifyArchive` and the commit-vs-`HEAD` check mean the published archive is the one the build job verified. `if-no-files-found: error` guards the upload.
- Draft gate: `--draft` present, `--publish` absent (also asserted by tests).

## Tests / probes run

1. `cd /tmp/probe46 && bun p1.ts` — Bun 1.3.14 (sandbox), pure-function probe importing `scripts/package.ts` (no compile, no install). Exit 0. Output: tag-mismatch matrix, `checksums()` content, `buildMetadata()` shape. Log: `.swarmforge/logs/rev46-probe-p1.log`.
2. Synthesized 3-file release-asset dir → `sha256sum -c SHA256SUMS` (exit 1, as intended for F1); `grep -c tar.gz` over the manifest and metadata (0/0). Log: `.swarmforge/logs/rev46-probe-sha.log`.
3. `python3 -c "yaml.safe_load(...)"` on `release.yml` — exit 0; confirmed triggers/permissions/`if` graph. Log: `.swarmforge/logs/rev46-probe-yaml.log`.

Not run (deliberate, per scope): `bun test` / full suite (whole-suite reviewer's job), `bun run build` / `bun run package` (packaging scope, and the sandbox Bun is 1.3.14 while compilation requires 1.4.2 — installing Bun 1.4.2 under `/tmp` was not necessary because every finding above is decided by reading the code and by pure-function probes, none of which need a compiled binary). `tests/packaging.test.ts` was read as code evidence, not executed; its assertions are quoted where they are said not to cover a finding.

## Limitations

- No repository settings, rulesets, tag-protection rules, or default-workflow-permission inspection (read-only review; no infrastructure calls). F3's platform precondition and F2's compromise precondition are therefore unverified.
- `actions/upload-artifact@v4` root-directory (least-common-ancestor) behaviour for the mixed glob/relative `path:` list at `release.yml:101-105` could not be executed locally. If it ever nested the files, `findFile` would still find and verify them recursively while the hardcoded `release-assets/<name>` paths at `:157-159` would fail at `gh release create` (fail-closed). Not filed as a finding.
- No network calls to GitHub Actions, no release created, no credentials read or emitted.

## Non-source reviewer experiments (outside the checkout, disclosed)

- `/tmp/rev46` — detached clone at the exact target (disposable).
- `/tmp/probe46/p1.ts` — pure-function probe of `releaseTagMismatch` / `checksums` / `buildMetadata`.
- `/tmp/probe46/relassets/` — synthetic release-asset directory for the `sha256sum -c` demonstration.
- `/workspace/.swarmforge/artifacts/{review.md,findings.json}`, `/workspace/.swarmforge/logs/*.log` — this report and probe logs.