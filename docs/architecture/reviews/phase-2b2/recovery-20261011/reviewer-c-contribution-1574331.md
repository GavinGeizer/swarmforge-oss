# Contribution review — diagnostic allowance-status correction (1830..1574331)

**Reviewer:** independent-reviewer-c (read-only)
**Worker:** w-eb4ef77b-0a04-4d46-9bc5-934a1985eb3e
**Task:** final-security-review-fresh
**Run (authoritative dispatch):** 100e6514-570c-4e78-94ce-47b045e507a2

## Contribution bundle identity
- `/tmp/phase2b2-diagnostic-reviewed.bundle` size 3813,
  SHA256 `1cb7fd9a47e1bdab6dd3dffbd4a320da91a11ac991648a28162c397c2c809ede` — **verified**.
- `git bundle verify`: okay; requires `1830b06fe5b17e0c3feb86c06f7717a3d8dd20bc`; HEAD
  `157433166479c099a54cbee52ca9203dc722eb9f`. Fetched into private ref
  `refs/review/diag-157433166479c099a54cbee52ca9203dc722eb9f`; detached worktree
  `/tmp/phase2b2-diag-review` at exact HEAD, clean. Original assigned `45c` untouched, no push.
- Range `1830b06..1574331`: `7e0cf18` ("return 403 allowance_exhausted … harden task-admission
  audience tests", preserved/rejected candidate) then `1574331` (lead repair "preserve
  unavailable allowance status after atomic admission races"). Both reviewed.

## Verdict for THIS contribution: APPROVED

The change is a narrow status-code correction plus test hardening. No authority, tenant,
audience, custody or fail-open semantic changed. All fail-closed denials are preserved and the
deny cases remain deny with zero dependent writes. **This is not overall phase approval** — a
later final integrated commit (new real-D1/Bun test + documentation) still follows.

## Production change (exact)
`apps/cloud/src/hosted-admission.ts`
- `:309-315` advisory path: `allowance_exhausted` now `403` (was `409`).
- `:633-639` diagnostic path: `anyCovered ? 403 : 409` with codes
  `allowance_exhausted` / `allowance_unavailable`.
- **Quota/reservation SQL is unchanged** (diff is exactly the four status/code argument lines);
  no ledger, guard, or batch-structure change.

## Test changes (exact)
- `apps/cloud/test/enrollment.integration.ts:34-52`: wrong-audience task admission now sends
  valid controlled JSON + `Idempotency-Key`, expects **401** and asserts **zero**
  `hosted_tasks`/`hosted_reservations`/`hosted_outbox`/`hosted_operations` rows. This replaces
  the old `{}`-body 404 expectation and proves the denial mutates nothing.
- `apps/cloud/test/hosted-admission-regressions.test.ts`: advisory exhaustion now asserts 403 +
  `allowance_exhausted` and no second reservation; the old both-paths test is correctly labelled
  an advisory retry; new `beforeBatch` tests mutate the **real ledger** (consume to 1000 for
  `exhausted`, break the period for `unavailable`) after the advisory read and before the
  admission batch, asserting the batch was entered, the status is `403`/`409` respectively, and
  zero `hosted_tasks`/`hosted_reservations`/`hosted_outbox`/`hosted_operations`/admission-audit
  writes with the correct meter (`reserved_quantity:"0"`). The int64 canonical-boundary test now
  asserts `403` + `allowance_exhausted`.

## Verifications run (this worktree, frozen deps)
| Command | Result |
| --- | --- |
| `git bundle verify` + fetch + detached checkout | identity exact |
| `apps/cloud`: `bun install --frozen-lockfile` / root same | Bun 1.4.2 |
| `apps/cloud`: `bun run test` (`node --experimental-strip-types --test test/*.integration.ts`) | **124 tests: 124 pass / 0 fail** |
| `apps/cloud`: `bun test test/*.test.ts` (`test:sql`) | **90 pass / 0 fail** |
| `apps/cloud`: `bun test test/hosted-admission-regressions.test.ts` | **26 tests / 132 assertions, 0 fail** |
| root: `bun test` | **787 pass / 2 skip / 0 fail** |
| `apps/cloud` `bun run check` / root `bun run check` | pass (70 / 133 files) |

Logs: `.swarmforge/logs/diag-{cloud-test,cloud-sql,root-test,cloud-check,root-check}.log`.

## Original C shared-journal allegation — RESOLVED with the actual `HostedSupervisor`
Probe `.swarmforge/artifacts/probes/hosted-supervisor-cross-tenant-probe.ts` (15/15 pass) uses
the **actual** `HostedSupervisor` (`src/hosted-supervisor.ts`) and **actual** `SupervisorClient`
(`src/hosted-client.ts`) against the **real Cloud Worker** (`createWorker`/`index.ts` + real D1)
with two real tenants/credentials. Results:
1. B's own supervisor (`HostedStore` per credential) cannot even see A's work:
   `claimOnce()` → null; `stopAndConfirm`/`renewOnce`/`settle` on A's task refuse with
   "Unknown hosted task"; `reconcile()` iterates only its own journal. A's cloud task stays
   `queued`.
2. Worst case **shared trusted journal** (B's `HostedStore` pre-seeded with A's row): B can
   locally mark the never-started trusted journal row stopped (`state=stopped stop_confirmed=true`)
   — expected, because that journal is the **trusted local admin plane**, not the customer
   tenant API — but `settle` is refused and the **authoritative A cloud task stays `queued` with
   zero non-queued rows** (no server-side mutation).
3. Direct real `SupervisorClient` (B credential) `ack`/`renew`/`status`/`settle` on A's task are
   all blocked by the server guard with **404**; A's task remains `queued`.

Conclusion: the server tenant/worker/lease guards block every authoritative cross-tenant effect.
The only cross-tenant effect requires deliberately sharing the trusted local journal (the CLI
factory derives a distinct private journal per supervisor credential, so this is operator
misconfiguration, not the customer API), and even then it is confined to the trusted local admin
plane and cannot stop/mutate/settle the authoritative cloud task. The boundary is documented
(trusted local admin plane ≠ customer tenant API); no `Store`/MCP rewrite is needed.

## Notes
- Companion `review.md` residual annotation corrected: the earlier socket/EPERM renewal gap is
  stale — actual 31s production renewal passed over the real provider/child/socket path by both
  worker and lead, and real workerd/D1/TCP suites start. No live edge qualification claimed.
- No implementation source was edited; probes and reports are preserved separately; no push,
  deploy, merge, or VM deletion.
