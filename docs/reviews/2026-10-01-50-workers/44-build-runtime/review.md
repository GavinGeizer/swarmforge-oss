# SwarmForge reviewer report — build/runtime scope

- Target: `d428e0f730ed5649485732e95d39c32f5d6a8895` (branch `feature/binary-config-serve-20260930`)
- Reviewer scope: Bun compilation options, ambient file autoload exclusion, version/commit definitions, target/runtime support
- Verdict: **FINDINGS** (1 MEDIUM, 3 LOW). No CRITICAL/HIGH.
- Disposable checkout: `/tmp/rev44clone` (detached at target, `git rev-parse HEAD` verified).
  `/workspace/repo` untouched (HEAD `5672ead`, assigned branch, clean).
- All probes are local, offline-of-any-provider, and live only under `/tmp/probe` and `/tmp/rev44clone`.
  No cloud/model provider was contacted; no credentials used; no secret files read.

## Files reviewed at target

`scripts/build.ts`, `scripts/package.ts`, `src/version.ts`, `src/cli.ts` (version/help lines),
`package.json` (scripts/bin/engines/packageManager), `.github/workflows/release.yml`,
`node_modules/bun-types/bun.d.ts` (1.4.2, `CompileBuildOptions`), `tests/packaging.test.ts`,
`README.md` (install/build claims), `.gitignore`.

## Findings

### F1 — MEDIUM (reproduced): `buildConfig` ignores `root`, so packaging another source tree silently ships this repository's code

- Location: `scripts/build.ts:84` (`entrypoints: [join(repositoryRoot, "src", "cli.ts")]`),
  in tension with `scripts/build.ts:94` / `scripts/build.ts:110` (`root` parameter) and
  `scripts/package.ts:272`-`scripts/package.ts:286`, which thread `root` into `compileCli`.
- Trigger: any programmatic `packageCli({ root })` / `compileCli({ root })` call with a tree
  other than this checkout (a fork, a vendored copy, a vendored-release builder).
- Consequence: `version` and `commit` are read from `root`, but the compiled code always comes
  from `repositoryRoot`. The resulting archive is named and stamped with the *other* tree's
  version and commit while carrying *this* tree's source. Operator-visible provenance is wrong
  and `--version`/`--help` report the foreign commit, so every downstream check agrees.
- Reproduction (Bun 1.4.2, `/tmp/probe/root-probe.ts`): created `/tmp/probe/altroot` with
  `package.json` version `9.9.9-alt` and one commit; ran
  `packageCli({ root: "/tmp/probe/altroot", outDir: "/tmp/probe/altdist" })` → exit 0,
  producing `swarmforge-v9.9.9-alt-linux-x64-glibc.tar.gz` and
  `metadata-9.9.9-alt.json` with commit `f1d7b3d2…`, while the archived binary is this
  repository's `src/cli.ts` build (82,695,648 bytes; `--help` prints this repo's control-plane usage).
- Why existing guards do not prevent it: `packageCli` compares
  `executable.version !== version` (`scripts/package.ts:287`), but both sides are derived from the
  same `root`, so the guard is self-consistent. `verifyArchive` only cross-checks define'd strings,
  the digest and the executable's own `--version`/`--help` output — never the source tree. Nothing
  in `tests/packaging.test.ts` passes `root`, and neither `scripts/build.ts` nor `scripts/package.ts`
  `main()` passes it, so no test or CLI path reaches this today (impact is latent, not live in CI).
- Recommendation: thread `root` into `buildConfig` and use `join(root, "src", "cli.ts")`, or delete
  the `root` parameter so the mismatch cannot be expressed.
- Confidence: high (reproduced).

### F2 — LOW (code-evidenced): `SHA256SUMS` covers only the executable, leaving the shipped provenance metadata unverified by the documented install step

- Location: `scripts/package.ts:75`-`scripts/package.ts:77` (`checksums()`), consumed by the
  operator install block documented at `README.md:50`-`README.md:52`.
- Trigger: an archive that is repacked or edited after publication (or a mirror that rewrites it)
  with `metadata-<version>.json` modified.
- Consequence: the documented verification `sha256sum -c SHA256SUMS` passes, while the file that
  states version, commit, target and platform — the only operator-visible record of what the binary
  was built from — is not covered by any shipped digest. CI's `verifyArchive` does catch a repacked
  archive, but the post-download check the README teaches an operator does not.
- Why existing guards do not prevent it: `verifyArchive` reads metadata and compares it to the
  executable, but it validates against the metadata *inside the same archive*; nothing binds the
  metadata file bytes to the manifest.
- Recommendation: emit manifest lines for the metadata file as well, and extend the
  `expectedFiles`/`sha256sum -c` expectations in `verifyArchive` accordingly.
- Confidence: medium (design gap; requires archive tampering to matter).

### F3 — LOW (code-evidenced): build provenance ignores a dirty worktree

- Location: `scripts/build.ts:109`-`scripts/build.ts:123` (`repositoryCommit`), consumed by
  `scripts/build.ts:182` and `scripts/package.ts:275`.
- Trigger: `bun run build` / `bun run package` from a checkout with uncommitted modifications
  (a very common local release-prep flow).
- Consequence: the binary and `metadata-<version>.json` record a clean HEAD SHA that does not
  describe the shipped source, which defeats the documented purpose ("records the real commit so
  an operator can map a running binary back to source", `scripts/build.ts:104`-`scripts/build.ts:107`).
  The release workflow's own cross-check (`--help | grep "build $(git rev-parse HEAD)")` would also
  pass, since it compares against the same HEAD.
- Why existing guards do not prevent it: `repositoryCommit` validates only the SHA *format* and
  `git rev-parse` exit status; no cleanliness check exists anywhere in the build path.
- Recommendation: run `git status --porcelain` before compiling and either refuse to package a dirty
  tree or stamp `dirty: true` in the metadata; keep the refusal in `packageCli`, not only in `main()`.
- Confidence: medium (not exercised in CI, where checkouts are clean).

### F4 — LOW (code-evidenced): duplicated, unused `advertisedPlatform` constant invites silent drift

- Location: `scripts/build.ts:25` (exported, never imported anywhere) versus the live copy at
  `scripts/package.ts:40` (used by `archiveName` at `scripts/package.ts:67` and `buildMetadata` at
  `scripts/package.ts:97`).
- Consequence: editing `scripts/build.ts:25` changes nothing; a future platform change applied to the
  wrong copy would leave the archive name, metadata and README claims out of sync with no test
  failure (the packaging test asserts against `compileTarget`, not the platform literal).
- Recommendation: delete the dead export in `scripts/build.ts`, or have `scripts/package.ts` import it.
- Confidence: high (grep-verified: no importer).

## Verified-correct in this scope (no defect)

- **Ambient autoload exclusion works, and the flags that matter are the right two.**
  `node_modules/bun-types/bun.d.ts:3684`-`3714` (Bun 1.4.2) documents `autoloadDotenv` and
  `autoloadBunfig` as `@default true`, while `autoloadTsconfig`/`autoloadPackageJson` already
  default to `false`; so `scripts/build.ts:51`-`54` turns off two live defaults and restates two
  already-off ones (harmless, and defensive). All four keys are real 1.4.2 API members, so the
  `satisfies Pick<Bun.BuildConfig, …>` at `scripts/build.ts:56` is honest.
  Behavioural proof: in `/tmp/probe/foreign` (containing `.env`, `bunfig.toml`, `package.json` with
  `"type":"commonjs"`, `tsconfig.json`), the binary built from target (`/tmp/rev44clone/dist/swarmforge`)
  reported `url` source `default`, while a control binary compiled with the same
  `scripts/build.ts` `compileSettings.compile` minus the four flags reported source `env` and the
  foreign URL — i.e. the flags, not luck, are what suppress it. The compiled binary also ignored a
  `.env`/`bunfig.toml` placed beside the executable itself (`/tmp/probe/instdir`), so the README claim
  ("does not read `.env`, `bunfig.toml`, `tsconfig.json` or `package.json` from the directory it runs in",
  `README.md:67`-`README.md:69`) holds.
- **Source-run ambient suppression works.** `bun --no-env-file --config=/dev/null src/cli.ts config show`
  in the same foreign directory reported `source: default`, whereas the bare source run reported
  `source: env` and the foreign URL — so the `--no-env-file` / `--config=/dev/null` flags in
  `package.json` `dev`/`start`/`status` (`package.json:10`-`package.json:13`) genuinely suppress both
  mechanisms. (Existing coverage only string-matches the scripts and asserts the *absence* of
  suppression on a bare run; the positive behaviour above was verified here and is not regression-guarded.)
- **Version/commit definitions work as documented.** `bun scripts/build.ts` printed
  `version 0.1.0`, `commit d428e0f730ed5649485732e95d39c32f5d6a8895`. A control build with
  `--define`-equivalent values reported `9.9.9` and `build cafecafe…`, confirming Bun's `define`
  substitution covers the `typeof SWARMFORGE_BUILD_* === "undefined"` guards at `src/version.ts:29`
  and `src/version.ts:43`, and that the source fallback path (`unknownCommit`) stays unreachable in a
  compiled binary. JSON-encoding of the values (`scripts/build.ts:71`-`76`) holds.
- **Target/runtime support is honest.** `bun-linux-x64-baseline` is a member of
  `Bun.Build.CompileTarget`. `file`/`ldd` on the built binary: ELF x86-64, dynamically linked against
  glibc (`libc.so.6`, `libpthread`, `libdl`, `libm`), and `objdump -T` shows a maximum required symbol
  version of **GLIBC_2.17** — i.e. the `ubuntu-24.04` runner's glibc 2.39 did not leak into the
  artifact, matching the advertised `linux-x64-glibc` platform name and the README's "ordinary x64
  servers" claim. No `GLIBCXX_` dependency. `bytecode: false` yields plain transpiled JS as documented.

## Tests and probes run (all local, bounded)

| Command | Exit | Result |
|---|---|---|
| `/tmp/bun142/bun-linux-x64/bun install --frozen-lockfile` (in `/tmp/rev44clone`) | 0 | 125 packages |
| `bun scripts/build.ts` (Bun 1.4.2) | 0 | binary 82,691,552 B, target `bun-linux-x64-baseline` |
| `./node_modules/.bin/tsc --noEmit` | 0 | no type errors |
| `bun test tests/packaging.test.ts -t "ambient"` | 0 | 1 pass, 0 fail, 34 filtered out |
| `file`/`ldd`/`objdump -T` on built binary | 0 | glibc dynamic, max `GLIBC_2.17` |
| `/tmp/probe/root-probe.ts` (F1 reproduction) | 0 | defect reproduced |
| ambient probes (foreign dir, instdir, source-run flags) | 0 | behaviour as described above |

Bun 1.4.2 was installed to `/tmp/bun142` (`1.4.2+744846f84`) because the image's `/usr/local/bin/bun`
is 1.3.14, which cannot read this lockfile (`lockfileVersion 2`). No lockfile was rewritten.

## Limitations

- Full `tests/packaging.test.ts` (compiles the CLI and two fixtures, ~5 min) and the whole suite were
  not run; only one targeted test and the build/type-check steps above. Untested here: the `serve`
  path of the compiled binary, restart/lifecycle behaviour of packaged builds, and every non-packaging
  module.
- The release workflow (`.github/workflows/release.yml`) was reviewed statically and its individual
  commands reasoned about; no GitHub Actions run was performed. `bun run package:verify`,
  `draft-release`, and `gh release create` were not executed.
- F1's practical impact is bounded by the fact that no shipped code path passes `root`; it is a latent
  API hazard, not a live packaging bug. F2/F3 require archive tampering or a dirty tree to matter.
- Cross-target builds (musl, arm64, darwin, windows) were out of the milestone's stated scope and were
  not attempted; only `bun-linux-x64-baseline` was compiled.