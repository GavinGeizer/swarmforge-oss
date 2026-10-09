# Reviewer A independent child watchdog correction review

Reviewed production correction SHA `1a2502a1073a74c07f86d94641cfc209778d7a53` against original integrated `f1d0526c5f60261f77e8a0c636f8474a5309826d`, at `/tmp/swarmforge-phase2b2-watchdog`. Original report `/tmp/phase2b2-final-review-a.md`, original probes and all failed logs remain preserved. Reviewer did not implement the correction or edit candidate source/tests/helpers/configuration. No SwarmForge, VM, remote operation or infrastructure CLI was used.

## Verdict

**A-H1 is corrected for the independently reproduced supervisor-stall failure. Narrow correction approved; broader acceptance remains incomplete.** No new high/critical defect was reproduced or identified in the production diff. Successful renewable long execution and malformed/buffered renewal IPC still require unrestricted actual-pipe verification. This review is not final integrated three-review signoff or a green full-suite claim.

## Production source assessment

The child now receives numeric initial lease and immutable absolute boot-clock deadlines before spawn, alongside the requested workload duration. Missing/malformed/stale initial authority exits before work. Lease expiry is enforced by a child-local timer, independent of the stalled supervisor. The whole workload duration remains separate, so a short lease cannot silently truncate execution and then count as completed.

Validated renewals travel over the existing private stdin pipe as bounded numeric frames. The child validates safe integer bounds, finite absolute deadline, unchanged absolute task deadline, current previous lease and new lease before accepting a refresh; delayed/buffered refreshes cannot reopen an expired lease. EOF/error still stops execution. The provider waits for the write callback and rejects old-lease expiry afterward; the supervisor rechecks current run, durable stop state and previous local expiry before publishing its own renewed timer. The delayed callback regression independently passes, but uses an explicit callback transport mock and does not establish working actual pipe delivery.

Child lease expiry exits code 4 and maps to cancelled, preserving durable PID/identity journals until actual OS proof. Natural whole-duration exit remains completed. The corrected OS-proof probe independently confirms cancelled completion, retained PID and stop confirmation after a stalled supervisor resumes.

The shared Linux `/proc/uptime` clock is appropriate for crossing process boundaries; process-relative Bun clocks are not. Parent conversion subtracts 20ms, child readings add 10ms, conservatively accounting for the uptime field's 10ms resolution. Unreadable/malformed boot clock fails closed. Independent clock evidence `/tmp/phase2b2-final-review-a-watchdog-clock-probe.ts` and `.log`:

- Parent before: boot 485567.09, hrtime 7226527, performance 7.238014.
- Child: boot 485567.10, hrtime 4890740, performance 4.901085.
- Parent after: boot 485567.10, hrtime 14847186, performance 14.848983.

The child's hrtime is earlier than the parent's pre-spawn hrtime, despite later execution, while boot readings track the shared host clock. No wall-clock deadline is sent as a process-relative monotonic timestamp.

## Independent production stall verification and metric correction

The original production stall2 script was copied with **imports only** changed to the corrected worktree: `/tmp/phase2b2-final-review-a-watchdog-original-probe.ts`, output `.log`, exit 0. It still prints `childAliveAfterExpiry:true` because its original metric was `kill(pid,0)`, which sees an unreaped zombie while the supervisor is stalled. This metric alone cannot distinguish active execution from a stopped child. The original report and logs are preserved; do not read that field alone as proof that this correction failed.

A separate companion `/tmp/phase2b2-final-review-a-watchdog-osproof-probe.ts` adds actual `/proc/<pid>/stat` observations and assertions, preserving the actual production Worker, SupervisorClient, normal 30s lease, 120s runtime/45s duration, 10s pre-ACK wait, normal safety/minimum defaults and real child. It requires an executing child before the stall, then absent/zombie after actual cloud expiry, cancelled completion and trusted stop proof. Exit 0; `/tmp/phase2b2-final-review-a-watchdog-osproof-probe.log`:

```json
{"claimLeaseRemaining":19993,"taskRemaining":109980}
{"phase":"before_stall","pid":36,"procState":"R","leaseRemaining":19953}
{"phase":"after_stall","pid":36,"procState":"Z","nonexecuting":true}
{"completion":"cancelled","stopConfirmed":true,"journalRetained":true}
{"leaseExpiresAt":1791589373718,"observedWall":1791589378051,"expiredCloudLease":true,"expiredLocalLease":true,"childAliveAfterExpiry":true,"childPid":36}
```

The final legacy PID field is true for a zombie, whose actual state shows it cannot execute. Actual corrected child execution stopped by lease expiry independently of the blocked parent. This is production-handler SQLite/in-process-transport evidence, not D1/workerd/TCP.

**Rigorous frozen baseline RED reproduced.** `/tmp/phase2b2-final-review-a-frozen-baseline-osproof-probe.ts` points at a private `git archive f1d0526c5f60261f77e8a0c636f8474a5309826d` snapshot `/tmp/phase2b2-final-review-a-baseline-f1d`; dependencies are symlinks to the unchanged existing installation. Git blob hashes of all three runtime production files were checked against f1d exactly. Probe output `/tmp/phase2b2-final-review-a-frozen-baseline-osproof-probe.log`, exit 1:

```text
{"claimLeaseRemaining":19992,"taskRemaining":109980}
{"phase":"before_stall","pid":37,"procState":"S","leaseRemaining":19980}
AssertionError: child still executing: S
```

The assertion immediately beforehand establishes that actual cloud lease expiry had passed. The real original child remained in sleeping/executable state S, rather than stopped state Z/absence, whereas the corrected production companion proves Z, cancelled completion, retained journal and actual stop proof. This resolves the original PID-metric ambiguity with an unchanged stronger test against both source versions. The original reported A-H1 remains a substantiated failure; its original kill-zero metric alone was weaker than this retained RED proof.

## Fresh verification and limits

- `bun test tests/hosted-child-lease.test.ts`: **9 pass / 5 fail / 17 assertions**, `/tmp/phase2b2-final-review-a-watchdog-child-tests.log`. Passing cases cover real blocked-parent expiry, delayed startup/expired initial authority, missing/malformed numeric initial authority, late renewal after child expiry, parent EOF, and full short-duration completion. Failing retained cases are successful 31s renewals, malformed renewal IPC (three inputs), and delayed/buffered renewal IPC. In this environment pipe writes result in child EOF (exit 3); these failures do not establish receipt/validation of those frames. No assertions were deleted, skipped or relaxed.
- Focused supervisor stall and delayed callback tests: **2 pass / 0 fail / 8 assertions**, `/tmp/phase2b2-final-review-a-watchdog-supervisor-tests.log`. These are explicit selected tests, not a full suite. The callback test mocks IPC completion delay.
- Actual production Worker/client/Bun bridge `bun test apps/cloud/test/hosted-bun.test.ts`: **3 pass / 0 fail / 34 assertions**, `/tmp/phase2b2-final-review-a-watchdog-bridge.log`. Includes full short-child completion/settlement, actual cancellation with capacity retained until stop and ambient secret exclusion, and stable cross-call admission replay. This is SQLite/in-process transport, not live D1/TCP.
- Root `bun run check`: exit 0, 133 files, `/tmp/phase2b2-final-review-a-watchdog-check.log`. This is type-check/style verification, not infrastructure proof.
- Author's final full suite was read as background, not independently certified: 693 pass, 86 fail, 2 existing skips, 1 error. Original unrestricted verification gates remain open. No claim that all failures are exclusively environmental is made.

## Exact-source provenance and fixture follow-up

The worktree started at exact clean 1a2502a. During this independent review the author added the required initial numeric deadline environment to the existing compiled-child CLI test, retaining code-0 and stderr assertions. It was committed as `f24b4a8380dbd4082b2c2b47b1bf0f87f6a41091` with evidence/docs. This is a legitimate fixture adaptation to the new child contract, distinct from a permission/pipe failure. `git diff 1a2502a..f24b4a8 -- src` is empty. The production source and focused watchdog tests/probe imports reviewed and executed therefore remain exactly the 1a2502a correction, despite the later fixture/evidence-only HEAD. Reviewer made no candidate edits. This report does not pretend the entire checkout remained frozen at 1a2502a.

Remaining acceptance gates: unrestricted real renewal pipes including >initial-lease task completion and late/malformed/buffered frames; protected on-disk journal/credential recovery; compiled CLI and TCP; real workerd/D1; full required suites; final integrated three independent reviews. Keep customer/untrusted execution disabled until all required gates are satisfied.

## Excluded moving-checkout baseline attempt

`/tmp/phase2b2-final-review-a-baseline-osproof-probe.ts` and its `.log` were an attempted baseline companion pointed at the original integration path. That checkout advanced to `5cea3ef5011c8297d909d3824a4c58342915a8db` while review continued; it contained the corrected child. Its PASS is **excluded as baseline RED evidence**. The unexpected result triggered direct HEAD/source checks. The file/log are retained honestly, and a private git-archive snapshot of exact original f1d is used for the rigorous baseline rerun. No moving-checkout result is being represented as an immutable original run.

Final source provenance: corrected watchdog branch HEAD `f24b4a8380dbd4082b2c2b47b1bf0f87f6a41091` has clean status and no production source diff from reviewed `1a2502a1073a74c07f86d94641cfc209778d7a53`. Original integration path has since advanced; only the private archived exact-f1d baseline run above is used for the final RED comparison. This report preserves all original and excluded attempts distinctly.
