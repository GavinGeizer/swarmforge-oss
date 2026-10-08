# Reviewer 32 — Git URL/branch/author/command shell boundaries, escaping, credential handling, path injection

- Exact target reviewed: `d428e0f730ed5649485732e95d39c32f5d6a8895` (branch `feature/binary-config-serve-20260930`)
- Disposable detached checkout: `/tmp/rv32` (`git rev-parse HEAD` = d428e0f…, verified after clone)
- Assigned workspace `/workspace/repo` left untouched at baseline `5672ead2a526e07fea9ed11e58b3725e42013527`, clean
- Toolchain: Bun 1.4.2 installed to `/tmp/bun142` (repo needs >=1.4.2; lockfile untouched)
- Verdict: FINDINGS (3)

## Scope inspected

`src/git-handoff.ts`, `src/providers/freestyle.ts` (all `vm.exec` command strings, credential staging,
`quote`), `src/safety.ts`, `src/files.ts`, `src/security.ts`, `src/serve-command.ts`, `src/config.ts`,
`src/coordinator.ts` (git handoff / destroy paths), `src/settings/{load,paths,inspect}.ts`,
`src/runtime.ts`, `src/cli/*`, `scripts/{build,package,smoke}.ts`, `.github/workflows/release.yml`.

## Findings

### F1 — HIGH — Worker-writable `git-base` file is the sole trust anchor for the push verification

- File/line: `src/providers/freestyle.ts:140` (written), `src/providers/freestyle.ts:255` (trusted on push)
- Trigger: the base commit used by `pushBranch` is read back from
  `${SWARMFORGE_WORKSPACE}/.swarmforge/git-base`, a file inside the workspace the worker (OpenCode,
  running as `root`, `src/providers/freestyle.ts:116-143` and the unit at line 173 has no `User=`)
  owns. The worker writes that path at will between checkout and push.
- Consequence: `git merge-base --is-ancestor "$base" "$commit"` always succeeds when the worker writes
  its own `HEAD` into the file, and `base_commit` in the durable result/`review_url` becomes whatever
  the worker chose. The handoff can therefore report `persisted=true` and a GitHub compare link whose
  range the worker fabricated, i.e. the "verified handoff" invariant is not actually verified. A
  worker can also point `base` at an unrelated ancestor to make a rewritten history look in-order.
- Reproduction (local probe, `/tmp/probe/g2`, exact command string from line 255 rebuilt against a real
  local bare remote): with `git-base` rewritten by the "worker" to the current `HEAD`, the full
  `push + ls-remote verification` sequence exited `0` and printed
  `base_commit == commit` (`5d321e7…`, `5d321e7…`) for a repo whose real base was a different commit.
- Why guards do not help: `test -z "$(git status --porcelain --untracked-files=all)"` only inspects the
  repository, and `.swarmforge/git-base` is deliberately excluded from the persistence scan
  (`src/safety.ts:38` excludes `.swarmforge`). Nothing re-derives the base from the clone, and
  `git-base` is not covered by the existing test in `tests/git-handoff.test.ts:324` (which writes it
  from the control-plane side).
- Recommendation: keep the base commit in control-plane state (store it when `prepare` checks out the
  branch, e.g. in the worker record or a SQLite setting) and pass it into the push command as a
  literal, instead of re-reading a worker-owned file. If the file must stay for crash recovery, verify
  it against the stored value and fail closed on mismatch.

### F2 — MEDIUM — `none:`-prefixed absolute trees are excluded from the persistence scan

- File/line: `src/safety.ts:14` — `c.SWARMFORGE_GIT_TREE.startsWith("/")`
- Trigger: `gitTree()` (`src/config.ts:165-169`) accepts the documented `none:/abs/path` form
  (`docs/ENVIRONMENT.md:15`), and `workerEnvironment` (`src/config.ts:178`) hands the worker the
  stripped `/abs/path`. The safety check tests the *raw* config value, which starts with `none:`, so
  the external tree is never added to `roots`.
- Consequence: `inspectPersistence` returns `safe: true` while unpersisted work sits in the external
  tree. `applyControl` destroy (`src/coordinator.ts:940-958`) and `fail()`
  (`src/coordinator.ts:786-802`) then take the `failed`/destroy path instead of
  `recovery_required`, so the VM holding uncommitted external-tree work can be deleted. Data loss on
  a documented configuration.
- Reproduction: ran the generated script (rebuilt from `src/safety.ts` lines 17-42) against a clean
  workspace plus a dirty external tree. Absolute form → `{"safe": false, ... "files outside a Git
  repository"}`; `none:`-prefixed form → `{"safe": true, "reason": "no obvious unpersisted
  work"}`. Also confirmed the emitted root list differs
  (`["/workspace","/mnt/tree"]` vs `["/workspace"]`).
- Why guards do not help: `docs/ARCHITECTURE.md:32` explicitly says files outside declared workspaces
  "require operator care", but the code treats a scanned root as the proof, and the destroy path
  trusts that proof. `tests/safety.test.ts` does not cover the `none:` form.
- Recommendation: derive the root from `gitTree(c.SWARMFORGE_GIT_TREE).target` instead of the raw
  string, and scan any target that is an absolute path; add a `none:/abs` case to
  `tests/safety.test.ts`.

### F3 — LOW — Handoff credentials (SSH private key, GitHub App installation token) are outside every redaction set

- File/line: `src/security.ts:43-50` (`redactorFor`), `src/serve-command.ts:45-52`
  (`commandRedactor`), guard used at `src/files.ts:70` and `src/files.ts:103`
- Trigger: `redactorFor` knows only the Freestyle token, model key, MCP bearer token and worker
  passwords; `commandRedactor` adds `SWARMFORGE_GIT_PUSH_URL`. Neither knows the GitHub App
  installation token minted per push (`src/git-handoff.ts:74`) nor the SSH private key read at
  `src/providers/freestyle.ts:210-218`.
- Consequence: if a worker copies the staged credential (or a Git URL carrying one) into an artifact
  or a journal line, `readArtifact`'s credential guard passes it through to the trusted lead instead
  of blocking, and the same gap applies to result/event/log rendering. Today the staging file is
  0600 under root and short-lived, so this is a defence-in-depth gap rather than a demonstrated live
  leak; the SSH key is long-lived, which raises the impact if it is ever echoed.
- Reproduction: probe with a `FakeProvider` and a `WorkerFiles.readArtifact` call returned 58 bytes for
  a fake `BEGIN OPENSSH PRIVATE KEY` artifact and 33 bytes for a `ghs_…` token artifact — neither
  blocked. A `Redactor` probe also showed `ssh://user:pass@host/…` is *not* scrubbed by the URL regex
  (`https?://` only), so a credential-bearing `SWARMFORGE_GIT_PUSH_URL` would survive `text()` unless
  the whole URL is in the secret set (which `commandRedactor` does, `redactorFor` does not).
- Why guards do not help: `Redactor` can only remove secrets it is given, and both constructors omit
  the Git handoff credential material; `tests/commands.test.ts` and `tests/serve.test.ts` only assert
  the Freestyle/model/MCP tokens and the push URL.
- Recommendation: thread the handoff credential (App token and SSH key, plus the push URL) into the
  redactor used by `files.ts`, `coordinator.ts` and `runtime.ts` for the duration of a push, and
  extend the `Redactor` URL regex to `ssh://` (and any other userinfo-bearing scheme).

## Reviewed and found adequate (no defect)

- `quote()` (`src/providers/freestyle.ts:8`) is a correct POSIX single-quote escaper. Probed with
  `'`-heavy, `$( )`, backtick, newline, tab and backslash inputs; the escaping is exactly `'\''`.
  Newlines survive but stay inside single quotes, so they cannot break out.
- `branchFor` (`src/git-handoff.ts:7-15`) maps every non-`[A-Za-z0-9_-]` byte to `-` and strips
  leading/trailing `-`, so no branch can contain `/`, whitespace, `..`, a leading `-`, or a shell
  metacharacter; it also always starts with the `swarmforge/` prefix, so option injection into
  `git checkout`/`git push` is impossible.
- Remote/refspec arguments use `git push -- <url> <refspec>` and `git ls-remote -- <url> <ref>` with
  quoted arguments, so a hostile `SWARMFORGE_GIT_PUSH_URL` cannot become a Git option or a second
  refspec. `SWARMFORGE_GIT_TREE` is only interpolated into `git clone -- <quoted>`.
- `OPENCODE_START_COMMAND` is intentionally unquoted (`exec <command>`); it is operator config, not
  model output. Worker-derived values in `start.sh` go through `export <k>=<quote(v)>`.
- Guest credential staging never places secret material on a command line: the App token is written to
  a 0600 file and delivered via `GIT_ASKPASS`, and the SSH key via `GIT_SSH_COMMAND`; both are removed
  afterwards and removal failure is raised rather than swallowed
  (`src/providers/freestyle.ts:229-241`). `tests/git-handoff.test.ts:238` asserts the key never
  appears in any command.
- `githubInstallationToken` scopes the token request to the configured repository name with
  `contents: write` and validates the response shape; the `Authorization` header is never logged, and
  the token is never stored in SQLite or the result (verified by reading every use site).
- `github-app` mode pins `SWARMFORGE_GIT_TREE` to exactly `https://github.com/<repo>[.git]`
  (`src/config.ts:117-128`), so a hostile tree cannot redirect the App token elsewhere. `ssh` mode
  requires an explicit push URL, key path and known-hosts path, and both paths must be absolute.
- Artifact path handling (`src/files.ts:11-40`) rejects absolute paths, `\`, NUL, `.`/`..`/empty
  segments and length overflow, and re-stats every prefix to reject symlinked components; the same
  validation runs on the MCP resource path after `decodeURIComponent`.
- The safety script embeds its roots with double `JSON.stringify` and is then shell-quoted; a root
  containing `"); os.system(...) #` produced valid JSON inside the Python literal and no code
  execution (`/tmp/pwned` was not created).
- `scripts/build.ts` and `scripts/package.ts` use `Bun.spawn` with argument arrays (no shell), the
  archive member allowlist rejects extra/duplicate entries before extraction, and the release
  workflow passes the tag only as a quoted argument via `env:` (never interpolated into a `run:`
  script).
- `SWARMFORGE_WORKSPACE` is regex-anchored and rejects `..`; `SWARMFORGE_HOST`/`ALLOWED_HOSTS` feed a
  strict host allowlist, and the bearer token comparison is length-checked before `timingSafeEqual`.

## Tests / probes run

- `bun test tests/git-handoff.test.ts tests/safety.test.ts` → 11 pass, 0 fail (exit 0)
- `bun test tests/git-handoff.test.ts tests/safety.test.ts tests/settings.test.ts` → 67 pass, 0 fail
  (exit 0)
- Disposable probes (all under `/tmp`, removed from `/tmp/rv32` afterwards; `/tmp/rv32` is clean):
  `quote()` escaping table; `gitTree`/`safety roots` divergence (F2); real-git push+ls-remote
  verification with a worker-forged `git-base` (F1, exit 0 with `base_commit == commit`);
  `readArtifact` guard with SSH-key and App-token content (F3, both returned);
  `Redactor` treatment of `ssh://user:pass@` and of an absent-from-set secret.
- No full-suite run (out of scope for this reviewer), no cloud/provider calls, no real infrastructure.

## Limitations

- F1's end-to-end consequence in a real SwarmForge deployment was not executed against a live provider;
  it is reproduced at the shell-command level with the exact command string from the target and a real
  local Git remote, plus a code trace. No real credentials were used anywhere.
- F3 is code-evidenced and probe-confirmed at the redaction layer; whether a credential ever reaches an
  artifact in production was not observed.
- The push credential window during `pushBranch` (the guest OpenCode service is not stopped first —
  `complete()` at `src/coordinator.ts:692` performs no quiesce) was noted but not raised as a finding:
  the window is short and the staged files are root-owned 0600, so exploitation requires guest code
  execution, which the design already assumes.
- Bun 1.4.2 was installed to `/tmp/bun142`; the repository lockfile was never rewritten.