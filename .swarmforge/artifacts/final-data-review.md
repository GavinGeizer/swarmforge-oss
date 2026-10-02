# Final data-plane review — independent read-only review

- Reviewer: `w-9b0f79a2-3e68-4f3a-abf5-92c3a42dee6b` (`final-review-data-security`)
- Current run: `2d905e0a-18be-4382-a034-e4956a4a1d5a` (no other bootstrap run id is present under `/workspace/.swarmforge`)
- Reviewed head: `4449fcbbf2888ed17d5b5c763a76fbf589bba1c7`
- Reviewed branch: `swarmforge/artifact-salvage-20261001/harden-data-plane/w-c6875611-3237-4c55-aa4b-8e5c047e6efb`
- Base: `5672ead2a526e07fea9ed11e58b3725e42013527` (verified ancestor of the head, `git merge-base --is-ancestor`)
- Owned scope reviewed: `src/artifact-types.ts`, `src/artifact-store.ts`, `src/artifacts.ts`,
  `src/providers/artifact-helper.py`, `src/providers/artifact-helper.ts`,
  `src/providers/artifact-transport.ts`, `src/providers/freestyle.ts`, `src/files.ts`
  and the owned tests. Production code was **not** modified.
- Actual deps used: lifecycle `0e8c1eb800605d89361612eb4beaf0cfff7f3620`, API `bed317aa79e670d3b89d33d626bfc0faeeaf057c`
  (recorded for provenance only; neither branch was checked out in this workspace, so all statements below are about the
  reviewed head's own code and behaviour).
- Verdict: **CHANGES_REQUESTED** — one real (non-security) defect that loses Git diagnostics silently, plus two
  availability limitations. No security escape was found; the security-relevant review points below are all closed or
  demonstrably fail-closed.

## 1. Environment and commands actually run

Read-only worktree of the reviewed head: `git worktree add /tmp/opencode/review-data 4449fcb`.

```
/tmp/opencode/bun-linux-x64/bun install --frozen-lockfile     # bun 1.4.2, lockfile untouched
bun test tests/artifact-store.test.ts tests/artifact-transport.test.ts \
          tests/artifacts.test.ts tests/finalization-nested.test.ts tests/worker-files.test.ts
  -> 118 pass, 1 skip, 0 fail, 860 expect() calls, 26.83s          (owner's own suite, bun 1.4.2)
bun test /tmp/opencode/probes/review-probe.test.ts
  -> 9 pass, 0 fail, 56 expect() calls                             (my independent probes, see 3)
bun x tsc --noEmit            -> exit 0
bun x biome check src tests scripts -> "Checked 49 files ... No fixes applied."
git status --porcelain        -> empty (clean after the test run; see finding F6)
git ls-files | grep -c 'pyc\|__pycache__' -> 0
python3 probe scripts (real helper, real git)                     -> see 4 and 5
```

Bun 1.4.2 was fetched from the official release because the sandbox image ships bun 1.3.14, which cannot parse this
repository's `bun.lock` (`Unknown lockfile version`). No lockfile change was made. The owner's suite was run once, not
repeatedly; the rest of the full suite is the lead's call.

## 2. Closure of the six previous findings

| Previous finding | Status | Evidence |
| --- | --- | --- |
| Raw error text redacted before truncation; long-secret window sized from byte lengths, across **both** the storage path and the live-file transport | **Closed** | `ArtifactService.screened()` (`src/artifacts.ts:923`) screens the whole message and only then bounds it; `fail()` (`:912`) is the single durable-error path. `screeningWindow()` (`src/artifact-types.ts:369`) derives the overlap from the widest *byte* length across raw/URI/base64 variants and **refuses** anything wider than 65536 instead of under-screening. It is used by both `safeRead()` (`src/artifacts.ts:796`) and `WorkerFiles.readArtifact()` (`src/files.ts`). Probe 4 proves a 6002-byte secret (8004-byte base64 variant) is refused on a read whose window a fixed 4096 baseline would start *after* the secret, on both paths; `screeningWindow(["x".repeat(70000)])` throws. Probe 5 proves a secret crossing the 1000-character cut leaves no 20-character fragment in the record and is replaced by `[REDACTED]`. |
| Historic/superseded bytes stay faithful and every handed-out id stays readable | **Closed** | `beginAttempt()` (`src/artifact-store.ts:771`) gives a recapture a new record and its own key and never touches the record it replaces; `preserved()` (`:882`) marks the replaced row inside one transaction; `ingest()` (`src/artifacts.ts:825`) never deletes the replaced object. Probe 1: after a content change, the first record keeps `state='preserved'`, `sha256` equal to its own bytes, `superseded_by` set, its object still present under its own key and verifying, and `read(old_id)` returns exactly the old bytes; `list()` shows one current copy. Probe 2: a recapture that fails (source replaced by a symlink out of the root) leaves the previous copy current, unchanged and readable, and stores no new object. |
| Atomic unique-index publication; concurrent attempts; a crash mid-attempt leaves the previous copy visible | **Closed** | The publication predicate is a partial unique index (`src/artifact-store.ts:743`), and `preserved()` demotes other current rows *before* publishing inside one transaction, so two concurrent publishers cannot collide. `restoreSuperseded()` (`:956`) only restores a hidden row when nothing else is current. Probe 3: four concurrent real-helper preserves of one source → all resolve, exactly one current row, every returned id re-reads to its own `sha256`, `PRAGMA integrity_check` = `ok`, and a `GROUP BY ... HAVING count(*)>1` over current rows returns nothing. The crash case is a durable `preserving` row plus an untouched previous copy (owner's suite; verified consistent with `pending()`/`failed()` in probe 9, which shows a refusal leaves no `preserving` row behind). |
| Incoming directory: `lstat` not `stat`, special files refused, no `chmod`/write outside the root, real I/O failures fatal | **Closed** | `LocalArtifactStorage` constructor (`src/artifact-store.ts:93-137`) resolves the root once, creates `.incoming` after the root is checked, `requireRealDirectory()` uses `lstat`, and `assertIncomingIsSafe()` refuses a symlink or special file already planted there. `syncDirectory()` (`:147`) only tolerates the six "platform cannot fsync a directory" errnos and otherwise throws. Probe 6: with `.incoming` symlinked to an outside directory the constructor throws `/symlink/`, the outside directory's mode is unchanged, its contents unchanged, and the sentinel file untouched. With a real FIFO planted in a real `.incoming` the constructor throws `/special file/`. Probe 7: an injected `EIO` sync fails the `put` (and leaves `.incoming` empty, no half-written object), while `EINVAL` is tolerated and the `put` succeeds. |
| An injected `ArtifactStorage` foreign backend | **Closed** | `ArtifactService` takes the backend as a constructor argument (`src/artifacts.ts:179-188`). Probe 8 drives a fully in-memory object backend through `preserve` → `list`/`read`/`safeRead`/`download` → `stat`; the service's own local storage directory stays empty apart from the harness's own unused `.incoming`. |
| Generated guest-helper bytecode not tracked | **Closed** | `.gitignore` gained `__pycache__/` and `*.pyc`; `git ls-files` finds no tracked bytecode, and `git status --porcelain` in the worktree was empty after running the helper-backed tests. |

## 3. My independent probes (`/tmp/opencode/probes/review-probe.test.ts`, 9/9 pass)

1. superseded bytes/id readability; 2. failed recapture restores the previous copy; 3. four concurrent attempts plus
SQLite integrity and a duplicate-current-row query; 4. long-secret screening on the storage *and* live paths plus the
too-wide-secret refusal; 5. screening before truncation on a durable record error; 6. planted `.incoming` symlink and
FIFO refused without touching anything outside; 7. real directory-fsync failure is fatal, `EINVAL` tolerated, nothing
left in `.incoming`; 8. injected foreign storage backend; 9. refusals leave no `preserving` row and every record
terminal. All captures go through the real production helper (`src/providers/artifact-helper.py`) executed as a
subprocess by `tests/local-artifact-provider.ts`; nothing is a re-implementation.

## 4. New Git metadata gate — probes and impact assessment

Positive and negative controls with the real helper and a real repository (`/tmp/opencode/gitprobe/drive.py`):

```
[clean-repo]                ok=True  first=['8f948b8 IN-ROOT-COMMIT-SUBJECT']
[symlinked-.git]            ok=True  not-applicable=Git metadata is a symlink
[alternates-outside-root]   ok=True  not-applicable=alternates points outside the permitted root
[commondir-outside-root]    ok=True  not-applicable=Git metadata commondir points outside the permitted root
[symlink-inside-metadata]   ok=True  not-applicable=Git metadata contains a symlink
```

The gate refuses each escape and records the reason inside the captured bytes instead of trusting the repository. The
scope-small mitigation the task asked about is already in place: **anything that cannot be verified disables the Git
sources rather than being trusted** (`artifact-helper.py:1415-1438`), with system/global config off, hooks, external
diff and text conversion pinned, `--git-dir`/`--work-tree` pinned to the two descriptor-verified paths, a bounded whole
metadata walk, and a recursive alternates chain.

### The author's admitted residual TOCTOU is real but not blocking

`artifact-helper.py:1476-1489` re-verifies the repository after each Git command and refuses if it no longer verifies.
I attacked exactly that window with the shipped bytes:

- `race2.py` / `alt.py`: an `alternates` store outside the root plus an in-root `refs/replace` ref **does** make plain
  `git log` print the outside store's commit subject (`CANARY-OUTSIDE-SUBJECT-9f3a`), so the mechanism by which a won
  window would publish outside-root object content is genuine, not theoretical.
- `race3.py`: a hostile writer flipping `objects/info/alternates` in a tight loop for 40 real helper runs →
  **39 captures refused** (the post-check caught the change), **1 accepted, and that accepted capture contained no
  outside bytes**. `accepted_and_publishing_outside_bytes = 0`.
- Even a *won* window is not a general read primitive: what reaches the artifact is Git-object content from a store
  whose object ids the worker must already know (Git verifies object hashes on read), and a real guest worker cannot
  install a PATH shim as I could on this host. No coordinator-side secret is reachable from the guest at all.

**Conclusion: not blocking, and no code change requested for it.** Static validation is not being presented as proof
that the root is safe; the claim here is narrower and evidenced: under aggressive tampering the gate failed closed on
every capture that carried outside bytes.

## 5. Findings

### F1 — CHANGES REQUESTED (real, reproducible, availability/diagnostics completeness, fail-closed)

`_walk_metadata()` leaks one file descriptor per directory it walks, and a repository that trips over it loses all Git
diagnostics while the record still claims to be complete.

- Cause: `artifact-helper.py:1033` calls `os.scandir(open_at(parts))`. `os.scandir` duplicates the descriptor it is
  given and never closes it; `handle.close()` closes only the duplicate. (`artifact-helper.py:1026-1029` correctly
  closes its own descriptor, so the leak is only on the line above.)
- Evidence 1 (`/tmp/opencode/probes/fdleak2.py`, production function, shipped bytes): a metadata tree of 400 sibling
  directories leaks **402** descriptors; the same walk with `RLIMIT_NOFILE=200` dies with
  `OSError: [Errno 24] Too many open files: '/'`.
- Evidence 2 (`/tmp/opencode/gitprobe/emfile2.py`, real helper + real repository + 400 directories under `.git/refs`,
  all well inside `METADATA_MAX_ENTRIES=20000` and `METADATA_MAX_DEPTH=8`):

  ```
  RLIMIT_NOFILE=4096  ok=True complete=True sources=[{'label':'git-log','exit':0}]  commit captured: True
  RLIMIT_NOFILE=300   ok=True complete=True sources=[{'label':'git-log','skipped':'not_applicable',
                       'reason':'Git metadata directory is not inside the permitted root'}]  commit captured: False
  ```

  Two distinct defects compound here: (a) the walk raises `HelperError` on `EMFILE`, which
  `_walk_metadata` maps with a blanket `except HelperError` to *"is not inside the permitted root"* — an environment
  failure reported as a security verdict; and (b) `op_capture` records a `GitRefusal` as `skipped: not_applicable`
  **without** setting `stats["skipped"]`/`stats["incomplete"]`, so `complete` stays `true`, the transport's
  `incomplete` label is never set (`src/providers/artifact-transport.ts:446-455`), and a `git-report.txt` containing no
  Git information at all is stored as a complete report.
- Impact: any guest with a normal 1024-descriptor limit and a repository with more than roughly a thousand
  directories under `.git` (many refs directories, submodules, linked worktrees) silently loses Git diagnostics, and
  the artifact record cannot be distinguished from a complete capture. Not a security escape: the capture is refused or
  disabled, never published with unverified bytes.
- Scope-small fix: in `_walk_metadata`, keep the descriptor and close it (`fd = open_at(parts); handle =
  os.scandir(fd); os.close(fd)`), and split the refusal reason so only `ENOENT`/`ENOTDIR`/`ELOOP` become
  *"not inside the permitted root"* while `EMFILE`/`ENOMEM`/`EACCES`/`EINTR`/`EBADF` become an *incomplete* condition
  that reaches `stats["incomplete"]` so the artifact is labelled `incomplete` rather than complete.

### F2 — Limitation, no change requested: legitimate deployments that lose Git diagnostics

`git_repository()` requires `.git/objects` and `.git/refs` to be real directories inside the root and refuses any
symlink inside the metadata tree. So a repository whose `.git` is a `gitdir:` pointer file (every linked worktree and
every submodule), or whose object store is a symlink to a shared store inside the workspace, is reported
`not-applicable` instead of being described. That is fail-closed and safe, but it should be documented in
`docs/ARTIFACTS.md` (API/lifecycle documentation owner) as "Git diagnostics require a plain `.git` directory with
`objects` and `refs` inside the workspace". A probe with `.git` as a symlink shows the intended behaviour; the
linked-worktree case is the practical consequence.

### F3 — Hardening note (not blocking)

`ArtifactService.attempt()` (`src/artifacts.ts:337-344`) re-throws the original error unscreened when the record is
already terminal, while `fail()` is careful to screen. In practice the only text that can reach there is the helper's
own 512-byte rule message (`MAX_ERROR`), which never contains file contents, and both API surfaces wrap responses in
`redactor.value(...)`, so this is defence in depth rather than a live leak. Worth aligning for consistency.

### F4 — Cosmetic

Duplicated comment block at `artifact-helper.py:51-57` and a duplicated `-c core.hooksPath=/dev/null` in
`GIT_PINNED` (`artifact-helper.py:921,925`).

## 6. Security checklist (data-plane files)

| Property | Assessment |
| --- | --- |
| Direct-path descriptor walk from `/`, no symlinks, no check-then-use | `open_at`/`open_dir_at`/`open_regular_at` step from `/` with `O_NOFOLLOW|O_DIRECTORY` and re-check `S_ISDIR` on each descriptor; `step_refusal()` distinguishes a symlink (refusal) from a type mismatch, which is what stops a caller treating an escape as a harmless absence. Verified by probes 4/6/8 and by the owner's mid-capture swap test. |
| Depth / bytes / entry budgets | Enforced before allocation (`scandir_bounded`, `require_int`, per-file and total byte caps, `maxDepth` checked on both the requested path and every discovered child). Snapshot refuses rather than publishes a truncated archive (`src/artifacts.ts:444`). |
| Special files | Regular files only, checked on the pinned descriptor with `O_NONBLOCK` so a planted FIFO cannot park the helper. |
| Archive entries | `archive_name_ok()` plus the length check on every member name; `REGTYPE`/`DIRTYPE` only, `uid/gid=0`, empty uname/gname, no link entries, never extracted anywhere. |
| Raw capture streaming, bounded memory | The guest stages a private copy and hashes while copying; bytes travel over the provider's binary stream and are hashed again from the written descriptor (`ArtifactStorage.digest`); cancellation races the pending read, `cleanup()` is idempotent, and a failed put removes only its own key. Owner suite: a large file streams without truncation or whole-file buffering. |
| Real helper, no model/OpenCode dependency | `artifact-helper.py` imports only the Python standard library; `artifact-helper.ts` imports only `node:fs`/`node:url`; nested worker output is collected as archives (owner's `tests/finalization-nested.test.ts`, which I ran) rather than through a model. |
| Resumable SQLite metadata | `pending()` finds interrupted `preserving` rows; every exit path settles the record (probe 9); content-free events are bounded per artifact; no artifact bytes are ever recorded. |
| Storage root is coordinator-private | 0700 root resolved once through `realpath`, 0600 objects created `O_EXCL`, publication by rename with the directory fsynced before and after, `O_NOFOLLOW|O_NONBLOCK` on every read and a regular-file check on the descriptor. `sweepStale` unlinks inside `.incoming` only and tolerates races. |
| Screening | Whole-text screening, byte-sized overlap derived from the live secret set, refusal rather than under-screening, raw reads and authenticated downloads deliberately unscreened and bounded/streamed. |

## 7. Verdict

**CHANGES_REQUESTED** on head `4449fcbbf2888ed17d5b5c763a76fbf589bba1c7`: fix F1 (close the descriptor in
`_walk_metadata` and stop reporting an environment failure as "not inside the permitted root" with `complete: true`).
F2 should be documented by the docs owner; F3/F4 are optional. No security escape was found and none of the six
previous findings is still open. Re-review after F1 is fixed is limited to the helper's metadata walk and the
incomplete labelling; the rest of this review stands.