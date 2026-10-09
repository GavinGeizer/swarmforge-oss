# Independent native dispatch correction review

**APPROVED for the reviewed local corrections** at exact SHA `93a96aa43e3874309d53436912a0ed728787b4aa`, with live D1/edge execution still a separate unfulfilled gate. No remaining critical/high finding was reproduced in this reviewed correction. Original CHANGES_REQUESTED report for parent5151 is preserved at `/tmp/phase2b2-native-dispatch-review.md`; it has not been overwritten. This reviewer did not implement dispatch and made no edits to its source or tests.

## Original findings resolved

- Current worker enroller chain now joins active user, tenant membership with owner/admin role, and active organization inside executionGuard. This guard is used by execution election and final continue read. The independent different-supervisor-admin probe now returns 409 authority_lost and full persisted state is unchanged. Cleanup remains authorized by the current supervisor chain, independent of the worker enroller loss.
- Claim and renewal election now include proposed expiry > SQL clock. The exact original clock-offset probe now returns 200 tasknull without operation/task/outbox mutation. More decisively, the independent real 31,050 ms beforeBatch wait now returns 200 tasknull and leaves the queued task/outbox, lease and all persisted state unchanged. The same real-time experiment with a coherent full-runtime60s task/reservation/meter shape passes: runtime 60000, deadline-created 60000, quantity 60000, reserved 60000; original5151 returned 409 and persisted a dead claimed lease, correction93a96aa returns 200 tasknull and persistedChanged false. Logs `/tmp/phase2b2-native-dispatch-coherent-original.log` and `/tmp/phase2b2-native-dispatch-coherent-corrected.log`.
- Settlement now refuses reservation quantity/runtime or reservation worker/task worker mismatch, and cleanup reads/election pin the reservation ownership and coherent full-runtime quantity. The independent quantity 1/runtime 10000 drift probe now returns 409, keeps the task running/reservation active and allowance reserved 10000, rather than terminalizing with reserved 9999. Legacy real-D1 fixture defaults now match full runtime and explicit metered fixtures reserve10000; intended assertions remain present.

All independent probe outputs against the corrected candidate are retained in `/tmp/phase2b2-native-dispatch-corrected-probes.log`. Repro scripts are outside the worktree and use production handlers/SQL with the lead's real Bun SQLite transaction adapter; they are complementary SQL integration, not real workerd/D1.

## Fresh verification

From `/tmp/swarmforge-phase2b2-dispatch`:

```
bun test apps/cloud/test/hosted-dispatch.test.ts
```

Result:28 pass, 0 fail. The newly added regressions verify enroller-role loss at claim/ACK/renew election, status stop/cleanup usability, expired proposed claim/renew leases, and reservation runtime/worker drift. Existing state snapshots, replay/fence/policy/ledger tests remain.

From `apps/cloud`:

```
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/biome check src/hosted-dispatch.ts test/hosted-dispatch.test.ts test/hosted-dispatch.integration.ts test/hosted-dispatch-helpers.ts
```

Both exit 0; Biome checked 4 files, no fixes applied. `git diff --check` exits0; HEAD was confirmed exact93a96aa. Source diff against5151 is confined to the authorized four owned files; shared dependencies remain outside the commit.

Measured budgets after corrections: combined mixed identity+dispatch cleanup 33 statements / 47 maximum bindings; metered recovery 14 / 61; response paths <=13 statements / 64 maximum bindings. The corrected equality and proposed-expiry guards remain within the 50 statement / 100 binding budget exercised by the tests. No scanned-row/edge CPU measurement is inferred from these counters.

## Remaining gate

Preserved real Node Miniflare/workerd D1 integration tests were independently attempted during original review:14 fixtures fail to initialize with listen EPERM 127.0.0.1, 0 skipped. Logs `/tmp/phase2b2-native-dispatch-live-d1.log`. That unchanged runtime restriction prevents a corrected live D1 claim here. This approval concerns the source corrections, independent production-SQL probes and local checks; it does not certify edge/D1 behavior, provider execution, integration wiring, deployment or CPU/scan budgets. No integration, publication, deploy, merge or SwarmForge action was performed.
