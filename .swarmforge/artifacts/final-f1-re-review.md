# Narrow F1 re-review — `8fb471ac4f5418ddffb844f9d0fba90420728b84`

- Reviewer: `w-9b0f79a2-3e68-4f3a-abf5-92c3a42dee6b` (`final-review-data-security`)
- Run id reported: the dispatch that asked for this re-review carries **no run UUID** in its text, and no run id exists in
  the environment (`env | grep -i run`) or under `/workspace/.swarmforge` (only `git-base` and my own `result.json`).
  The only run identity available is the one in my worker header for this dispatch,
  `2d905e0a-18be-4382-a034-e4956a4a1d5a`, which is what I report. I did not invent a new one.
- Requested head: `8fb471ac4f5418ddffb844f9d0fba90420728b84` on
  `swarmforge/artifact-salvage-20261001/harden-data-plane/w-c6875611-3237-4c55-aa4b-8e5c047e6efb`

## Verdict: cannot review — the requested head is not published (no approval, no verdict)

```
git fetch --no-tags origin                       -> fetched everything new on origin; harden-data-plane unchanged
git ls-remote origin 'refs/heads/.../harden-data-plane/*'
  -> 0b398ff2a0ab14de88c202dcf2686763744cf4c2    refs/heads/swarmforge/artifact-salvage-20261001/harden-data-plane/w-c6875611-3237-4c55-aa4b-8e5c047e6efb
git ls-remote origin | grep 8fb471a              -> none
git fetch origin 8fb471ac4f5418ddffb844f9d0fba90420728b84
  -> fatal: remote error: upload-pack: not our ref 8fb471ac4f5418ddffb844f9d0fba90420728b84
git cat-file -t 8fb471a                          -> fatal: Not a valid object name
git rev-list --all | grep -c ^8fb471a            -> 0
```

The branch tip that is actually reachable is still `0b398ff2` — the head I approved except for F1. I will not report an
approval or a defect list for bytes I have not read.

## What I did verify in this window

The standing state of F1 at the reachable tip `0b398ff2`, re-measured now rather than quoted from the earlier pass:

```
python3 /tmp/opencode/probes/fdleak2.py     # production helper function, shipped bytes of 0b398ff
  sibling directories walked: 400 (depth 2, inside METADATA_MAX_ENTRIES/DEPTH)
  fds leaked by one _walk_metadata call: 402
  --- same walk with RLIMIT_NOFILE=200 ---
  OSError: [Errno 24] Too many open files: '/'
git show 0b398ff2:src/providers/artifact-helper.py | grep -n "os.scandir(open_at"
  1033:        handle = os.scandir(open_at(parts))
```

So F1 is still exactly as reported at the only head I can see: the descriptor passed to `os.scandir` is duplicated and
never closed, and a resource failure during the metadata walk is turned into "Git metadata directory is not inside the
permitted root" and recorded as `skipped` with `complete: true`.

## Acceptance criteria for `8fb471a` (so the next window is a fast approve/deny)

A head matching all five is APPROVED by me; each item is checkable in one low-RLIMIT run.

1. `_walk_metadata` closes the descriptor it hands to `os.scandir` (keep the fd, `os.close(fd)`, or use a context
   manager), so a 400-directory metadata walk leaks 0 descriptors. Proof: my `fdleak2.py` reports `0` (or ~0) instead of
   `402`.
2. The walk distinguishes an environment failure from a security verdict: `EMFILE`, `ENOMEM`, `EACCES`, `EINTR`,
   `EBADF` must **not** become `GitRefusal("... not inside the permitted root")`; only `ENOENT`, `ENOTDIR`, `ELOOP`
   (and a symlink/special file) justify that refusal.
3. Such a failure makes the capture *incomplete* (`stats["incomplete"]`, hence `complete: false`), so the transport sets
   `ArtifactTransfer.incomplete` (`src/providers/artifact-transport.ts:446-455`) and the stored record carries
   `incomplete`, instead of publishing a "complete" Git report that contains no Git information.
4. A real-helper regression test for it: run the shipped helper as a subprocess against a real repository and drive the
   failure for real (a low `RLIMIT_NOFILE` on the helper process, or an injected fault at the fault point), asserting
   `complete: false` — not a re-implementation and not a mocked helper.
5. No regression in the positive path: a normal repository still captures (`complete: true`, commit/diff present), and
   the existing negative controls still refuse (symlinked `.git`, outside-root alternates, outside-root `commondir`,
   symlink inside the metadata).

Everything else from the previous passes stands and is out of scope for this window: F0 closed at `0b398ff` and
unchanged here; F2 documentation note (plain `.git` with `objects` and `refs` inside the workspace); F5 stated
assumption about `/opt/swarmforge` ownership; F3/F4 optional. No security escape has been found at any point.

## Housekeeping

- Read-only: no production code changed, no deployment, no credentials, no owner VM touched or destroyed — only `git
  fetch`, two detached read-only worktrees (`/tmp/opencode/review-data` at `4449fcb`, `/tmp/opencode/review-new` at
  `0b398ff`) and the low-RLIMIT probe against the shipped helper.