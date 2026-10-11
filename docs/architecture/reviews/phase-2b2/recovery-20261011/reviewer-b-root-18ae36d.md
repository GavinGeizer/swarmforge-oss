# Reviewer B — Root-test Contribution Review: `1574331..18ae36de1a0b2313bfcb01ade930d10f54ab7e23`

**Verdict for THIS contribution: CHANGES_REQUESTED (single Low-severity,
claim-accuracy defect; functional fix otherwise VERIFIED).** Not phase approval;
final combined source+docs still pending.

Separate report. Prior reports (`review.md`, `source-review-preflight.md`,
`review-contribution-1574331.md`, `review-runtime-692dcb4.md`) preserved
unchanged. Red/green probe evidence: `probe-root-18-red-green.log`.

## Provenance (verified, read-only, no push/merge/deploy)

- `/tmp/phase2b2-root-18.bundle` SHA256
  `cea50b008966019fdd58f71b83daa6dac8e639a7c16f12a9a664a780e56a4b23`, 1398B —
  MATCHES; fetched `refs/private/root-18` =
  `18ae36de1a0b2313bfcb01ade930d10f54ab7e23` (tree
  `73d550cf433c85b540ba5eec80bfd79a427a6a0f`, requires `1574331`). `git fsck`
  clean.
- `git diff 1574331..18 --stat`: **only** `tests/hosted-supervisor.test.ts`
  (104 insertions, 6 deletions). No production file, config, deps, or shared
  production hook changed. Original assigned branch `/workspace/repo` unchanged
  at `45c29d3`.
- Isolated detached worktree `/tmp/p2b2-root18` at exact `18ae36d`.

## What changed

- `tests/hosted-supervisor.test.ts:810-821` — existing concurrent-identity
  test's provider delay gate changed from invocation **count**
  (`calls++; if (calls === 2) await secondGate`) to **task identity**
  (`if (worker.task_id === second.task_id) await secondGate; else await
  Bun.sleep(50)`).
- `tests/hosted-supervisor.test.ts:867-961` — new test "…when ACK and launch
  order are reversed" adds an ACK-order gate (`firstAckGate`, first's `/ack`
  held until second's `/ack` served) and a `ReversedProvider` that holds the
  intended-first task on `sawSecond` and gates the intended-second on
  `secondGate`.

## Executed evidence

- RED (original count-based gate under deterministic reverse entry): the
  reversed test **deadlocks** — `this test timed out after 5000ms`, `killed 1
  dangling process` (`probe-root-18-red-green.log` §1). Independently
  reproduces the reported circular wait (`await firstLaunch` → `releaseSecond`).
- GREEN (identity gate at `18ae36d`): reversed test **1 pass / 6 expect**;
  existing concurrent test **1 pass / 5 expect**; full file
  `bun test tests/hosted-supervisor.test.ts` → **61 pass / 0 fail / 306
  expect() / 64.25s** — matches the author claim exactly.

## Findings (ordered by severity)

### G1 (Low, claim-accuracy, CHANGES_REQUESTED): "reversed launch order" is inaccurate; the reversal is ACK-serving/arrival order
- Location: test title at `tests/hosted-supervisor.test.ts:867` ("…when ACK and
  launch order are reversed") and the inline claim at `:887-889` ("Holding the
  intended-first task until the intended-second task has been seen,
  deterministically forcing the reversed launch order").
- Repro (executed): instrumented order probe, 3 deterministic runs →
  `OBSERVED_ORDER=["entry:first","entry:second","spawn:first","spawn:second"]`
  (`probe-root-18-red-green.log` §3). The intended-first task enters the
  provider first and its child is spawned **first**; `releaseSecond()` runs
  only after `await firstLaunch` (`:934-935`), so the second child can never
  spawn before the first. The only order actually reversed is the **ACK
  serving order** (first's `/ack` is held until second's is served,
  `:904-921`), plus the provider-side hold ordering.
- Impact: test documentation overstates what is proven. It does not weaken the
  regression (the identity-vs-count defect is still exercised and the RED probe
  confirms the deadlock), but the title/comment misdescribes the mechanism and
  could mislead later readers into believing OS launch order was reversed.
- Requested change: retitle/reword to "reversed ACK arrival order with the
  intended-second task held at the provider gate" (or equivalent), and drop
  "forcing the reversed launch order". Optionally assert the observed
  ACK-before-ACK ordering rather than only `secondAcked === true` (`:938`),
  which proves the second ACK was served but not its order relative to the
  first.

### No other defects found
- No assertion/timer weakening: all original assertions are retained
  (`:947-951`), the new test adds `secondAcked`; no shared production hooks or
  test configuration changed; no arbitrary sleeps replace the real gates (the
  `Bun.sleep(50)` is the pre-existing non-blocking path for the held worker).
- Cleanup/wait gates on failure are sound: both tests' `finally` release
  `secondGate`, release `firstAckGate` (`:954`), `await secondLaunch?.catch`,
  `supervisor.close()`, `h.coordinator.stop()`, `h.store.close()`,
  `fixture.close()` (`:952-960`). No missing cleanup identified in the
  contribution itself (the RED deadlock's dangling process is the expected
  consequence of the deliberately broken probe, not of `18ae36d`).
- The identity gate is correctly bound: the staged `Worker` passed to
  `startControlled` carries `task_id` from the hosted task, so
  `worker.task_id === second.task_id` reliably selects the intended task.

## Statement

Contribution `1574331..18ae36de1a0b2313bfcb01ade930d10f54ab7e23`:
**CHANGES_REQUESTED** for G1 (accurate description of the reversed *ACK
arrival/staging* order; not an actual child-launch reversal). The functional fix
(bind the launch gate to task identity) and the regression are verified correct
by executed RED/GREEN evidence and do not overstate anything beyond the
title/comment. Final combined source+docs still pending; no overall phase
acceptance.
