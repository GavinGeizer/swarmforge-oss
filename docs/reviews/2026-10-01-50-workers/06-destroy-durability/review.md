# SwarmForge review — target d428e0f730ed5649485732e95d39c32f5d6a8895

Verdict: **FINDINGS** (3: 1 HIGH, 1 MEDIUM, 1 LOW). No CRITICAL data-loss defect found in this scope.

- Target: `feature/binary-config-serve-20260930` @ `d428e0f730ed5649485732e95d39c32f5d6a8895`
  (verified `git rev-parse HEAD` in a disposable clone at `/tmp/opencode/rev06/target`).
- Assigned baseline in `/workspace/repo` was `5672ead`; it was left untouched and clean.
- Scope: normal/forced destruction safety, preservation checks, missing-VM handling,
  stale Git metadata, retryable destruction.
- Files read in scope: `src/coordinator.ts` (step/quiesce/teardown/applyControl/fail/runControl/
  recover), `src/safety.ts`, `src/store.ts`, `src/security.ts`, `src/domain.ts`,
  `src/providers/freestyle.ts`, `src/git-handoff.ts`, `src/config.ts`, `src/mcp.ts`,
  `tests/safety.test.ts`, `tests/lifecycle.test.ts`, `tests/helpers.ts`, `docs/*`.

## F1 — HIGH — persistence probe always reports unsafe when `SWARMFORGE_GIT_TREE` is a local path

- File/line: `src/safety.ts:14` (root added), with `src/safety.ts:28` and `src/safety.ts:35`.
- Trigger: `SWARMFORGE_GIT_TREE` set to an absolute local path (documented as supported:
  `docs/CONFIGURATION.md:79` "Clone URL, local path, or `none[:tree]`";
  `docs/ENVIRONMENT.md:15` "Git URL or local Git path"). The value is added to the scanned
  roots whenever it `startsWith("/")`, so the configured source tree is walked as if it were
  worker output.
- Consequence: `git -C <root> rev-parse --show-toplevel` fails on a bare repository, so the
  script falls into `os.walk` and every directory holds files outside a work tree → issue
  `files outside a Git repository` → `safe:false` **forever**. (A non-bare local path also
  fails, via `commits not represented by remote refs`, because the tree's own commits have
  no remote.) Effects: `applyControl` destroy (`src/coordinator.ts:952`) refuses every
  non-forced cleanup and parks the worker in `recovery_required` even when the workspace is
  pristine and fully mirrored; `fail()` (`src/coordinator.ts:802`) routes every failure into
  `recovery_required`, retaining billable VMs. The only exit is `force=true`, which skips
  *all* preservation checks (`src/coordinator.ts:912`), so operators are pushed toward
  destroying unverified.
- Reproduction (reproduced, local git only, no provider): real bare tree + clean clone,
  workspace status empty and `rev-list --branches HEAD --not --remotes` = 0:
  - `SWARMFORGE_GIT_TREE=<abs bare path>` → `{safe:false, reason:"files outside a Git repository"}`
  - `SWARMFORGE_GIT_TREE=<ssh URL>` (not absolute) → `{safe:true}`
  - `SWARMFORGE_GIT_TREE=<abs work tree>` → `{safe:false, reason:"commits not represented by remote refs"}`
  Probe: `/tmp/opencode/rev06/probes/safety-bare.ts` (exit 0).
- Recommendation: scan only roots the worker owns — `SWARMFORGE_WORKSPACE` and
  `result.git.workspace`. Treat the configured tree as read-only input (or detect
  `git -C root rev-parse --is-bare-repository` and skip it) instead of walking it.
- Why existing guards do not prevent it: `tests/safety.test.ts` drives
  `inspectPersistence` directly with `SWARMFORGE_GIT_TREE: "opaque-tree"` (helpers.ts) and a
  single workspace root, so the multi-root/bare path is never exercised; `tests/lifecycle.test.ts`
  uses `FakeProvider.dirty`, which fakes the probe verdict rather than the script.

## F2 — MEDIUM — a timed-out persistence probe makes a destroy un-settleable instead of refusing safely

- File/line: `src/coordinator.ts:944-951` (`await this.bounded(inspectPersistence(...))`, no
  `.catch`). Compare the identical call on the failure path at `src/coordinator.ts:788-798`,
  which *does* catch and converts it to `recovery_required`.
- Trigger: the guest's Git check runs longer than `SWARMFORGE_API_TIMEOUT_MS` (default 30000;
  `src/config.ts:89`). The script itself issues several `subprocess.run(..., timeout=15)`
  Git calls per root (`src/safety.ts:22-41`), so a large/unusual workspace on a slow guest
  can exceed the bound.
- Consequence: `bounded()` rejects on the *outer* promise, so `inspectPersistence`'s internal
  `catch` never runs; `step()` swallows it (`src/coordinator.ts:510-518`) and leaves
  `intent:"destroy"` durable. The destroy then retries on every poll tick
  (`src/coordinator.ts:340-353`) with no backoff and no terminal state; the VM stays retained
  and billable; `error` is the misleading "Provider or OpenCode operation failed; retrying
  within deadline" (the deadline is not even consulted while an intent is pending —
  `src/coordinator.ts:440-443`). `destroy_worker` returns success with the state unchanged and
  only `pending_control:"destroy"` (`src/security.ts:144`) as a hint.
- Reproduction (reproduced, fake provider, `SWARMFORGE_API_TIMEOUT_MS=40`, GIT_CHECK exec
  never settles): `control(destroy)` resolved without throwing, then 3 ticks →
  `{state:"running", intent:"destroy", error:"Provider or OpenCode operation failed; retrying
  within deadline"}`; the same timeout on the deadline path →
  `{state:"recovery_required", intent:null}`. Probe: `/tmp/opencode/rev06/probes/destroy-timeout.ts`.
- Recommendation: mirror the `fail()` handling — catch the bounded rejection and
  `store.transition(id, "recovery_required", { intent: null, error: "Persistence check
  timed out" })`, so an unverifiable probe refuses rather than loops.
- Why existing guards do not prevent it: `tests/lifecycle.test.ts:135` covers a failing
  `destroyWorker` (the later call), not a failing/hanging persistence probe, and no test
  asserts that a destroy settles into `recovery_required` when the probe is unavailable.

## F3 — LOW — a forced destruction leaves no API-visible trace that checks were skipped

- File/line: `src/security.ts:126-157` (`publicWorker` omits `force_destroy`; only
  `pending_control` is exposed at line 144) and `src/coordinator.ts:969-974` (the
  `destroyed` transition passes no marker; `store.transition` → `event` at
  `src/store.ts:166` records empty `data`).
- Trigger: any `destroy_worker(force=true)`; the CLI always sends `force:false`
  (`src/cli/client.ts:119`), so this affects MCP callers.
- Consequence: after the fact `get_worker`, `list_workers` and `get_worker_logs` cannot
  distinguish a verified destroy from an explicitly authorized loss, even though the flag is
  persisted on the record (`src/coordinator.ts:833`). For a control plane whose stated
  purpose is durability safety, an unauditable force is the one gap that matters most in
  incident review.
- Recommendation: expose `force_destroy` from `publicWorker` and include it in the
  `worker.destroyed` event data.
- Why existing guards do not prevent it: the flag is internal-only; no test asserts anything
  about forced-destroy observability.

## Checked and found sound (no finding)

- Missing-VM handling: `vmMissing()` (`src/coordinator.ts:749-754`) only trusts a provider
  404 (`src/providers/freestyle.ts:92`); `getWorker` re-throws every other error, and
  `destroyWorker` swallows 404 only (`src/providers/freestyle.ts:285-291`), so destroy is
  idempotent without mistaking an ambiguous probe for absence. A confirmed-absent guest skips
  retention checks and settles in one call (`src/coordinator.ts:929-961`).
- Gate ordering is fail-safe: the active-dispatch / `git.persisted` check
  (`src/coordinator.ts:930-934`) runs before the guest probe, and `force` is re-patched per
  call (`src/coordinator.ts:833`) so a pending non-forced destroy cannot inherit force.
- Stale Git metadata: `persisted:true` is only set after a verified push
  (`src/coordinator.ts:697-703`), and the guest-side probe independently re-verifies
  `status --porcelain` and `rev-list --branches HEAD --not --remotes`
  (`src/safety.ts:39-41`), so a stale `persisted` flag from an earlier run is backstopped.
  Documented limitation ("remote refs are a hint, not proof", `src/safety.ts:6`) is not a defect.
- Intended `recovery_required` refusals (paused VM, no branch handoff, dirty workspace) do not
  delete the VM; `force=true` remains the explicit escape hatch (`src/coordinator.ts:912`).

## Tests / probes

- `bun test tests/safety.test.ts tests/lifecycle.test.ts` (Bun 1.4.2 at
  `/tmp/opencode/rev06/bun142/bun`, deps installed in the disposable clone with
  `--frozen-lockfile`; lockfile untouched): **36 pass, 0 fail, exit 0**.
- `bun run probes/safety-bare.ts` → exit 0 (F1 evidence).
- `bun run probes/destroy-timeout.ts` → exit 0 (F2 evidence).
- No full suite run (out of scope for this reviewer); no compilation; no real provider,
  network, VM or credential use — `FakeProvider`/`FakeAgent` and local `git` only.

## Limitations

- F1 is reproducible only for absolute local tree values; GitHub/SSH clone URLs (not starting
  with `/`) are unaffected. Not exercised: a mounted bare tree inside a guest (the path
  presence on the guest is deployment-specific).
- F2 was reproduced by simulating an unresponsive guest probe, not by a genuinely large repo.
- F3 is code-evidenced only (no probe).
- Deliberately not assessed: reconciliation/orphan adoption, cancel/pause semantics, quota
  accounting, config/packaging/CLI surfaces (other reviewers' scopes).

Reviewer experiments live only under `/tmp/opencode/rev06/` (disposable clone + probes).
No source file in `/workspace/repo` was modified, committed or pushed.