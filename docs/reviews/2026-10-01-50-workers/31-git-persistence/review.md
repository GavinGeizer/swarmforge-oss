# SwarmForge Review — Automatic Git handoff, remote SHA verification, digest guards, clean-state checks, branch durability

- Target SHA: `d428e0f730ed5649485732e95d39c32f5d6a8895` (branch `feature/binary-config-serve-20260930`)
- Verified: disposable detached checkout at `/tmp/rev31` (`git rev-parse HEAD` = `d428e0f730ed5649485732e95d39c32f5d6a8895`)
- Assigned workspace `/workspace/repo` left unchanged at baseline `5672ead2a526e07fea9ed11e58b3725e42013527`, clean
- Reviewer: read-only. No source changes, no commits, no pushes.
- Verdict: **FINDINGS** (4). Note: this run exceeded its 30-minute review deadline and was finalized in bounded recovery mode; coverage of the in-scope files is complete for the code paths cited, but no further probes were run.

## Scope files read at target

- `src/providers/freestyle.ts` (`prepare`, `withGitAuth`, `pushBranch`)
- `src/git-handoff.ts` (`branchFor`, `githubInstallationToken`)
- `src/safety.ts` (`inspectPersistence`)
- `src/coordinator.ts` (`complete`, `applyControl` destroy path, `recover`)
- `src/config.ts` (`gitTree`, push-mode `superRefine`), `src/domain.ts` (`resultSchema`, `WorkerProvider.pushBranch`)
- `tests/git-handoff.test.ts`, `tests/safety.test.ts`, `docs/ARCHITECTURE.md`, `docs/ENVIRONMENT.md`, `docs/WORKER-PROTOCOL.md`

## Reachability precondition (common to F2/F3)

`prepare` and `pushBranch` execute on the worker VM via `vm.exec({ linuxUser: "root" })`
(`src/providers/freestyle.ts:130`, `:143`, `:256`). The worker OpenCode service unit
(`src/providers/freestyle.ts:~176`) declares no `User=`, so it runs as root in the same
workspace. Therefore the worker's own shell can write `${SWARMFORGE_WORKSPACE}/.swarmforge/git-base`
and run `git update-ref` in `${SWARMFORGE_WORKSPACE}/repo`. Every guard below is evaluated
against state the worker controls.

---

## F1 — HIGH: clean-state check passes when `git status` itself fails; uncommitted work is reported as durably persisted

- File/line: `src/providers/freestyle.ts:255` (inside `pushBranch`), reached from `src/coordinator.ts:696-703`
- Trigger: the worker's repository cannot produce a status listing — reproducibly, a truncated/corrupt
  `.git/index`, or `fatal: detected dubious ownership`. `git status --porcelain` exits 128 and writes
  nothing to stdout.
- Code trace: the command is
  `test -z "$(git status --porcelain --untracked-files=all)"`.
  Command substitution yields the empty string, `test -z ""` succeeds, `set -eu` sees a successful `test`
  and does not abort. The script continues to `git rev-parse HEAD` and pushes only committed content.
  `coordinator.complete` then unconditionally sets `persisted: true, dirty: false` on the result.
- Consequence: staged-but-uncommitted (or otherwise uncommitted) worker changes are never pushed, never
  committed, and are destroyed with the VM, while `get_worker_result.git` reports `persisted: true` and
  `dirty: false`. The durable-record contract in `docs/WORKER-PROTOCOL.md` ("SwarmForge … verifies the
  remote SHA") is reported as satisfied when it was not evaluated.
- Reproduction (local disposable repos under `/tmp/probe31/p4`, no credentials):
  create repo, commit, branch, commit a change, `git add wip.txt` (uncommitted), then
  `head -c 40 /dev/urandom > .git/index`. Running the exact `pushBranch` command body gives
  `git status` exit 128 with empty stdout, `CLEAN-CHECK PASSED`, `git push` succeeds creating the
  remote branch, script exit 0, and `wip.txt` content exists nowhere in the remote.
- Why existing guards do not prevent it: `src/safety.ts:38-39` handles exactly this class correctly
  (`code,out=git(...); if code!=0 or out.strip(): issues.append('dirty or unreadable Git workspace')`),
  showing the failure mode is known — but `pushBranch` never checks the status exit code.
  `tests/git-handoff.test.ts` exercises only a clean tree and a failing push; no test covers a
  nonzero-status `git status`.
- Recommendation: capture the status result and require exit 0, e.g.
  `st=$(git status --porcelain --untracked-files=all) || exit 1; test -z "$st"`, mirroring `safety.ts`.

## F2 — MEDIUM: `base_commit` is read from a worker-writable file, so the ancestry guard and `review_url` are forgeable

- File/line: `src/providers/freestyle.ts:255` (`base=$(cat ${workspace}/.swarmforge/git-base)`),
  file written at `:140-142`; guard `git merge-base --is-ancestor "$base" "$commit"` at `:255`;
  `review_url` built at `:268-270` from that value
- Trigger: the worker writes its own value into `${SWARMFORGE_WORKSPACE}/.swarmforge/git-base`
  (root-owned workspace, worker runs as root — see precondition above).
- Consequence: with `base` rewritten to the worker-chosen commit, `merge-base --is-ancestor` is
  trivially satisfied, so a history rewrite or unrelated-root push is accepted as a valid handoff.
  The reported `base_commit` is whatever the worker chose, and the GitHub `review_url` compare range
  becomes attacker-chosen — a reviewer following the supplied link can be shown an empty or wrong diff.
- Reproduction (`/tmp/probe31/p3`): real repo + real bare remote; after the worker change commit,
  `printf '%s\n' "$COMMIT" > .swarmforge/git-base` then the exact `pushBranch` body returns exit 0 and
  prints `base == commit`, i.e. a compare range of `<commit>...<branch>` while the true base differs.
- Why existing guards do not prevent it: the only check on `base` is the self-referential
  `merge-base --is-ancestor` in the same worker-controlled shell. `branchFor` guarantees branch
  uniqueness but not base authenticity. No test covers a modified `git-base`
  (`tests/git-handoff.test.ts:324` writes the file only in the happy path, as harness setup).
- Recommendation: treat `base` as untrusted — either record it in SQLite at `prepare` time and compare,
  or verify the remote-side ancestry, e.g. require `git ls-remote` base branch to be an ancestor of the
  pushed commit rather than trusting a workspace file.

## F3 — MEDIUM-HIGH: destroy-time safety accepts forged local remote-tracking refs, so unpushed commits are destroyed

- File/line: `src/safety.ts:40-41`
  (`code,out=git(repo,'rev-list','--count','--branches','HEAD','--not','--remotes')`),
  consumed at `src/coordinator.ts:802` and `:945-955` (the `recovery_required` guard on destroy)
- Trigger: the worker creates a local remote-tracking ref pointing at its own unpushed commit, e.g.
  `git update-ref refs/remotes/origin/swarmforge/<team>/<task>/<worker> HEAD`.
- Code trace: `git rev-list --not --remotes` subtracts everything reachable from any `refs/remotes/*`.
  The worker-created ref makes the unpushed commit look "represented by remote refs", so
  `out.strip() == '0'`, no issue is appended, and `inspectPersistence` returns `safe: true`.
  The destroy path then proceeds to `destroyWorker` with no `recovery_required`.
- Consequence: unpushed commits — the exact work the destroy guard exists to protect — are destroyed.
- Reproduction (`/tmp/probe31/sf`): cloned repo, local commit on the worker branch never pushed; after
  `git update-ref refs/remotes/origin/<branch> HEAD`, `rev-list --count --branches HEAD --not --remotes`
  prints `0`, and the `src/safety.ts` script extracted verbatim from the target and run against that
  tree prints `{"safe": true, "reason": "no obvious unpersisted work"}`. The bare remote still contains
  only `refs/heads/main`.
- Why existing guards do not prevent it: the coordinator's persisted check at `:930-941` only guards
  workers with an active dispatch or a result lacking `git.persisted`; a worker that never completed
  (e.g. failed turn with a local commit) reaches `inspectPersistence` with no independent proof.
  `pushBranch` itself creates a fabricated `refs/remotes/origin/<branch>` (`:255`), confirming these
  refs are treated as authoritative. `tests/safety.test.ts` uses injected doubles, not a real Git tree,
  so this is untested.
- Recommendation: verify durability against the actual remote (`git ls-remote <target>`) rather than
  local `refs/remotes/*`, or compare against a SwarmForge-recorded pushed SHA from SQLite.

## F4 — LOW-MEDIUM: workspace walk prunes directories, hiding nested repositories with unpushed work

- File/line: `src/safety.ts:31-36` (`dirs[:]=[d for d in dirs if d not in ['.swarmforge','node_modules','.cache']]`)
  and `src/safety.ts:28-29` (the `rev-parse --show-toplevel` early path that skips the walk entirely)
- Trigger A: the worker's Git repository lives under a pruned directory name (for example a repo created
  under `node_modules/` by a build step or vendoring task).
- Trigger B: the configured workspace is itself inside a Git working tree. `git -C <workspace>
  rev-parse --show-toplevel` then succeeds, `repos.add(top)` runs, and the `os.walk` that would find
  nested repositories never executes.
- Consequence: `inspectPersistence` returns `safe: true` while unpushed commits exist in the nested
  repository; the destroy path destroys the VM without `recovery_required`.
- Reproduction: Trigger A at `/tmp/probe31/nm` — a repo under `ws/node_modules/vendored` with an
  unpushed commit; the extracted target script prints `safe: true`.
  Trigger B at `/tmp/probe31/pr2` — workspace nested inside a pushed outer repo whose `.gitignore`
  covers the workspace; after pushing the outer repo, the extracted target script prints
  `safe: true` although `workspace/repo` holds an unpushed commit.
- Why existing guards do not prevent it: `.swarmforge` exclusion is intended, but `node_modules` and
  `.cache` pruning was added for walk cost and also skips any `.git` beneath them; the toplevel early
  path has no walk fallback. No test exercises a nested repository.
- Recommendation: after collecting `repos`, re-run the walk without the `node_modules`/`.cache`
  prune, or bound cost by depth/count rather than by name, and always walk for nested `.git` even when
  `rev-parse --show-toplevel` succeeded.

## Notes / non-findings

- No digest/pinning guard exists anywhere in the Git handoff path at this target: `pushBranch`
  verifies only commit-SHA equality via `git ls-remote` (`src/providers/freestyle.ts:255`). The only
  sha256 use in `src/` is the `request_id` idempotency fingerprint (`src/store.ts:72`). Recorded as
  context, not a defect: absence of a content digest means a rewritten object graph with the same SHA is
  the only gap, and Git's SHA-1/256 content addressing already covers it.
- `git ls-remote` parsing (`cut -f1` on the single requested `refs/heads/*`) is sound for the empty,
  one-line and multi-line cases tested locally.
- SSH/GitHub-App credential handling in `withGitAuth` (`:190-241`) removes `/opt/swarmforge/git-auth`
  and `/opt/swarmforge/git-secret` after every use and fails closed if removal fails; no credential
  literal appeared in any exec command in the reviewed paths, and none appears in this report.

## Tests actually run

Command (Bun 1.4.2 installed under `/tmp/bun142`, per toolchain note; snapshot `bun` is 1.3.14 and
cannot read `lockfileVersion: 2`):

```
cd /tmp/rev31 && /tmp/bun142/bin/bun install --frozen-lockfile   # exit 0
cd /tmp/rev31 && /tmp/bun142/bin/bun test tests/git-handoff.test.ts tests/safety.test.ts
```

Result: `11 pass, 0 fail, 38 expect() calls, Ran 11 tests across 2 files`, exit 0 (616 ms).
Log: `/workspace/.swarmforge/logs/rev31-githandoff-safety.log`.
`bun.lock` was not modified; `/tmp/rev31` is disposable and outside the source checkout.

Local probes (all under `/tmp/probe31`, disposable, no network, no real providers, no credentials):
F1 `/tmp/probe31/p4`, F2 `/tmp/probe31/p3`, F3 `/tmp/probe31/sf` (+ `/tmp/probe31/safety_run.py`),
F4 `/tmp/probe31/nm` and `/tmp/probe31/pr2` (+ `safety_nm.py`, `safety_pr2.py`).
The `safety.ts` embedded Python was extracted verbatim from the target file and run with only the
`roots` list substituted; all four reproductions are therefore the real target logic.

## Limitations

- Real Freestyle VMs, real OpenCode, real GitHub/SSH remotes and the smoke test were not exercised
  (out of scope; no real providers or credentials). Reachability of F2/F3 rests on the code-evidenced
  fact that the worker's service runs as root in the same workspace, not on a live VM probe.
- Full test suite was not run (only the two in-scope files); no compile/typecheck was run.
- This run exceeded its review deadline and was finalized in bounded recovery mode: report delivery is
  complete, but no additional probes beyond the ones listed were executed, and F1's non-zero
  `git status` variant `detected dubious ownership` was demonstrated only at the `git` level, not
  through `pushBranch` end to end.
- Sandbox artifacts under `/tmp/probe31` and `/tmp/rev31` were intentionally left in place rather than
  deleted; the source checkout is unaffected.

## Sanitization

No secrets, tokens, keys or credential-shaped URLs appear in this report. Example values are limited to
`sha`-shaped Git object IDs, `git@example`-style placeholders already redacted to hostnames like
`git.example`, and `example.invalid`/`example.test` mail domains. Redaction applied to this file and
`findings.json` reached a fixed point with no further credential-shaped matches.
