# Final integrated independent review A — exact head 8abc7bd

- Worker: `w-cf8f53a8-390e-4f5b-90d9-4759b856a37f`
- Task: `final-architecture-review-fresh`
- Run: `1774a50c-488b-4ee7-883e-9cf02d741296`
- Reviewed HEAD: `8abc7bdc58c2461bd067a5c860923b13f6e8b6cf`
- Reviewed tree: `f3e0f746f56bf6c9c0b6a36799f947921c77e18b`
- Complete bundle: `/tmp/phase2b2-final-review-source.bundle`, SHA256
  `fe1b0fae15fbd86c52bd962b2b46d87dd048bf842e422123dad7b6214eed5198`
  (independently recomputed and matched)
- Prepared worktree: `/tmp/phase2b2-final-review-8abc7bd` (detached; `git status` clean; `git fsck --full` clean)
- Baseline: `fec66971536cb117b36c85faabd98883d6491cb2` (Phase 2B.1)
- Toolchain: Bun **1.4.2**, Node **v24.21.0**; frozen pinned installs (`bun install --frozen-lockfile`, root and `apps/cloud`)
- Method: **read-only**. No code/test/config edits, push, merge, deploy, or VM destruction.
  Original reports preserved: `/workspace/.swarmforge/artifacts/review.md`,
  `review-correction.md`, `review-root-b6d6e54.md`.

## Verdict

**APPROVED for the complete assigned controlled-local Phase 2B.2 scope.**
No Critical, High, or Medium correctness, security, or backward-compatibility defect was
found. `CHANGES_REQUESTED` is not warranted for the controlled-local scope.

This is **separate** from untrusted/pilot launch readiness, which remains **INCOMPLETE/blocked**
by explicitly documented, unqualified gates (Section "Pilot / untrusted launch blockers").
Controlled local acceptance here is not a live-edge or customer-workload certification.

## Exact-head provenance

- `git bundle list-heads` = `8abc7bd… HEAD`; bundle SHA256 re-verified.
- `git diff --name-status 1574331..8abc7bd -- src apps/cloud/src apps/cloud/migrations apps/cloud/package.json package.json bun.lock` = **empty**.
  All integration commits after the reviewed `1574331` (`5dfe8d6`, `692dcb4`, `605fa60`,
  `a106deb`, `a4b9b88`, `c1e696a`, `0b06aeb`) touched only tests/docs; the production source
  and dependency set are byte-identical to the exact source verified in the prior dispatches.
- `8abc7bd` itself adds documentation/evidence only: 42 files, **all** under
  `docs/architecture/` (39 under `docs/architecture/reviews/phase-2b2/recovery-20261011/`).

## Corrections verified against actual source at this head

| Correction | Source reference | Status |
| --- | --- | --- |
| 1573 advisory allowance exhaustion 403 | `apps/cloud/src/hosted-admission.ts:310-315` (`403`, `allowance_exhausted`; period miss stays `409`) | present |
| 1573 post-batch diagnostic mirrors advisory | `apps/cloud/src/hosted-admission.ts:630-639` (`anyCovered ? 403 : 409`, `allowance_exhausted : allowance_unavailable`) | present |
| C1 rotation replay finite windows on SQL clock | `apps/cloud/src/hosted-supervisors.ts:470` (`c.expires_at>MAX(?,hostedSqlNow)` and `r.expires_at>MAX(?,hostedSqlNow)`) | present |
| A-H1 child-enforced renewable lease | `src/hosted-child.ts:88` (`Math.min(lease, absolute)`), `:103` (`absolute - observed > 3_600_000` reject), `:96-100` raw-shape/ordering checks, `:115-143` validated stdin frames | present |
| A-H1 provider renewal budget/validation | `src/hosted-runtime.ts:239` (`absolute - boot > 3_600_000`), `:343-373` `renewControlled` | present |
| b6d6e54 restored L1 bound | `tests/hosted-supervisor.test.ts:2541` (`absoluteBootMs - bootBeforeLaunch <= 3_600_000`) | present; targeted test green |
| concurrent-launch gate bound to task identity | `tests/hosted-supervisor.test.ts` (18ae36d/aa2aad9) | present; targeted tests green |
| redaction recognizes hosted credentials | `src/security.ts:58` (`sfexec_|sfsuper_` added to machine-credential redaction) | present |

`1573` production delta remains exactly two response-code lines with quota SQL untouched
(confirmed by `git diff 44156cc..1574331 -- apps/cloud/src/hosted-admission.ts`, re-checked here).

## Backward compatibility (actual source)

- **Core self-hosted engine unchanged**: `git diff --name-only fec6697..8abc7bd` reports **0**
  changes to `src/coordinator.ts`, `src/store.ts`, `src/domain.ts`, `src/config.ts`,
  `src/github-oauth.ts`, `src/providers/**`, `src/mcp.ts`, `src/serve.ts`, `src/http.ts`,
  `src/runtime.ts`, `src/artifacts.ts`, `src/artifact-store.ts`, `src/finalization.ts`.
- **No Cloud dependency in the local engine**: root `package.json`/`bun.lock` unchanged;
  `grep -c "cloudflare|wrangler|miniflare|workerd" bun.lock` = `0`; no `src/**` import of
  `apps/cloud`/`@swarmforge/cloud` (none found). Hosted handlers are dynamically imported only
  for explicit `hosted` commands (`src/cli.ts:512-513`, child at `:591`).
- **Additive migrations only**: `apps/cloud/migrations/0001_identity.sql` and `0002_machine_identity.sql`
  unmodified; `0003_hosted_execution.sql` added (`git diff --name-status` = `A 0003…`). Legacy
  machine-credential audiences are not widened; `sfexec_`/`sfsuper_` use dedicated hashed-token tables.
- **All root source changes are additive** (15 files): hosted/cloud modules + `private-credential-file.ts`
  + the redaction regex extension. No orchestrator rewrite.
- **Untrusted workload is structurally disabled**: `taskSubmitSchema` accepts only
  `{request_id, worker_id, execution_class:"controlled", runtime_ms, controlled_duration_ms}`
  (`.strict()`), excluding repository/prompt/command/model/environment inputs
  (`apps/cloud/src/hosted-types.ts:151-162`).
- **Protected Linux credential storage**: `src/private-credential-file.ts` fails closed on
  ownership/mode (0600 file / 0700 dir), hardlinks, symlinks; uses `O_NOFOLLOW`/`O_EXCL`,
  fsync-on-file, atomic rename, fsync-on-directory; hosted state applies the same discipline
  (`src/hosted-store.ts:88-143`).

## Commands run and counts (this review, exact head)

| Command | Result | Log |
| --- | --- | --- |
| `node --experimental-strip-types --test test/*.integration.ts` (apps/cloud) | **130 pass, 0 fail, 0 skip** | `.swarmforge/logs/1774-cloud-integration.log` |
| `bun --no-env-file --config=/dev/null test test/*.test.ts` (apps/cloud; SQL/static/migration) | **90 pass, 0 fail, 0 skip** | `.swarmforge/logs/1774-cloud-sql.log` |
| `bun test tests/core.test.ts tests/lifecycle.test.ts tests/adapters.test.ts tests/settings.test.ts` | **110 pass, 0 fail** | `.swarmforge/logs/1774-root-compat.log` |
| `bun test tests/hosted-child-lease.test.ts tests/cloud-worker-client.test.ts` | **23 pass, 0 fail** (child authority incl. 31 s renewal) | `.swarmforge/logs/1774-root-runtime.log` |
| `bun run check` (root: tsc + biome) | exit 0, 133 files | `.swarmforge/logs/1774-root-check.log` |
| `bun run check` (apps/cloud: tsc + biome) | exit 0, 71 files | `.swarmforge/logs/1774-cloud-check.log` |

No test, assertion, skip, timeout, concurrency, or ownership guard was added, removed, or
weakened. The 244 s full root suite was deliberately **not** repeated; the prior verified
`788 pass / 2 pre-existing skip / 0 fail` (lead, at `a3f14dc`; this head differs only in
docs/tests) stands, and targeted root cases above independently corroborate the hosted runtime
and compatibility paths. An earlier killed background run produced a spurious
`worker-client.integration.ts` "event loop resolved" line; re-running cleanly gave
**130/130 pass**, so it was an artifact of terminating the process, not a defect.

## Findings (severity)

No Critical/High/Medium findings. Low observations only, none blocking:

- **L1 (closed)** — the env-contract `<=1 h` absolute-deadline assertion dropped by `1830b06`
  is restored (`tests/hosted-supervisor.test.ts:2541`) and green. Closed.
- **L2 (retracted)** — the enrollment wrong-audience comment matches its four asserted
  zero-effect tables. Withdrawn; optional `hosted_allowances` assertion only, no authority defect.
- **L3 (informational)** — the root-test owner reports an out-of-scope flake in the env test
  under artificial 5× cloud load (`/proc/<pid>/environ` empty because the child exited under
  contention); it passed 6/6 focused under the same load and is not patched. Not reproduced
  here (env/logs test green). Test-only, non-blocking.
- **L4 (informational)** — `8abc7bd` is docs/evidence-only; no executable change follows the
  lead-qualified integration at `0b06aeb`.

## Pilot / untrusted launch blockers (separate from controlled-local approval)

Documented in `docs/architecture/phase-2b2-summary.md` (§12, §17, §18):
- Untrusted/customer execution structurally disabled; repository brokerage, task-scoped BYOK
  custody, snapshot hygiene, and independently verified hostile same-UID runtime isolation are
  **not** implemented/qualified.
- Live edge CPU and D1 scanned/written-row measurements, larger retention/load fitness, and
  production bindings are unmeasured; the `cf` Docker-detection build warning is not a Worker
  compile failure and the emitted artifact booted against real local D1.
- Private credential custody runbook, supervisor operating permissions, owner-approved capacity
  policy, and explicit deployment authorization remain pilot gates. Stripe/BYOK mapping is out
  of scope and no prices/quotas were invented.
- This review is local emulation/runtime evidence, not live edge or shared privileged-runtime
  isolation certification.

## Conclusion

The complete Phase 2B.2 controlled-local implementation (Phase 2B.1 `fec6697` → `8abc7bd`),
its integrated recovery corrections, schemas/APIs, CLI/provider/local SQLite compatibility,
absence of Cloud dependencies in the local engine, protected Linux credential storage, and
documentation were inspected against actual source and independently exercised. **Verdict:
APPROVED (controlled-local scope).** Overall pilot/untrusted launch remains **INCOMPLETE**,
pending the separately documented gates and the final docs-only delivery follow-up.
