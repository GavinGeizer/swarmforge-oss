# SwarmForge review — scope: process lock, stale lock, PID reuse, competing servers, DB ownership/paths

- **Target (exact)**: `d428e0f730ed5649485732e95d39c32f5d6a8895` (branch `feature/binary-config-serve-20260930`, msg "Bound compiled fixture teardown independently of test assertions")
- **Reviewer checkout**: disposable detached clone at `/tmp/opencode/r16/repo`, `git rev-parse HEAD` = `d428e0f730ed5649485732e95d39c32f5d6a8895`
- **Assigned workspace**: `/workspace/repo` left untouched at baseline `5672ead2a526e07fea9ed11e58b3725e42013527`, clean
- **Toolchain**: Bun 1.4.2 unpacked to `/tmp/opencode/bun142` (snapshot bun is 1.3.14 and refuses `lockfileVersion: 2`); `bun install --frozen-lockfile` succeeded, lockfile never rewritten
- **Verdict**: FINDINGS (3 LOW). No CRITICAL/HIGH/MEDIUM defect found in this scope.

## What the code does (verified by reading, not assumed)

`acquireProcessLock` (`src/runtime.ts:145-171`) is a real `flock(LOCK_EX|LOCK_NB)` via `bun:ffi`
(`src/runtime.ts:106-135`), not a PID file check:

- `mkdirSync(dirname(path), {recursive:true, mode:0o700})`, then `openSync(path, O_RDWR|O_CREAT|O_NOFOLLOW, 0o600)`.
- A failed `flock` throws `Another SwarmForge process owns this database` (`src/runtime.ts:151-154`).
- `namedHandle()` (`src/runtime.ts:136-144`) re-`stat`s the path and compares `dev`/`ino` against the
  held fd; a loser retries up to 8 times, so an unlink/recreate race cannot produce two owners on one inode.
- `unlock` unlinks the path (only if the fd still names it), then `flock(LOCK_UN)` + `close` (`src/runtime.ts:162-170`).
- The written PID (`src/runtime.ts:160`) is never read anywhere in `src/` — grep for lock readers returns nothing.

Ownership/ordering in `src/serve.ts`:

- `:121-122` refuses `:memory:`; `:126` builds the lock as `` `${config.SWARMFORGE_DB_PATH}.lock` ``;
  `:161` lock before `:162` SQLite; `:163-166` persisted-`instance_id` check.
- Rollback (`:140-157`, `:195-198`) is reverse-ordered and idempotent (`releasing ??= release()`),
  SQLite is closed before the lock is released, and `Coordinator.stop()` can only wait (its `idle`
  promise is always resolved by `wakeIdle`, `src/coordinator.ts:260-300`), so it cannot reject and mask
  the original startup error. `scripts/smoke.ts:19` also takes the lock before opening SQLite.
- Only `src/serve.ts` and `scripts/smoke.ts` open the database; `status`/`config` go over HTTP or are
  read-only, so they never take the lock (`src/cli.ts:203`, `tests/commands.test.ts:813`).

Consequences I verified as **correct** (no finding):

- Crash/SIGKILL leaves a lock file; the next start takes it (`flock` is kernel-released, PID content ignored).
- A stale lock file containing a *live, unrelated* PID does not wedge startup — the PID is never consulted.
- Refused contenders do not disturb the owner's lock file (content and mtime unchanged, reproduced).
- 5-way simultaneous acquire leaves exactly one owner; port conflicts, failed recovery and a foreign
  `instance_id` all release lock + SQLite + both ports.
- SQLite sidecar permissions are fine: `-wal`/`-shm` come out `0600` next to the `0600` DB, so the
  0755-pre-existing-parent-directory case is not an information leak (probe A/C).
- A `file:`-shaped DB path is treated by Bun as a literal filename, so no URI/lock desync exists.

## Findings

### 1. LOW — the single-owner lock is keyed to the configured path string, not to the database file

- **File/line (target)**: `src/serve.ts:126` (lock path = raw concatenation of the configured value),
  with `src/runtime.ts:150` and `src/serve.ts:163-166`.
- **Trigger**: the same database file reachable under two different configured paths — a symlink in the
  final path component (`SWARMFORGE_DB_PATH=/etc/sf/db.sqlite` → `/var/lib/swarmforge/swarmforge.sqlite`),
  a hardlink, or a bind mount of the same volume at two paths.
- **Consequence**: each spelling takes its own `flock` on its own `*.lock`, so two SwarmForge processes
  both declare ownership of one SQLite file. The second line of defence is inert: `SWARMFORGE_INSTANCE_ID`
  defaults to `"default"` (`src/config.ts:37-39`), so the persisted-owner check at `src/serve.ts:163-165`
  compares `"default"` with `"default"` and passes. Two coordinators then reconcile and act on the same
  durable worker rows (duplicate provisioning/dispatch/token writes). `busy_timeout=5000` + WAL
  (`src/store.ts:22`) prevent corruption, not double action.
- **Reproduction (ran, outside the source checkout)**: `/tmp/opencode/r16/probes/ownership.ts`
  (Bun 1.4.2). Holding `acquireProcessLock(<real>.lock)` and then calling
  `acquireProcessLock(<symlink-alias>.lock)` returned **ACQUIRED**, not refused; a `Store` opened on the
  alias read the row written through the real path and its own write was visible from the real path.
  A hardlink alias behaved identically. Control case: a symlinked *directory* alias correctly
  **REFUSED** (`Another SwarmForge process owns this database`) because both spellings resolve to one lock inode.
- **Why existing guards do not prevent it**: the path is never canonicalised — `host_path` is plain
  `text` (`src/settings/load.ts:376`) and `SWARMFORGE_DB_PATH` is only `z.string().min(1)`
  (`src/config.ts:77`); `O_NOFOLLOW` protects only the *lock* file's final component, not the DB path;
  and the recorded PID is never used for a second identity check. `tests/process-lock.test.ts` only ever
  uses one literal path (`:23`), so no test exercises an alias.
- **Recommendation**: make the lock identity follow the file, not the spelling — e.g. resolve
  `realpathSync(dirname(dbPath))` before deriving the lock, and/or record the database's `dev`/`ino` in the
  lock file at acquire time and refuse when a live lock names a different inode. Failing that, treat the
  documented "one server process per database" rule (`README.md`, `docs/ENVIRONMENT.md:61`) as a hard
  requirement and make the refusal message name the lock path so the alias is visible to the operator.
- **Confidence**: high that the lock split is real (reproduced); medium on operational likelihood, since
  it needs an aliased `SWARMFORGE_DB_PATH`. Severity is LOW because it is not reachable from the default
  configuration and the README already states the single-process rule.

### 2. LOW — the lock refusal carries no identity, although the holder PID is already recorded

- **File/line (target)**: `src/runtime.ts:153` (message) vs `src/runtime.ts:160` (PID written and never read).
- **Trigger**: any refused start while another process holds `<DB_PATH>.lock` — a healthy owner, a
  `smoke` run, or a process wedged after the forced-exit path (`src/serve-command.ts:120-130`).
- **Consequence**: the operator gets only `Another SwarmForge process owns this database`, with no lock
  path and no holder PID, even though the durable lock file contains the owner's PID specifically for
  this. Diagnosing a stale-vs-live lock means reading the file by hand.
- **Reproduction / trace**: grep over `src/` finds no reader of the lock file; the refusal string is the
  sole diagnostic. Reproduced in the ownership probe: a refused contender leaves the owner's PID content
  intact and readable, so the information exists at the moment it is needed.
- **Why existing guards do not prevent it**: nothing formats the refusal; `docs/SERVE.md:67` frames the
  recorded PID as stale-by-design, so no test asserts a diagnostic.
- **Recommendation**: include the lock path and the recorded PID in the refusal message (redacted like
  every other command line, per `src/serve-command.ts:38-53`).
- **Confidence**: high (code-evidenced; small operability impact).

### 3. LOW — `docs/SERVE.md` inverts the listener/interval order it specifies (documentation only)

- **File/line (target)**: `docs/SERVE.md:40` and `docs/SERVE.md:48` vs `src/serve.ts:141-146`.
- **Detail**: the rollback sentence says "flush and stop the periodic logger, stop the **metrics**
  listener, stop the **API** listener", and shutdown step 1 says "the readiness gate closes, **then** the
  log interval is cleared". The code does `clearInterval(logTimer)` first (`src/serve.ts:141`), then
  `gate.close()` (`:142`), then `api.stop(true)` (`:143`) and only then `metricsServer.stop(true)` (`:145`).
  The code order is the safer one (no flush can run after admission closes; the API stops before metrics).
- **Consequence**: no functional impact — a reader of the spec would mis-model the rollback and shutdown
  ordering this repo otherwise treats as a contract.
- **Why existing guards do not prevent it**: tests assert the *effects* (`existsSync(lock) === false`,
  `openDatabaseHandles === 0`, ports reusable), never the order, so the inverted prose is unchallenged.
- **Recommendation**: correct the two sentences to match `src/serve.ts:140-157`.
- **Confidence**: high (documentation-only, verified against the code).

## Tests and probes run

- `bun install --frozen-lockfile` (Bun 1.4.2, `/tmp/opencode/r16/repo`) — exit 0, 125 packages, lockfile unchanged.
- `bun test tests/process-lock.test.ts` — exit 0, **3 pass / 0 fail**, 11 assertions (632 ms).
- `bun test tests/serve.test.ts tests/commands.test.ts` — exit 0, **35 pass / 0 fail**, 334 assertions (10.2 s).
- Probes (outside the source checkout, `/tmp/opencode/r16/probes/`): `paths.ts` (dir/DB/sidecar modes, URI-shaped path)
  and `ownership.ts` (symlink/hardlink/dir-symlink aliases, refused-contender effect on the owner's lock file). Both exit 0.

## Limitations

- Scope-limited: no full-suite run (whole-suite reviewer's job) and no compile/packaging step.
- No real cloud/model provider was contacted; all server-level checks used the repository's fake
  provider/agent doubles via the existing tests.
- Filesystem-specific lock behaviour (NFS, FUSE, overlayfs) could not be exercised here; the possibility
  that `flock` is a no-op on some network filesystems is an unverified hypothesis and is **not** reported
  as a finding (`docs/ENVIRONMENT.md:61` already requires a persistent local volume).
- Finding 1 was demonstrated at the lock + SQLite layer, not by running two full `startServer` instances
  on aliased paths (that needs two live coordinators and is documented as unsupported).
- No secret files were inspected and no credentials appear in this report or in the logs.
