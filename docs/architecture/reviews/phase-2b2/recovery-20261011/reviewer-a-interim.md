# Independent Review A (Phase2B.2) — Architecture & Compatibility

**Status: INCOMPLETE — interim substantive review of `1830b06`; final two cloud
fixes not yet received, no approval.**

Reviewed commit (exact): `1830b06fe5b17e0c3feb86c06f7717a3d8dd20bc`
Parent candidate: `44156cc6ad7858059f0e45a659b63de81d258249`
(tree `488901a0e0f4b89c56c8fe23fe0fd90c18c5a544`).
Provenance: private SDK bundles verified —
source `SHA256 92df947d406f827e91782358836acc54b57fd0c219daec741ac668e45cf7dae0`
(2736437 bytes), env `SHA256
a6461ca91ed6bbeb0a0321c92958e41fc8c74f2006efb9444d68ab7c620bf156`
(1982 bytes); `git bundle verify` okay for both; isolated clone at
`/workspace/phase2b2-review`, detached clean checkout, `git fsck` clean.
Diff `44156cc..1830b06` is test-only (`tests/hosted-supervisor.test.ts`,
33 insertions/1 deletion); zero production-file changes.
Original assigned branch `/workspace/repo` untouched at `45c29d3`, clean.
All findings below are **provisional** until the EXACT final commit (with the
forthcoming two cloud fixes) is inspected. Prior incomplete/filter-interrupted
reports are not approvals.

## Findings (ordered by severity)

### P1 — Stale test asserts 403 for exhausted allowance; production returns 409 (fix pending, expected in final bundle)

- Location: `apps/cloud/test/hosted-admission.integration.ts:505` (title
  promises "exhausted allowance 403"), `:544` `assert.equal(over.status,403)`
  with `:545-548` expecting code `allowance_exhausted`.
- Production behavior (unchanged in this review window): preflight fast-fail
  `apps/cloud/src/hosted-admission.ts:310-315` throws `409
  allowance_exhausted`; diagnostic classifier `:635-637` returns `409
  allowance_exhausted|allowance_unavailable`. Verified by direct source read.
- Impact: contract mismatch between diagnostic (409 = resource-state
  conflict, retryable after quota change) and stale assertion (403 =
  authorization failure). Test currently fails against production code;
  additionally stale proposal docs still say 403
  (`docs/architecture/cloud-api-contracts.md:130`,
  `docs/architecture/reviews/phase-2b2/design-admission-original.md:147`).
- Repro: `cd apps/cloud && bun test
  ./test/hosted-admission.integration.ts -t "exhausted allowance"` → the
  `metering` test fails (in this sandbox the run additionally hit
  `ENOTFOUND api.example.invalid` from miniflare fetch, i.e. no network —
  the failure is environmental here, but the stale 403-vs-409 assertion
  stands on source comparison).
- Invariant for the forthcoming fix: change BOTH the advisory wording/doc
  touchpoints and the diagnostic assertion to 409; keep genuine 403s intact
  (capability/policy denials at `hosted-admission.ts:162-193`,
  `:570-581`; correct 403 tests at `hosted-admission.integration.ts:373,387,
  410,425` and `hosted-admission-regressions.test.ts:316,391,556,579,181`).
  Do not weaken any assertion, production auth, or quota enforcement.
- Correct-behavior reference (already green):
  `apps/cloud/test/hosted-admission-regressions.test.ts:51-59,341,353,518`
  (23 pass, 0 fail, executed with Bun 1.4.2).

### P1 — Enrollment placeholder assertion expects 404; pending fix strengthens to 400 with valid controlled payload (fix pending)

- Location: `apps/cloud/test/abuse.integration.ts:89`
  `assert.equal((await h.register(invite)).status,404)` after identity-row
  deletion.
- Production behavior: well-formed-but-unknown `enrollment_id+secret` →
  `404 not_found` via `apps/cloud/src/enrollment.ts:153-158`
  (`notFound()` = 404 at `apps/cloud/src/common.ts:50-51`); malformed bodies
  already 400 via strict Zod + global `ZodError→400`
  (`enrollment.ts:135-143`, `index.ts:698-699`, `common.ts:210-214,220,252`).
- Impact: a stale placeholder (deleted/never-issued enrollment row) is
  indistinguishable from a missing resource; the pending fix must return 400
  for a valid-but-controlled placeholder payload sent with `Idempotency-Key`
  under worker credential, plus 401 for wrong-audience and zero side effects.
- Invariant: no production-auth or quota change; no weakened assertions;
  the 404-for-cross-tenant probes (`enrollment.ts:306,386`) and
  409-consumed/410-expired/403-authorization_changed semantics must stay.
- Note: could not execute this integration test in this sandbox (miniflare
  requires network it does not have); finding rests on source + test reads,
  marked provisional accordingly.

### P2 — Test-only env-contract correction (1830b06 + ddf1da8): correct, secret isolation preserved — verified PASS

- Locations: `tests/hosted-supervisor.test.ts` (test-only delta, production
  diff empty — confirmed `git diff 44156cc..1830b06 -- . ':!tests'` empty);
  production env construction `src/hosted-runtime.ts:242-253` (compiled) /
  `:262-268` (dev); constants `src/hosted-child.ts:15-18`; child validation
  `:95-105`, renewal fail-closed `:115-143`.
- What changed: `ddf1da8` added the two mandatory boot-clock watchdog vars
  to the exact allowlist assertion with numeric/ordering checks;
  `1830b06` hardened it to validate the RAW strings against `/^\d{1,16}$/`
  (rejects `Number()`-accepted forms like `1e2`), pairs raw+numeric checks,
  and asserts launch authority (`leaseBootMs > bootBeforeLaunch` captured
  before `startControlled`) with `lease <= absolute`.
- Secret isolation intact: exact allowlist is
  `PATH, TZ, SWARMFORGE_HOSTED_DURATION, SWARMFORGE_HOSTED_LEASE_BOOT_MS,
  SWARMFORGE_HOSTED_ABSOLUTE_BOOT_MS` — no bearer/provider/repo/model
  entries; plus live negative assertion (`not.toMatch
  /sfsuper_|sfexec_|provider-secret|model-secret|repo-secret/i`) against
  `/proc/<pid>/environ`. Child fail-closed on missing/stale/malformed
  deadlines (exit 4) independent of parent.
- Executable evidence: `bun test tests/hosted-supervisor.test.ts -t
  "runtime env and logs carry no bearer"` → 1 pass (Bun 1.4.2); full file
  → 60 pass / 0 fail. Also green: `hosted-child-lease + hosted-cli + cli`
  → 20 pass / 0 fail.

### P3 — Architecture/integration coherence: PASS (provisional, no regressions observed)

- CLI selection: `src/cli.ts:502-576` dispatches; parser
  `src/cli/arguments.ts:346-377` is pure (no file/env/service reads);
  no-command defaults to `status`. Local/free commands
  (`status|artifacts|notifications|retention|usage|config|templates|doctor`
  without `--live`) use endpoint+bearer only (`src/cli.ts:187-193`,
  `src/settings/load.ts:971-974`). `serve` requires provider+model keys
  (`src/config.ts:36-57`) but no SwarmForge Cloud credential.
- Provider/child path: anonymous stdio pipes, not a socket
  (`src/hosted-runtime.ts:272-275`, `:242-271`); child enforces its own
  lease/absolute deadlines against shared `/proc/uptime` boot clock
  (`src/hosted-child.ts:25-33`, `:79-91`) with fixed initial authority
  (`:95-105`), fail-closed renewal with immutable absolute (`:115-143`),
  parent-death exit 3 (`:145-147`); parent refuses late renewal
  (`src/hosted-runtime.ts:343-373`); supervisor renews at authority/2 with
  fence/lease/tenant checks and watchdogs
  (`src/hosted-supervisor.ts:459-485`, `:487-589`).
- No unwanted cloud dependency on default path: no auto-contact at startup
  (`src/cli/hosted.ts:63-68`, `:225-226`); `doctor` non-live never probes
  (`src/cli/doctor.ts:182-191,216-219`); cloud linking opt-in via
  `swarmforge cloud login` with explicit URL
  (`src/cli/cloud.ts:25-33`); hosted submit payloads carry no secrets
  (`src/hosted-client.ts:322-330`); argv rejects raw credentials
  (`src/cli/arguments.ts:604-608`); private credential files only
  (`src/hosted-credentials.ts:87-112`).
- Free local execution without cloud credentials: yes (templates/doctor/
  config/status render locally; default endpoint
  `http://127.0.0.1:8787/mcp` at `src/settings/load.ts:523`).
- API/schema consistency: local `src/config.ts:33-207` (zod, pinned
  `schema_version:1` strict at `src/settings/load.ts:494-519`); cloud
  `apps/cloud/src/schemas.ts:1-62` all `.strict()`; frozen names
  (`apps/cloud/src/hosted-types.ts:1-5`); client mirrors server strict
  (`src/hosted-client.ts:32-110`, tenant checks `:268-280`, durable
  idempotency keys `:412-485`); migration `0003_hosted_execution.sql`
  present. Strict-both-sides rejects unknown fields fail-closed (additive
  changes require coordinated update — noted, not a defect).

## Non-findings (explicit)

- No secret-isolation weakening in the env-contract fix: allowlist exact,
  negative leak regex retained, child validation fail-closed.
- No production auth/quota change in this window (zero production diff).
- No customer execution enablement beyond the fixed inert controlled child
  (no secrets/shell/repo/arbitrary workload — `src/hosted-child.ts:12-14`,
  duration bounded ≤3.6M at `:41-52`).
- No approval, certification, or rejection of a final release is expressed:
  the two cloud fixes are outstanding and the EXACT final commit has not
  been inspected.

## Evidence summary

- `bun install --frozen-lockfile` (root): 125 packages, Bun 1.4.2.
- `tests/hosted-supervisor.test.ts`: 60 pass / 0 fail (incl. target env test).
- `tests/hosted-child-lease.test.ts + hosted-cli.test.ts + cli.test.ts`:
  20 pass / 0 fail.
- `apps/cloud/test/hosted-admission-regressions.test.ts`: 23 pass / 0 fail
  (409-for-exhaustion reference behavior).
- `apps/cloud/test/hosted-admission.integration.ts -t "exhausted allowance"`:
  fails in this sandbox on `ENOTFOUND api.example.invalid` (no network for
  miniflare) — assertion staleness confirmed by source comparison, not by a
  clean local run; to be re-verified on the final commit with network.
- Review scope was Reviewer A (architecture/backward-compat) READ ONLY;
  no source changes, no deploy/merge/destroy; both worktrees clean at finish.
