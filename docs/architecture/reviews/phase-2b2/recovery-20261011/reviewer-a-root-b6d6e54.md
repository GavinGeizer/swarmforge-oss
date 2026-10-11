# Independent root-test contribution review — b6d6e54

- Worker: `w-cf8f53a8-390e-4f5b-90d9-4759b856a37f`
- Task: `final-architecture-review-fresh`
- Run: `57d3768c-55a6-47ea-810b-d774e6a1ca5c`
- Bundle: `/tmp/root-final.bundle`, 2646 bytes, SHA
  `aa793c27debb97af1d52098eb66098336ff594dcb141cb86907329fb3683dd7c`
  (sha256 independently re-verified; `git bundle list-heads` = `b6d6e54… HEAD`)
- Requires: `157433166479c099a54cbee52ca9203dc722eb9f`
- Reviewed HEAD: `b6d6e54fb22be4dd026b3116a40e119b16b62774`
- Reviewed tree: `acaec7f9470368d9632c952e2fcea1e5b85b279e`
- Method: fetched the private ref into `/workspace/phase2b2-ready`
  (`refs/swarmforge/root-final`), created an isolated exact worktree at
  `/workspace/root-final-wt`, inspected the full delta, and ran the targeted
  cases there. Read-only; no source edits, publication, merge, deploy, or VM
  deletion. Original report `.swarmforge/artifacts/review.md` and the correction
  companion `.swarmforge/artifacts/review-correction.md` are preserved.

## Verdict: APPROVED

The contribution is test-only, confined to `tests/hosted-supervisor.test.ts`,
and correctly closes the L1 coverage gap. It changes no production or
configuration source.

## Delta inspected — `1574331..b6d6e54` (full range)

`git diff --name-status 1574331..b6d6e54` = exactly one file:

```
M  tests/hosted-supervisor.test.ts   (111 insertions, 6 deletions)
```

No other file changed. Three commits:

- `18ae36d` "bind concurrent launch gate to task identity, add reversed-order
  regression": replaces the invocation-count gate (`calls === 2`) in the
  concurrent-journal test with a task-identity gate (`worker.task_id ===
  second.task_id`), and adds a second concurrency regression
  ("concurrent task journals remain correctly bound when the first ACK waits for
  the second") whose provider waits for the other task and whose fixture gates
  the first task's ACK behind the second task's ACK.
- `aa2aad9` "correct concurrent-launch wording to claim accuracy": pure
  comment/name wording fix; removes the overstated "reversed launch order" claim
  and renames `ReversedProvider` → `GatedProvider`. No behavioral change.
- `b6d6e54` "restore 1h absolute boot-deadline bound in env/logs test": restores
  the L1 assertion (below).

## L1 confirmed closed

`tests/hosted-supervisor.test.ts` (env/logs test, ~line 2537) now contains:

```ts
expect(absoluteBootMs - bootBeforeLaunch).toBeLessThanOrEqual(3_600_000);
```

with `bootBeforeLaunch = hostedBootTimeMs()` captured immediately before
`startControlled`. This restores coverage of the production cap enforced at
`src/hosted-runtime.ts:239` (`absolute - boot > 3_600_000` throws) and mirrored in
the child at `src/hosted-child.ts:103`.

The rest of the env/logs contract is unchanged and intact:
- exact **5-entry** allowlist (`PATH`, `SWARMFORGE_HOSTED_ABSOLUTE_BOOT_MS`,
  `SWARMFORGE_HOSTED_DURATION`, `SWARMFORGE_HOSTED_LEASE_BOOT_MS`, `TZ`);
- raw-string shape `/^\d{1,16}$/` on both boot deadlines (rejects `1e2`);
- `Number.isSafeInteger` and positivity;
- `leaseBootMs > bootBeforeLaunch` and `leaseBootMs <= absoluteBootMs`;
- secret denials (`sfsuper_|sfexec_|provider-secret|model-secret|repo-secret`)
  in the child environment and in `spawnedCommands`.

## Independent execution (targeted, in the exact worktree)

| Test filter | Result |
| --- | --- |
| `bun test tests/hosted-supervisor.test.ts -t "concurrent"` | **3 pass, 0 fail** (58 filtered) |
| `bun test tests/hosted-supervisor.test.ts -t "runtime env and logs carry no bearer"` | **1 pass, 0 fail** (60 filtered) |

This matches the author's "1+3 pass" claim. The 3 concurrency tests are the two
journal-binding regressions plus the existing same-file duplicate-ACK test. Per
instruction the 244 s full root suite was **not** repeated; those targeted cases
and the previously verified full-suite results remain the evidence.

Gate-reachability check: the supervisor stages the local worker with
`task_id = hosted task_id` (`src/hosted-supervisor.ts:109-136`; `Worker.task_id`
declared in `src/domain.ts:239`), and the new fixture test asserts
`secondAcked === true`, confirming the identity-bound gates actually fire rather
than passing trivially.

## Review of the gate fix (correctness)

- The prior count-based gate (`this.calls === 2`) coupled the delay to
  invocation order, which is not guaranteed under concurrent ACK/staging. The
  new `worker.task_id` binding is order-independent and cannot deadlock the
  second call; each path still terminates (`secondGate` is released, other path
  sleeps 50 ms).
- Both regressions assert per-task journal identity: each mapping's `child_pid`
  equals its own provider record pid, the two pids differ, and
  `identityMatches` holds for both records.
- `aa2aad9` removes a claim ("deterministically forcing the reversed launch
  order") that the fixture does not actually guarantee; the retained assertion
  is "the first ACK actually waited for the second", which the fixture does
  prove. This is a wording accuracy correction, consistent with its independent
  approval by B.

## Limits

- No production/config source changed, so no production authority, audience,
  migration, or runtime behavior is affected by this contribution.
- This approves the b6d6e54 root-test contribution only. Overall Phase 2B.2
  remains **INCOMPLETE** pending the actual final combined source+docs bundle and
  the final A/B/C review.
- The restored assertion covers the default launch budget observed by the test;
  it does not by itself qualify live workerd/D1 clock behavior or other open
  release gates.
