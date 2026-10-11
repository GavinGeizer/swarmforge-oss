# Correct root concurrent-launch test + env-contract coverage — current

## Dispatch / scope
- Current run: `c1b694e6-ae40-4bfa-81f3-ff692322fe61`.
- Sole owned file: `tests/hosted-supervisor.test.ts`; production read-only.
- Workspace `/workspace/phase2b2-ready`, branch `phase2b2-diagnostic-repair`,
  base tree `157433166479c099a54cbee52ca9203dc722eb9f`.

## Commits (branch, oldest -> newest)
1. `18ae36d` — fix the root two-task gate/order test: rebind the delay gate to task identity and add
   a regression (intro at 18ae36d; wording later corrected). Report preserved:
   `artifacts/change-summary-18ae36d-original.md`.
2. `aa2aad9` — claim-accuracy wording correction (no reversed OS launch/delivery claim).
   `artifacts/correction-companion-aa2aad9.md`.
3. `b6d6e54` — restore the 1h absolute boot-deadline bound dropped by env refinement `1830b06`.
   `artifacts/correction-companion-b6d6e54-env-deadline-bound.md`.

## Fix 1: root cause + repair (18ae36d)
The failing test's `DelayedProvider` gated its delay on the provider invocation COUNT (`calls === 2`).
`HostedSupervisor.ackAndStart` can reach `provider.startControlled` for the two concurrent tasks in
either order; when the intended-first task was the second invocation it awaited `secondGate`, but the
test releases `secondGate` only after `await firstLaunch` -> circular wait -> reported `5000.50ms`
timeout. Production is correct: every `ackAndStart` passes its own `journalStart` closure bound to
that `task_id`. Red-before proven deterministically out-of-source (5000.82ms timeout, killed 1 dangling
process): `artifacts/diagnostic-red-count-based-gate.log`.

## Fix 3: restored env-contract assertion (b6d6e54)
`1830b06` dropped `expect(absoluteBootMs - hostedBootTimeMs()).toBeLessThanOrEqual(3_600_000)`.
Restored, measured from the pre-launch captured boot:
`expect(absoluteBootMs - bootBeforeLaunch).toBeLessThanOrEqual(3_600_000);`
No relaxed cap/slack, no new timeout; exact 5-entry allowlist, raw-string syntax, captured
pre-launch boot, lease ordering, and secret absence assertions unchanged.

## Verification
- `bun test tests/hosted-supervisor.test.ts -t "runtime env and logs carry no bearer"` -> 1 pass / 0 fail
  (13 expect(), 119ms).
- `bun test tests/hosted-supervisor.test.ts -t "concurrent"` -> 3 pass / 0 fail (329ms).
- `bun run check` (tsc --noEmit && biome check src tests scripts) -> clean, 133 files.
- Prior full-file 61/61 and full-root 788 pass / 2 pre-existing skip / 0 fail at 18ae36d remain valid;
  full root deferred to final integration.

## Git / artifacts
- Final head `b6d6e54fb22be4dd026b3116a40e119b16b62774`, tree
  `acaec7f9470368d9632c952e2fcea1e5b85b279e`; parent `aa2aad9`; branch base `157433166479c099a54cbee52ca9203dc722eb9f`.
- Full incremental bundle requiring 1573: `artifacts/correct-root-concurrent-launch-full-requiring1573.bundle`.
- Reports/companions preserved as listed above; correction-only bundle requiring 18:
  `artifacts/correct-root-concurrent-launch-followup-aa2aad9.bundle`.

## Warnings
- Incidental out-of-scope flake (NOT the assigned test) under artificial 5x cloud load:
  `runtime env and logs carry no bearer...` read `/proc/<pid>/environ` empty because the child had
  exited under contention; passed 6/6 focused under the same load. Not patched here.
- 2 pre-existing skips preserved.
- `persisted=false` until SwarmForge verifies the branch push.
