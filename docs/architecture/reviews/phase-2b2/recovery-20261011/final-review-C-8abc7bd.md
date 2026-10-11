# FINAL INTEGRATED INDEPENDENT REVIEW C — Phase 2B.2 RECOVERY

**Reviewer:** independent-reviewer-c (read-only)
**Worker:** w-eb4ef77b-0a04-4d46-9bc5-934a1985eb3e
**Task:** final-security-review-fresh
**Run (authoritative dispatch):** 3a694ca7-49fc-4d35-a8a4-15c3a8237f4e

## Verdict: APPROVED — for the assigned **controlled-local** phase scope

No security defect was identified in the reviewed implementation. The only production change
since the approved 1830 baseline is the already-reviewed two-line allowance status correction.
All independently re-run suites are green. **This approval covers the controlled-local
implementation only**; untrusted/pilot-launch blockers are listed separately and are NOT approved.

## Inspected identity (verified)
- HEAD `8abc7bdc58c2461bd067a5c860923b13f6e8b6cf`, tree
  `f3e0f746f56bf6c9c0b6a36799f947921c77e18b` (matches). Isolated detached worktree
  `/tmp/phase2b2-final-review-8abc7bd`, clean.
- Source bundle `/tmp/phase2b2-final-review-source.bundle` size 2902303, SHA256
  `fe1b0fae15fbd86c52bd962b2b46d87dd048bf842e422123dad7b6214eed5198` — **verified**;
  `git bundle verify` okay (complete history); HEAD on `phase2b2-hosted-dispatch`.
- Range `1830b06..HEAD` = 14 commits. **Production source delta is only
  `apps/cloud/src/hosted-admission.ts` (+4/-2: the 1573 status fix); no root `src/` change.**
  Everything else is test files (`tests/hosted-supervisor.test.ts`, `apps/cloud/test/*`) and
  documentation/evidence logs.

## Findings

No security findings. The item below is a scope/limitation statement, not a defect.

### N1 — INFO: untrusted/pilot-launch blockers remain (not part of this approval)
Controlled-local acceptance does not certify: live Cloudflare edge CPU/quota behavior; live
provider (GitHub) production availability; unrestricted D1/TCP operational qualification; and
shared *privileged* journal runtime isolation. The direct cross-tenant supervisor probe uses the
in-process real **SQLite D1 adapter** (`LocalD1`, not workerd) with a **never-started** shared row
and a stub provider, so it proves the server guards and the trusted-journal boundary, **not**
privileged OS runtime isolation under a deliberately shared journal. This is documented in the
preserved evidence README and my review-diagnostic files. No production rewrite is warranted from
that finding without new proof.

## Scope coverage with source references (verified at this HEAD)

- **Server tenant authority / isolation.** `apps/cloud/src/hosted-admission.ts` (`resolvePrincipal`
  'account'|'execution', `admit` single conditional D1 batch; `readTask`/`cancelTask` bound to
  `organization_id`); `apps/cloud/src/hosted-dispatch.ts` (`taskFor(ctx,id,tenant)` 404 on
  cross-org; `sameLease` lease+fence+worker; `supervisorAuth` tenant+worker binding). Independent
  probe at this HEAD: **15/15** (B supervisor/real client ack/renew/status/settle on A's task →
  404; A task stays `queued`, zero non-queued rows). See
  `.swarmforge/logs/final-cross-tenant-probe.log`.
- **Audiences / scopes.** Strict disjoint bearers: `hosted-authority.ts:101`
  (`^Bearer sfexec_…`), `machines.ts:33` (`sfcli_|sfworker_`), `hosted-supervisors.ts:37`
  (`^Bearer sfsuper_…`); exact scope-list equality in each `*Auth`. No audience fallthrough.
- **CLI/worker/supervisor separation.** `machineAuth` vs `hostedAuth` vs `supervisorAuth` are
  mutually exclusive; `src/cli/hosted.ts` constructs only an inert local Coordinator/Store/
  HostedStore and starts no MCP/HTTP server nor exposes any global admin bearer, OS plane or
  journal. Verified by the runtime integration (default worker routes for enrollment, supervisor
  registration, CLI link, execution grant).
- **Revocation / expiry / rotation / stale authority.** Epoch CAS rotation/revoke
  (`machines.ts`, `hosted-supervisors.ts`) with live-grant predicate and `MAX(?,hostedSqlNow)`
  statement-time clock (`hosted-authority.ts:46-55`, `:79`); expired authority is rejected
  fail-closed (cloud runtime test "expired supervisor authority is rejected"; rotation-window SQL
  tests green).
- **Repository/model secret gating.** Hosted CLI loads inert config only
  (`src/cli/hosted.ts`); hosted payloads are fixed inert and carry no repo/model/env/prompt
  (`hosted-client.ts` admission body; `hosted-types.ts` `taskSubmitSchema`).
- **Trusted private journal / OS boundary / emergency cleanup.** `src/hosted-store.ts`
  (`ensurePrivateHostedPath` 0700/0600, symlink/nlink/owner checks); `src/private-credential-file.ts`
  (`O_NOFOLLOW`, fsync, atomic rename); `src/hosted-runtime.ts` OS pid+starttime+exe+boot-id
  identity before launch and before any signal, ESRCH-only absence; `hosted-dispatch.ts`
  `hostedRecoveryRoute` operator-gated (owner/admin + CSRF + idempotency + `recoverable` +
  operator stop evidence).
- **No customer/untrusted execution enabled.** `hosted-types.ts:155,183` `execution_class:
  z.literal("controlled")`; `src/hosted-runtime.ts:544` (no arbitrary commands) and
  `:552,555` (no guest filesystem); `src/hosted-supervisor.ts:103` ("Forbidden workload: only
  controlled execution is allowed"); `hosted-child.ts` fixed bounded inert workload.

## Commands run (frozen deps; Bun 1.4.2; Node `--experimental-strip-types`)

| Command | Result |
| --- | --- |
| cloud integration: `node --experimental-strip-types --test test/*.integration.ts` | **130 pass / 0 fail** (exit 0) |
| cloud SQL: `bun --no-env-file --config=/dev/null test test/*.test.ts` | **90 pass / 0 fail** |
| root: `bun test` | **788 pass / 2 skip / 0 fail** |
| `apps/cloud` `bun run check` (tsc+biome) | pass (71 files) |
| root `bun run check` (tsc+biome) | pass (133 files) |
| independent cross-tenant supervisor probe @HEAD | 15/15 |

Logs: `.swarmforge/logs/final-{cloud-integration,cloud-sql,root-test,cloud-check,root-check,cross-tenant-probe}.log`.
Counts match the committed lead evidence (`combined-final-cloud.log` 130/130 + SQL 90/90;
`combined-final-root.log` 788/2/0).

Read (not re-run) committed evidence: memory64 migrations/abuse 8/8
(`combined-memory64-migrations-abuse.log`); `cf build --mode local` (Docker access denied but
build complete); `cf workers types`; Linux package + verify
(`combined-package*.log`, `combined-root-build.log`); compiled-artifact smoke booted in local
workerd/D1 with `/ready` 200, unauthenticated admission 401 and zero dependent rows
(`combined-cf-artifact-smoke.log`). These are local emulation results; no edge CPU or live
production qualification is claimed.

## Verdict breakdown
- **Controlled-local phase scope (this review): APPROVED** at exact
  `8abc7bdc…`/tree `f3e0f746…`.
- **Untrusted/pilot launch: not approved** — see N1. Final documentation-only delivery follow-up
  and A/B/C overall acceptance remain (still incomplete).

## Notes
- Original reports preserved (`review.md`, `review-diagnostic-1574331.md`,
  `review-runtime-692dcb4.md`, `review-runtime-605fa60.md`). Read-only: no code/test/config edits,
  no push/merge/deploy, no VM destruction. No secrets recorded.
