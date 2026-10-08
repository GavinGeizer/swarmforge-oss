# SwarmForge independent review — `wait_for_state_change`

- **Exact target reviewed:** `d428e0f730ed5649485732e95d39c32f5d6a8895` (branch `feature/binary-config-serve-20260930`)
- **Verdict:** FINDINGS — 1 LOW latent robustness gap. No CRITICAL/HIGH/MEDIUM defects.
- **Reviewer:** w-7139bba5-a577-41f7-9396-b59858dc8a39 (read-only)
- **Date:** 2026-10-01

## Scope

`wait_for_state_change` filters, cursors, timeouts, cancellation, listener cleanup,
and lost wakeups under concurrency.

Files read in full or in the relevant region at the exact target:

| File | Relevance |
| --- | --- |
| `src/coordinator.ts` | `Coordinator.waitForStateChange` (L65–169), `stop()`/`stopWaiters` (L27–34, L292–300), transition sites |
| `src/store.ts` | `subscribe`/`notify`/`close` (L16–56), `event` (L170–175), `latestEventId` (L183–189), `lifecycleEvents` (L191–212), `transition` (L153–169) |
| `src/domain.ts` | `lifecycleState` (L127–133), `StateChangeFilter`/`StateChangeResult` (L134–157), `resultSchema` (L38–74) |
| `src/mcp.ts` | `wait_for_state_change` tool schema + argument wiring (L294–317), error/redaction wrapper (L38–60) |
| `src/http.ts` | Per-request MCP server, `request.signal` as the only cancellation source (L86–99) |
| `src/serve.ts` | Startup/shutdown resource ordering used for reachability (L115–169) |
| `docs/MCP-API.md`, `docs/OBSERVABILITY.md`, `.agents/skills/using-swarmforge/SKILL.md` | Documented contracts asserted by the tests |
| `tests/wait.test.ts` | Existing coverage (11 tests, all pass at target) |

## Findings

### F1 — LOW — A wait started after shutdown, or one whose scan races `Store.close()`, fails with `RangeError: Cannot use a closed database` instead of a clean "Server is stopping" / `changed:false`

- **File / line (exact target):** `src/coordinator.ts:72` (`let cursor = filter.cursor ?? this.store.latestEventId();`)
  and `src/coordinator.ts:139` (`const found = next();`) with the stop check at `src/coordinator.ts:84–90`.
  Supporting: `src/store.ts:34–37` (`close()` clears watchers and closes the database).
- **Trigger:** `waitForStateChange` performs a synchronous database read **before** it consults
  `this.stopped` or races the `stopping` promise. `Store.close()` clears `watchers` (so a parked
  waiter is never woken) and closes the handle, so the next `latestEventId()` / `lifecycleEvents()`
  call throws.
- **Consequence:** the wait rejects with a raw `RangeError: Cannot use a closed database`
  instead of `Server is stopping`, and the MCP layer surfaces it as a tool error rather than a
  `changed:false` result. Cosmetic in the shipped build (see reachability), but it is the only
  failure mode of the wait that is not one of the three documented outcomes.
- **Reproduction (reproduced):**
  ```
  const p = coordinator.waitForStateChange({worker_id}, {timeoutMs: 300});
  await listening(1); store.close();  // wait is parked, watchers cleared
  await p;  // -> RangeError: Cannot use a closed database
  ```
  (probe `PROBE G2` in `/tmp/opencode/probes/wait-http.test.ts`, passed-by-observation,
  exit code 1 for the deliberately-over-strict variant `PROBE G` and exit 0 for `PROBE G2`).
- **Reachability in the shipped code: NOT reachable today.** `src/serve.ts:140–157` closes the
  store only at L152, strictly after `await api?.stop(true)` (which force-closes in-flight
  requests) and `await coordinator?.stop()` (which resolves every registered waiter's `stopping`
  promise and yields at `await Promise.allSettled(...)`, so all waiters have already unwound
  before `store.close()` runs). It becomes reachable if that ordering is ever refactored, if a
  second `Store.close()` path is added, or if `stop()` is changed to skip its awaits.
- **Why existing guards/tests do not prevent it:** `tests/wait.test.ts:249` covers abort, not
  store close. `tests/wait.test.ts:281` closes and reopens the store but only with no wait parked.
  No test closes the store while a wait is in flight, and the two guards that would mask it
  (`api.stop(true)` and the `stopWaiters` wake) both live in `serve.ts`, outside the unit under test.
- **Recommendation:** make the shutdown/close observation precede the first database read, and
  make the store read fail soft. E.g. in `Coordinator.waitForStateChange`, check
  `if (this.stopped) throw new Error("Server is stopping")` immediately after the existing
  pre-abort check at L70 and treat a closed-database error as `result(null)`/`result(found)`
  instead of letting it escape. Optionally make `Store.close()` resolve parked waiters (it
  already has the `watchers` set to notify through).
- **Confidence:** medium. Reproduced by direct probe; reachability excluded by the documented
  shutdown order rather than by an explicit guard in `waitForStateChange`.

## Explicitly assessed and NOT defective

These were probed rather than assumed; each is a place a real bug could have lived.

1. **Lost wakeup between subscribe and scan (`src/coordinator.ts:72–75`, comment at L74).** Safe.
   `latestEventId()` is read *before* `subscribe()`, and the subscribe→assign-`notify` window
   contains no `await`, so a microtask can never observe `notify === undefined` between the
   scan and the wake registration. `PROBE M` (400 randomized rounds) found no lost wakeup.
2. **Same-tick event burst.** `Store.notify` defers each listener with `queueMicrotask`
   (`src/store.ts:49–56`). With N events committed in one synchronous block the microtask queue is
   FIFO, so the extra wakeups always land before the race continuation and are absorbed by the
   rescan. `PROBE A` (40 waiters, 40 transitions in one tick) and `PROBE L` (200 concurrent real
   HTTP waits) both resolved every waiter exactly once with `listenerCount` back to 0.
3. **Cursor skipping.** `next()` advances `cursor` only over rows it has already examined and
   returns at the first match, so no matching event can be passed over. An ownership-filtered
   wait advances the cursor only over its own rows (`PROBE I`: `next_cursor` 1 while
   `latestEventId()` was 2) — correct, and it still replays every event matching that filter.
   `PROBE B` drained a 4-event worker with `states:["ready"]` and replayed exactly one event.
4. **`changed:false` timeout path.** The expired branch re-scans (`src/coordinator.ts:159–162`),
   so a commit that lands during the timer callback is still reported, and `next_cursor` is the
   consumed position. `PROBE C` measured 301 ms for a 300 ms timeout.
5. **Cancellation.** `onAbort` is registered `{once:true}` and removed in the outer `finally`
   (`src/coordinator.ts:80`, `166`); `unsubscribe()` and `stopWaiters.delete` run in the same
   `finally` (`165–167`). `PROBE D` (25 abort/timeout races), `PROBE E` (10 consecutive aborts
   then a working wait), `PROBE K` (real `fetch` client abort against a real `Bun.serve`) all
   left `listenerCount === 0`, and the store still woke a later waiter.
6. **Shutdown wakeup.** `PROBE F`: 5 parked waiters all rejected with `Server is stopping`, all
   listeners released, and a wait started after `stop()` fails immediately instead of parking.
7. **No worker lock held.** `PROBE H`: `control(pause)` completed in 4 ms while a wait was parked
   on the same worker and the wait observed the `paused` transition.
8. **Same-state transitions emit no event** (`src/store.ts:160` returns `patch` without `event`
   or `notify`). This is correct for a transition watcher, not a lost wakeup, and matches the
   documented "lifecycle transitions only" contract.
9. **Docs vs. code.** `docs/MCP-API.md:27` and `docs/OBSERVABILITY.md:36` claims verified as
   accurate (read-only hint, 25 s cap, filter combination, consumption of non-matching events,
   listener release, cursor validity across restart). The phrase "observes the same event ids **in
   memory**" (`docs/MCP-API.md:33`) is imprecise — the wait reads the SQLite event log — but the
   conclusion it supports is correct and covered by `tests/wait.test.ts:281`. Doc nit only.
10. **Redaction interaction.** `redactorFor` is applied to the wait payload
    (`src/mcp.ts:40`); none of the nine wait keys (`at`, `changed`, `event_id`, `next_cursor`,
    `state`, `task_id`, `team_id`, `vm_id`, `worker_id`) match the key-redaction pattern in
    `src/security.ts:31`, and the payload carries no prompt, payload or secret. The existing
    assertion at `tests/wait.test.ts:59` holds.

## Tests run (Bun 1.4.2, official release in /tmp; lockfile untouched)

Toolchain note: the snapshot `bun` is 1.3.14, so official Bun 1.4.2 was unpacked to
`/tmp/opencode/bun142/` and used with `bun install --frozen-lockfile` in a **disposable /tmp
clone**. `bun.lock` md5 was identical before and after install. `/workspace/repo` was never
checked out to the target, modified, or committed to.

| Command | Exit | Result |
| --- | --- | --- |
| `bun test tests/wait.test.ts tests/api.test.ts` (in /tmp clone at target) | 0 | 19 pass, 0 fail, 95 assertions |
| `bun test tests/serve.test.ts` (in /tmp clone at target) | 0 | 20 pass, 0 fail, 111 assertions |
| `bun test /tmp/opencode/probes/wait-concurrency.test.ts` | 1 | 8 pass, 1 fail — the only failure is probe G's over-strict 2500 ms race against a 3000 ms wait; superseded by PROBE G2 |
| `bun test /tmp/opencode/probes/wait-http.test.ts` | 0 | 4 pass, 0 fail |
| `bun test /tmp/opencode/probes/wait-stress.test.ts` | 0 | 1 pass, 0 fail, 802 assertions |

Full suite was **not** run (whole-suite review is another reviewer's scope). Probe files live
only in `/tmp/opencode/probes/` and are not part of the source tree.

## Limitations

- No real provider, model, VM or network calls; all probes used `FakeProvider`/`FakeAgent` from
  `tests/helpers.ts` and local `Bun.serve` on 127.0.0.1 with loopback ports.
- Restart/durability behaviour was taken from the existing test
  (`tests/wait.test.ts:281`) and the re-read of `serve.ts`; no multi-process WAL probe was run,
  so a second writer's events were not exercised. `serve.ts` holds a process lock, so a second
  writer is out of the supported configuration.
- Behaviour under a system-clock step (NTP) is unverified: the deadline is derived from
  `Date.now()` (`src/coordinator.ts:136`). Flagged only as an unverified hypothesis shared with
  every other deadline in the codebase, not as a finding.
- Cursor sharing *across different filters* (feeding one filter's `next_cursor` to another) was
  analysed but not reported: each filter sees only its own rows, so this is caller misuse rather
  than a defect, and the docs do not invite it.
