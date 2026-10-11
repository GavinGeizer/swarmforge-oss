# Re-review — corrected hosted runtime qualification (1830..605fa60)

**Reviewer:** independent-reviewer-c (read-only)
**Worker:** w-eb4ef77b-0a04-4d46-9bc5-934a1985eb3e
**Task:** final-security-review-fresh
**Run (authoritative dispatch):** 78328f00-7e96-4ee4-92ec-d2c275c85f08

## Verdict for THIS contribution: APPROVED

My concrete prior findings R1 (driver/real-child not cleaned up on failure) and R2 (lost-ACK
response body left unconsumed) are **closed**, with new positive failure-path tests and an
independent teardown probe confirming the mechanism. The added failure cases are real and the
suite is 5/5. No authority or configuration weakening; only the new test file changed.

## Contribution identity (verified)
- `/tmp/phase2b2-runtime-final.bundle` size 13276, SHA256
  `8ed197e51d6fc9beb1762b0f747037b8b09734eb5246cf0424c2e9a144917e47` — **verified**;
  `git bundle verify` okay; requires `1830b06`, HEAD
  `605fa6059d442a1c5ec40ffd4a36820efe173153`.
- Fetched into private ref `refs/review/runtime-605fa605`; isolated detached worktree
  `/tmp/phase2b2-runtime-605` at exact HEAD; tree
  `70a852cc7dd6c0df1193d32bd046f8078d890f9a` (matches); clean; original assigned `45c` unchanged.
- Range `1830..605fa60`: `5dfe8d6` + `692dcb4` + `a106deb` + `605fa60`. Diffstat adds only
  `apps/cloud/test/hosted-runtime.integration.ts` (now 897 lines). **No production source change.**
- Existing original reports retained (`review.md`, `review-diagnostic-1574331.md`,
  `review-runtime-692dcb4.md`).

## Prior findings — closure evidence

### R1 CLOSED (driver/real-child cleanup on failure)
- `runDriver` now takes a `drivers: Set<DriverHandle>` and registers each handle
  (`runDriver` additions), returns `{ child, result, exited }`.
- New `stopDriver(handle)` (`hosted-runtime.integration.ts`, near `:390`): SIGTERM → await exit
  with a 15s bound → SIGKILL fallback with a 5s bound; if it still will not exit it returns an
  explicit uncertainty string.
- `withHarness`'s `finally` now stops and awaits **every** registered driver BEFORE closing the
  bridge, disposing Miniflare/D1, or `rm`-ing the journals, and **fails the qualification** when
  any cleanup uncertainty remains — alone or combined with a primary failure.
- New test "driver failure while the real child is alive stops the runtime through production
  cleanup and retains the durable journal" starts a real child, throws in-flight, and asserts the
  child was actually started (`child_pid > 0`), stopped (`pid_dead === true`), the durable journal
  is retained on reopen (`stop_confirmed === true`), and `cleanup_errors` is absent.
- Independent probe `.swarmforge/artifacts/probes/runtime-harness-teardown-probe.ts` (2/2 pass):
  a graceful-SIGTERM child is awaited to exit before teardown (returns null), while a child that
  ignores SIGTERM yields an explicit uncertainty (the harness turns that into a failed
  qualification). Confirms SIGKILL-of-parent alone is **not** accepted as proof; uncertainty fails.

### R2 CLOSED (lost-ACK body)
- The lost-ACK transport now `await response.arrayBuffer()` before throwing, consuming the real
  reply body; the reply is still discarded (never fed back as a fake delivery).

## Additional hardening (verified, correct)
- stdin `error` is captured and surfaced through `result` (no noop listener hiding EPIPE).
- Driver stdout parse failure/early exit rejects with bounded diagnostics
  (`clip(...)`, 2000 chars).
- Driver installs SIGTERM/SIGINT → production `cleanup()` (`supervisor.close` → verified child
  stop, `coordinator.stop`, `store.close`) then exits; the journal is reopened for durability
  evidence on both success and failure paths; child absence is proven only by real **ESRCH** after
  cleanup (EPERM/unknown fails).

## Verifications run (this worktree, frozen deps, Bun 1.4.2)
| Command | Result |
| --- | --- |
| `git bundle verify` + fetch + detached checkout | identity exact, clean |
| `node --experimental-strip-types --test test/hosted-runtime.integration.ts` | **5 pass / 0 fail**, 65.958s |
| `apps/cloud` `bun run test` (full integration) | **129 tests: 127 pass / 2 fail** — only the two known old-1830 status/fixture defects already fixed at 1574331 |
| teardown probe | 2/2 pass |

Logs: `.swarmforge/logs/runtime-605-test.log`, `runtime-605-full-cloud.log`,
`runtime-harness-teardown-probe.log`.

## Limits / notes
- This is a contribution review only — **not overall phase acceptance**. A final integrated
  commit plus documents and the A/B/C acceptance still follow.
- Parent SIGKILL is intentionally never treated as grandchild-absence proof; teardown uncertainty
  remains a failed qualification. Observed graceful signal handling has no authority/security
  weakening.
- No source edits; no speculative production rewrite, configuration, or timeout weakening; no
  push/merge/deploy/VM destruction. No secrets recorded.
