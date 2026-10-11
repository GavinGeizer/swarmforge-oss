# Independent Review C — Phase 2B.2 Defensive Authentication/Isolation Review

**Verdict: INCOMPLETE (interim substantive review — provisional findings)**

Reviewed commit: `1830b06fe5b17e0c3feb86c06f7717a3d8dd20bc` (NOT final; two cloud
fixes still forthcoming as a small private bundle).

This is a substantive read-only review of actual source at the stated commit,
not a preflight. Findings below are **provisional** until the EXACT final
commit is inspected. Prior incomplete/filter-interrupted reports are not
approval. No approval is given in this report.

## Provenance / environment

- Source bundle `/tmp/phase2b2-review-source.bundle`: SHA256
  `92df947d406f827e91782358836acc54b57fd0c219daec741ac668e45cf7dae0`,
  2736437 bytes — verified.
- Env bundle `/tmp/phase2b2-env-reviewed.bundle`: SHA256
  `a6461ca91ed6bbeb0a0321c92958e41fc8c74f2006efb9444d68ab7c620bf156`,
  1982 bytes — verified.
- Isolated clone `/workspace/phase2b2-review`: candidate
  `44156cc6ad7858059f0e45a659b63de81d258249` /
  tree `488901a0e0f4b89c56c8fe23fe0fd90c18c5a544` verified; env head
  `1830b06fe5b17e0c3feb86c06f7717a3d8dd20bc` checked out detached;
  `git fsck --full` clean; checkout clean.
- Original assigned repo `/workspace/repo` unchanged at `45c29d3`, clean.
- Bun `1.4.2` (pinned), `bun install --frozen-lockfile` used. Read-only review;
  no source changes, no deploy/merge/destroy.

## Test evidence (executed, controlled local fixtures)

- `bun test tests/hosted-supervisor.test.ts`: 60 pass, 0 fail (~65s).
- `bun test tests/hosted-child-lease.test.ts tests/cloud-worker-client.test.ts`:
  23 pass, 0 fail (~36s).
- `bun test tests/hosted-cli.test.ts`: 4 pass, 0 fail.
- `bun test tests/core.test.ts tests/cli-redaction.test.ts`: 13 pass, 0 fail.
- Real-cloud suites (124 tests incl. enrollment/allowance paths) NOT run here:
  no production auth; findings on those paths are code-level and provisional.

## Scope covered

Tenant ownership, credential audience/scopes, revocation/expiry, supervisor vs
worker boundaries, secret custody/redaction, expired execution authority,
untrusted execution gate. Controlled fixtures only.

## Findings (ordered by severity; provisional)

### P1 (provisional High) — Local plane has no tenant isolation; hosted tenant checks stop at supervisor boundary

- Local HTTP/MCP/store/artifact surfaces authenticate a single bearer
  (`src/http.ts:31-40`) and never bind a tenant principal. `team_id`/`task_id`
  are namespaces, not ownership boundaries: any token holder can name any
  team/task/worker/artifact.
  - `src/store.ts:313-326` (`get`/`all`), `107-142` (`queryWorkers`),
    `403-435` (dispatches incl. `saveDispatch` by `run_id` alone),
    `366-402` (events/lifecycle), `609-693` (result/usage).
  - `src/mcp.ts:230-458,500-542,563-786` (all worker/artifact/task tools,
    global `get_dashboard_view`), `src/http.ts:45-74` (`/events`, artifact
    download checks `preserved` only).
  - `src/artifacts.ts:252-258,375-462,533-771`, `src/artifact-store.ts:686-704`
    (artifacts table has no `tenant_id`), `1082-1163` (get/find/list).
- Hosted staging lands as ordinary `team_id:"hosted"` local workers
  (`src/hosted-supervisor.ts:273-280`), so a local caller can
  get/control/read-artifact another tenant's hosted worker.
- Hosted-side per-row tenant/fence checks are real and tested
  (`src/hosted-client.ts:268-280,494-563`,
  `src/hosted-supervisor.ts:99-100,173-216,514-525,826-872`,
  `src/hosted-store.ts:282-292,360-392,450-455`; tests at
  `tests/hosted-supervisor.test.ts:871-935,1162-1189,1308-1379,2114-2235`).
  They do not extend to the local plane.
- Impact: if the local daemon/MCP/HTTP is ever multi-tenant or remotely
  reachable, full cross-tenant IDOR. If it is strictly single-tenant loopback
  by deployment, severity drops to Medium/defense-in-depth.
- Repro: `Store(":memory:")` + two teams; cross-team `get`/artifact download
  succeeds; hosted `claimMapping({tenant_id:T1})` + stage, then act as T2 via
  local MCP — succeeds.
- Suggested invariant: thread a tenant principal through Store/MCP/HTTP (or
  document single-tenant-loopback as a hard deployment constraint with a
  fail-closed bind check).

### P2 (provisional Medium) — Shared HostedStore file: renew/stop/settle/reconcile take task_id only, never compare mapping tenant vs credential tenant

- `src/hosted-store.ts:393-478,486-636,696-796` (`get`, `rebindLocalWorker`,
  `updateLease`, stop markers, settlement, idempotency) and
  `src/hosted-supervisor.ts:487-589,595-612,813-890,900-975`
  (`renewOnce`, `stopAndConfirm`, `settle`, `recover`/`reconcile`) never
  compare `mapping.tenant_id` vs `client.tenantId` / `credential().tenant_id`.
  Only `claimOnce` (`:99-100`) and per-row fence checks do.
- State path is CLI-overridable (`src/cli/hosted.ts:40-61,110-133`); two
  supervisors with different tenants pointed at one `--state-path` (or a
  copied file) silently share fate; `reconcile()` will stop+settle foreign rows.
- Repro: two supervisors (TENANT_A/B), same store; claim T1 row, then
  `supervisorB.renewOnce/settle/reconcile` acts on it; expect `throw /tenant/`.
- Suggested invariant: `renew/stop/settle/reconcile` precondition
  `mapping.tenant_id === client.tenantId === credential().tenant_id`.

### P3 (provisional Medium) — ackAndStart entry accepts arbitrary task object without tenant-vs-credential check

- `src/hosted-supervisor.ts:144-169` falls back to
  `claimMapping({...task.tenant_id...})` with no
  `task.tenant_id === client.tenantId` guard (contrast `claimOnce:99-100`).
  Public method and direct test seam; later ack-reply check (`:203-216`)
  binds reply-vs-input, not input-vs-credential except via server.
- Repro: `supervisor(TENANT).ackAndStart(taskBody({tenant_id:OTHER}))` with
  mocked ack inserts foreign mapping; should throw before claim/grantStartRight.

### P4 (provisional Medium) — HostedTaskClient never checks expiry locally; supervisor factory doesn't either

- `src/cli/hosted.ts:141-158` constructs `HostedTaskClient` without
  `hostedCredentialExpired` (`src/hosted-credentials.ts:138-142`);
  `submit/read/cancel` (`src/hosted-client.ts:306-383`) go straight to network.
  Expired `sfexec_` burns a request + leaks timing instead of fail-closed.
- `createHostedSupervisor` (`src/cli/hosted.ts:70-139`) likewise builds on
  expired supervisor credential; failure surfaces only at first claim.
- Also `hostedCredentialExpired` ignores `authorization_expires_at` (schema
  guarantees ordering at issuance, but a server-shortened authorization is not
  re-checked); `rotate()` reply unchecked for freshness
  (`src/cloud-client.ts:283-293` vs `exchange:252-255`).
- Repro: save `sfexec_` with `expires_at=now-1`; client constructs and
  `submitTask` attempts fetch instead of throwing.

### P5 (provisional Medium) — No hosted task/supervisor logout-revoke/rotate CLI; GitHub logout is local-only

- `src/hosted-credentials.ts:130-135` deletes are local; `src/cli/hosted.ts`
  exposes no `revoke`/`rotate` wiring (only library `SupervisorClient.rotate`,
  which itself only validates `{credential:min(1)}`,
  `src/hosted-client.ts:412-485`, without successor scope/tenant/expiry
  checks unlike worker `src/cloud-worker-client.ts:365-374`).
- `src/cli/github.ts:30-40` logout is local `unlink` only; token stays valid
  until manual revoke. Cloud CLI logout pairs delete+revoke — hosted/GitHub do not.
- Impact: stolen `sfexec_`/`sfsuper_` cannot be revoked from CLI.

### P6 (provisional Low/Medium) — Redaction gaps: query params, JSON-escaped secrets, pre-coordinator errors

- `src/security.ts:62-65` misses `access_token|secret|credential|authorization`
  params (`?access_token=gh_...` passes through).
- Coordinator `Redactor` lacks the JSON-escaped variant that only
  `src/serve-command.ts:41-44` has; a secret containing `"`/`\n` in JSON logs
  misses.
- `src/serve-command.ts:45-52` pre-coordinator redactor omits `oauthSecrets`,
  `server_passwords`, enrollment secret.
- `SECRET_KEYS` (`src/settings/inspect.ts:6-10`) covers 3 env keys only.
- Verified present: `sf*` pattern + url/base64 coverage
  (`src/security.ts:40-67`), `serve-command` + CLI scrub, settings redaction;
  redaction tests pass (`tests/cli-redaction.test.ts`).

### P7 (provisional Low) — Supervisor identity has no audience field; worker identity pins epoch-less expected

- `supervisorIdentitySchema` (`src/hosted-client.ts:93-109`) has no `audience`
  vs worker `audience:"worker-identity"` (`src/cloud-worker-client.ts:63`);
  `SupervisorClient.identity():392-404` passes `expectedTenant=undefined`.
- Worker `identity()` (`:309-320`) pins `worker_id`/`tenant_id` but not
  `registration_epoch`; `rotate` clears pending on `401/409/410` while hosted
  clears only on `401/409` (`src/hosted-client.ts:477-482`).
- GitHub `repo` scope (`src/github-oauth.ts:165`) is broad by provider design;
  only client-side repo-string check (`:84-89`) constrains it.

### Strengths confirmed (do not regress)

- Supervisor/worker credential audiences strictly separated (`sfexec_` vs
  `sfsuper_`, tuple scopes, `.strict()`); cross-audience tests pass.
- Claim/ack/renew/settle fence+lease+tenant binding per row, idempotent
  settlement with sha256 fingerprint, immutable triggers.
- Lease math with RTT/margin, thin-lease refuse, TOCTOU recheck, unref
  watchdog + child self-expiry; boot-clock fail-closed parsing + renewal IPC
  validation; exact child-env allowlist (PATH/TZ/HOSTED_CHILD/DURATION/LEASE/
  ABSOLUTE) with poisoned-env test at `tests/hosted-supervisor.test.ts:2371-2454`
  — the final env correction (raw-string shape + captured boot authority,
  `1830b06`/`ddf1da8`) preserves this and passes.
- Untrusted execution not executable on hosted path: `execution_class`
  literal, fixed inert workload, provider exec/read/write all throw,
  fixed staging role/prompt, compiled self-spawn, empty-cwd proof.
- Secret custody: 0700/0600/O_NOFOLLOW/nlink==1/atomic+fsync; submit body
  fixed 5 keys with exact-key test; parser rejects raw secrets.

## Known forthcoming cloud fixes (not yet inspected — no judgment here)

- Real-cloud 124 tests: 122 pass, 2 fail — (a) stale enrollment placeholder
  404 now malformed 400 (strengthen using valid controlled payload +
  Idempotency-Key with worker credential, 401 wrong-audience, zero
  side-effects); (b) allowance_exhausted production 409 contrary docs 403
  (fix both advisory and diagnostic, keep other 409). Neither authorizes
  weakened assertions or production auth/quota changes. These arrive as the
  final small private bundle; this report makes no claim about them.

## Explicit statement

Provisional findings P1–P7 identified above at `1830b06`; no approval given.
Final verdict (APPROVED / CHANGES_REQUESTED / INCOMPLETE) awaits inspection of
the EXACT final commit including the two cloud fixes. A blocked review remains
incomplete; no filter or approval rejection is bypassed.
