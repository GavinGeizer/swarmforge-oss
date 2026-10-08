# Phase 2A: cloud control plane, identity and tenant authority

Date: 2026-10-08. Repository: `GavinGeizer/swarmforge-oss`. Implementation branch: `phase2a-cloud-foundation`. Verified baseline: `cda607e5ca66f71f2e12761f8490e3bddf270638`, initially clean. Implementation commits: `20cc5e4` (metrics), `6ef4bc0` (cloud identity), `5b2d9c2` (reproducible local/preview tooling), `5582657` (GitHub OAuth issuer compatibility and safe diagnostics). Documentation commits `79e2787` and `81b43c8` record the original reviews and verified live sign-in. Changes are published on `swarmforge/phase2a-review-20261008`; the OAuth fix is also on `swarmforge/phase2a-oauth-issuer-fix-20261008`. No production deployment or merge to master is performed.

## Baseline and deviations

Read [Phase 1 summary](phase-1-summary.md) first, then inspected all referenced architecture documents. All were available: current-state, product-tiers, architecture-boundaries, identity-and-trust, entitlements, cloud-api-contracts, deployment, implementation-plan and validation. No missing documents were invented.

Actual source confirms the single-process Bun coordinator (`src/cli.ts`, `src/serve.ts`, `src/coordinator.ts`), SQLite WAL lifecycle store (`src/store.ts`), stateless HTTP/MCP API and global instance bearer (`src/http.ts`, `src/settings/*`), separate unauthenticated metrics listener (`src/metrics.ts`, `src/serve.ts` at baseline), injectable worker/agent providers (`src/domain.ts`, `src/providers/*`), runtime-stop hook and event credential screening. GitHub Device Flow (`src/github-oauth.ts`) and GitHub App/SSH repository handoff (`src/git-handoff.ts`, Freestyle provider) exist and remain unchanged. Existing CI checks and CLI packaging are in `.github/workflows`, `scripts/build.ts` and `scripts/package.ts`.

The website is a separate Astro/Workers-static-assets checkout with Wrangler configuration; Phase 2A does not migrate that website or alter its deployment. Phase 1's tentative operator/viewer roles are superseded only in this new cloud account API by Phase 2A's explicit owner/admin/member requirement. No other baseline contradiction was found. Existing raw local repository credential custody and permissive privileged worker handoff remain separate Phase 1 risks; cloud sessions do not reuse or import them.

Baseline command `bun --no-env-file --config=/dev/null test`: **586 pass, 2 skip, 0 fail**, 3,671 assertions, 71.90s. Root package manifest/dependency lock, CLI commands, GitHub flows, SQLite/coordinator/provider source are unchanged except the narrow metrics fix. Source comparison `git diff --name-only cda607e -- src` contains only `src/metrics.ts` and `src/serve.ts`.

## Architecture and files

`apps/cloud` is an optional standalone Workers application with its own package manifest/Bun lock and TypeScript configuration. It imports no root application or billing code. Root dependencies and tests run without installing cloud dependencies. Plain Web APIs and Zod provide a small typed router, strict validation, centralized errors and security headers; there is no new framework or orchestration rewrite.

| Files | Purpose |
| --- | --- |
| `apps/cloud/src/index.ts` | Account/tenant/session routes, authentication, membership/role checks, CSRF, cursor and transactional audit/dedupe. |
| `apps/cloud/src/provider.ts`, `crypto.ts`, `schemas.ts`, `bindings.ts` | Minimal verified-identity provider seam; fixed production GitHub adapter; Web Crypto; runtime schemas; inferred environment types. |
| `apps/cloud/migrations/0001_identity.sql` | Hosted metadata schema only; local lifecycle SQLite is untouched. |
| `apps/cloud/cloudflare.config.ts` | Typed local/preview resources, secret bindings and redacted observability; production modes rejected. |
| `apps/cloud/wrangler.config.ts` | cf build/dev backend tooling only: loopback API/inspector and fixed local ports. |
| `apps/cloud/scripts/*` | Private local environment creation, local migration completion and guarded preview migration/deployment. |
| `apps/cloud/test/*.integration.ts` | Real local D1, workerd default Worker, provider, configuration, local migration and preview-operation checks. |
| `.github/workflows/cloud-ci.yml` | Node 24/Bun 1.4.2 cloud install/check/test/types/build; no deployment or real secrets. |
| `tests/metrics-security.test.ts`, `src/metrics.ts`, `src/serve.ts` | Local operational exposure regression and narrowly scoped protection. |
| `docs/cloud/DEPLOYMENT.md`, `apps/cloud/README.md` | Commands, origins, OAuth configuration, secrets, quotas, failure/recovery and retention. |
| `docs/architecture/phase-2a-api.md`, `operational-access.md`, this summary | Implemented contracts, Phase 2B boundaries and operational policy. |

Cloud runtime dependency: Zod. Pinned development toolchain includes cf beta, its compatible Wrangler backend, matching Miniflare alpha/workerd, Workers types, esbuild, TypeScript and Biome. Dependencies are isolated from the commercial-free local engine. `cf` is used for Cloudflare operations per repository instructions; the companion Wrangler file configures only its selected backend.

## D1 schema and atomicity

Eight tables: users; external_identities; organizations; memberships; sessions; oauth_transactions; audit_events; request_dedup. UUID primary IDs, `(provider,subject_id)` immutable identity uniqueness, unique personal_user_id, `(organization_id,user_id)` membership uniqueness, unique session token hash, checked statuses/roles/expiry, foreign keys and access/expiry/audit indexes constrain persistence.

GitHub login is mutable verified profile metadata; no email matching or username uniqueness grants identity. Sessions contain only securely hashed opaque-token references. OAuth state/browser proof are hashed; recoverable PKCE verifiers are AES-GCM encrypted. Account metadata never stores GitHub access tokens, refresh tokens, private keys or client secrets. Dedupe is unique by organization/session/operation/key with fingerprint, result/status and expiry; one tenant cannot retrieve another tenant's response by reusing a key.

D1 batch transactions atomically bootstrap user, verified identity, personal organization, owner membership, session and audit records. Conditional inserts resolve simultaneous sign-ins of the same immutable subject without orphan users or duplicate personal ownership. Settings mutation, audit and dedupe form one batch with current session/user/membership rechecks. Revocation and its audit are atomic. A failed audit rolls back the protected operation. OAuth callback state consumption intentionally occurs before provider exchange in a separate atomic UPDATE RETURNING: failures require a new flow, preventing replay.

Migration has been executed through local cf/D1 and real workerd/D1 tests. It can be applied to an empty database and repeated safely. No root SQLite migration, subscription table, billing adapter, device enrollment schema or unused entitlement class is introduced.

## Implemented authentication and tenant authority

A dedicated confidential GitHub web OAuth app provides read:user identity with fixed HTTPS endpoints, exact configured callback, server-side code exchange, S256 PKCE, ten-minute random browser-bound state and immutable numeric GitHub ID verified via `/user`. Replayed, wrong-browser, arbitrary/expired state and malformed/conflicting client claims cannot create identities or sessions. The provider receives only its own credentials, not D1 or unrelated session authority. Production always uses the real fixed GitHub adapter; dependency injection exists for tests without an environment login bypass.

GitHub callbacks accept `code`, `state` and optional `iss`. The decoded issuer, when supplied, must exactly equal `https://github.com/login/oauth`; validation occurs before state consumption or provider exchange. Missing issuer remains supported for the existing fixed single-provider contract. Other issuer values, unrelated fields and duplicate parameters are rejected. The issuer never chooses an endpoint or grants account/tenant authority. Real local Brave sign-in with the dedicated app is now verified; the full failure, correction, persistence and review evidence is attached below.

Sign-in returns a random 256-bit session cookie: __Host prefix, Secure, HttpOnly, SameSite=Lax, 12-hour absolute expiry. SHA-256 hash is stored in D1; raw cookies never appear in response JSON/account metadata/audit. Every protected request queries the current session and active account; no cross-request authority cache. Current membership and active organization determine tenant access. Owner/admin may change minimal settings and list members; member may read organization metadata. Other/unknown tenant IDs return 404. Team/task labels, repository names, CLI claims, GitHub/App tokens and local global bearer grant no cloud authority.

Mutations require exact trusted Origin and HMAC CSRF proof bound to the opaque session. Signed cursors bind user, organization/list scope, purpose and ten-minute expiry; pagination rechecks membership. Idempotency replay also rechecks authority. Revoked/deleted memberships and revoked/expired sessions lose subsequent access. Already-authorized in-flight reads may finish; privileged writes recheck authority in their transaction. There is no IP/user-agent fingerprint binding, which would not prove token possession and would cause legitimate mobile/proxy failures; stealing a valid cookie remains a bearer credential risk mitigated by cookie flags, expiry and revocation.

## Implemented API

[Exact routes/schemas/errors/policies](phase-2a-api.md): public `GET /health`, `/ready`, `/v1/auth/github`, `/v1/auth/github/callback`; authenticated `GET /v1/me`, `/v1/me/personal-organization`, `/v1/session`, `/v1/sessions`; authenticated/CSRF `DELETE /v1/sessions/{id}`, `POST /v1/auth/logout`; tenant-qualified `GET` and owner/admin `PATCH /v1/tenants/{id}`; owner/admin `GET /v1/tenants/{id}/memberships`.

Success/error JSON is validated. IDs and pagination/body inputs are validated, duplicate query/cookie ambiguity rejected, JSON PATCH input streamed/bounded at 128 KiB, provider responses bounded at 64 KiB with timeouts and redirect refusal. CORS is exact-origin and credential-aware; no wildcard. Generated request IDs, no-store/nosniff/referrer/CSP/frame headers and HTTPS HSTS accompany responses. Health/readiness have no credentials or metadata detail. D1/config/provider/auth/audit failures deny closed with safe errors. Future task/worker/VM/billing/enrollment routes remain unimplemented, returning 404.

Application logs contain only generated IDs, static route templates, bounded method names and status. Audit records use fixed actions/outcomes, actor/resource/org references and safe reason codes. Cloudflare query-string trace redaction is enabled, invocation logs disabled to exclude callback URL messages. Existing local event/config screening remains unchanged. Tests check secrets are absent from persistence and newly emitted diagnostic output; this is not a claim that arbitrary upstream/platform logs can never contain secrets.

## Operational access and deployment

The separate Bun metrics listener now binds only 127.0.0.1, regardless of public API bind/allowed-host settings. It accepts loopback hosts, GET, same-origin diagnostics, and requires the existing bearer if configured. Without a configured instance bearer, local loopback diagnostics still work. Disable via existing metrics-enabled setting; remote scraping needs a private operator tunnel and bearer. No cloud metrics endpoint is introduced. Tests prove a public API bind cannot publish this listener and unauthorized clients cannot read metrics. Restart an existing coordinator to activate the source fix; this phase does not restart production infrastructure.

Local and preview modes have separate names/origins/database IDs. Preview scripts perform a read-only check for database name swarmforge-cloud-preview before writes, require explicit environment values, reject other DBs and deploy with automatic resource provisioning disabled. Secrets are uploaded with the version from a private file; local AUTH_SECRET generation uses mode 0600 and preserves existing files. No production mode/custom domain is configured.

Two cf beta issues were reproduced and fixed in setup: post-separator dev arguments are dropped, so bind/port settings live in documented backend tooling; local migration leaves a filesystem watcher open, so the wrapper awaits cf's public command entrypoint/cleanup and flushes before exit. Migrations and dev use the same .wrangler/state directory. A regression test applies/repeats migration in an isolated temporary directory; preview wrappers are tested with a recording CLI fixture, not real account mutations.

Verified current official Cloudflare Free constraints and secret/recovery instructions are in [deployment](../cloud/DEPLOYMENT.md): Workers request/CPU/memory quotas, D1 query/write/storage limits and September 2026 quota enforcement. Local tests establish neither edge CPU fit nor production capacity. Agent execution and the Bun supervisor remain external.

## Validation

Commands from repository root unless noted:

| Check | Result |
| --- | --- |
| `bun --no-env-file --config=/dev/null test` | Final **589 pass / 2 skip / 0 fail**, 3,685 assertions, 43 files, 91.06s. |
| `bun run check` | TypeScript/Biome pass, 111 root files. |
| `bun run build`, `bun run package`, `bun run package:verify` | Compiled CLI and archive/hash/layout verification pass; candidate metadata is 5b2d9c2. No release publication. |
| `cd apps/cloud; bun install --frozen-lockfile` | Pass; independent lock preserved. |
| Cloud `bun run check` | Strict TypeScript/Biome pass, 18 files. |
| Cloud `bun run test` | Latest: **25 pass / 0 fail / 0 skip**, 8.46s at source5582657, real D1/workerd plus provider/tooling/issuer checks. Original acceptance: 23 pass at5b2d9c2. |
| Cloud `bun run types`, `bun run build` | Generated bindings and cf local Worker build pass. Docker permission probe warning is nonfatal; no containers required. |
| Cloud `bun run prepare:local`, `bun run migrate:local`, `bun run dev` | Private environment file; schema applied; repeat reports []; localhost API/inspector bind verified. After OAuth configuration: health200, ready200, unauthenticated me401, GitHub initiation302. Previously missing configuration correctly returned ready503. |
| Real local GitHub browser sign-in | Owner completed sign-in in Brave; local D1 confirms verified identity, persistent account, personal organization, owner membership, active session and successful-login audit. |
| `git diff --check`; source comparison against cda607e | Pass; only root metrics source changed. |

Cloud tests cover valid/repeated/concurrent login, numeric identity and username changes/collisions; invalid/wrong-browser/expired/replayed state; disabled users; missing/expired/revoked/forged sessions; repository bearer rejection; session revocation and CSRF; role policies; cross-tenant reads/lists/updates/dedupe/cursors; deleted/revoked memberships; conditional mutation concurrency; audit rollback/bootstrap failure; database/provider/config failures; strict JSON/query/cookie/CORS/size/headers; credential-free diagnostics/persistence. The bundled deployed default Worker runs in workerd with simulated upstream GitHub HTTPS and checks the decrypted verifier against its actual PKCE challenge. It is not merely a mocked auth middleware test.

The two root skips are existing conditional finalization placeholder and optional billable live Freestyle/OpenCode/model smoke. Actual lifecycle/provider tests run. Real local GitHub web sign-in has now passed with the owner's dedicated OAuth app. Production deployment, remote preview sign-in, remote D1 migrations, real Cloudflare secrets upload, website integration, live Cloudflare quota/load and full recovery drills have not run. Root full-suite/packaging and generated-type results above belong to the original acceptance candidate; the cloud-only issuer fix reran cloud checks/tests/build, with root source and dependencies unchanged. A temporary restricted execution profile prevented local tests/Git writes with EPERM/read-only errors; after access restoration the original full suites passed. No test bypass was introduced for that environment.

## Independent reviews and disposition

Detailed original and final reviewer reports are retained in [reviews/phase-2a](reviews/phase-2a). Both SwarmForge reviewers approved the exact source candidate `5b2d9c2` against `cda607e`: [architecture/backwards compatibility](reviews/phase-2a/architecture-final.md), run `84dd3844-9c5a-4f75-9763-c33882cb6571`; [authentication/tenant isolation](reviews/phase-2a/security-final.md), run `4a82dbff-86ac-47e3-8e95-91bc0a77b088`. Each independently ran all 23 cloud tests; the architecture reviewer also ran the three metrics tests. Its full-root attempt timed out, so full-root and packaging evidence is the lead's execution, not a claimed independent rerun. No introduced P0/P1 finding remains unresolved. Review approval covers this foundation, not public-launch readiness or live provider authorization.

The initial independent security report suggested uniqueness on GitHub username as takeover prevention. That does not match the authority model: identities and sessions resolve exclusively by immutable subject ID, and repeated-sign-in/username reassignment tests prove separate accounts. It was sent back for an actual reproduction or explicit retraction. IP/user-agent session fingerprint binding is also not treated as cryptographic proof of possession. Rate limiting/abuse capacity is a real operational launch prerequisite. Original reports are preserved with an adjudication record rather than silently rewritten.

SwarmForge coder w-82055b62 was rejected: its original candidate did not implement provider verification and its unfinished follow-up could create identity without verified GitHub exchange. No coder commit or source was integrated. The lead implemented the accepted foundation independently. Rejected remote head147b0c0 and subsequent VM headc0740c8, tracked patch, untracked source/migrations/tests and package metadata were preserved; a full Git bundle was downloaded and verified before cleanup. Normal destruction refused missing required output; force cleanup occurred only after independently verifying needed source/evidence durability. Reviewers own read-only review checkouts; handoff was repaired by restoring only their install-modified lockfiles, moving their report to the correct artifact directory and attaching the exact commit to assigned branches. No review fixes were authored by reviewers.

Final cleanup inventory for team `phase2a-cloud-20261008`: all three workers are destroyed, with no pending messages or controls and no additional pages. Both reviewers completed artifact preservation and normal settled destruction after actual clean Git HEAD/assigned branch and remote SHA checks. The rejected coder's missing-output finalization is explicitly abandoned; its needed source and evidence were preserved before forced destruction. This inventory is scoped to the Phase 2A team, not other user workers.

## Remaining risks and rollout gates

- Dedicated local OAuth app registration and real Brave sign-in were completed in the follow-up below; preview app setup and real preview sign-in remain outstanding. No provider secret is committed. Local cookie behavior was verified in that browser, not every supported browser; use HTTPS where necessary. A separate website must be same-site with the API under Lax cookies; unrelated site needs a future BFF design.
- Auth/denial routes currently have no application rate limiter. Unrestricted public signup/denial traffic can exhaust Free D1 writes/storage and OAuth capacity. Configure/test edge abuse limits and bounded state/audit cleanup before public pilot; no production launch is claimed safe here.
- Validate CPU/query/write volume, quota exhaustion, secrets rotation, backup restore with revoked sessions, monitoring and retention before customers. Audit90days is a technical recommendation awaiting owner retention/deletion policy. Operator cleanup is documented, not automatically scheduled.
- cf and matching Miniflare use beta/alpha tooling pinned for reproducibility. Local setup workaround is tested, but future toolchain upgrades require regression checks. A build probes Docker and warns when inaccessible.
- Account disable/organization status/membership administration are trusted operator metadata operations until later APIs exist. No invitations, role-changing/deleting endpoints or unlink flow is advertised as implemented.
- Root repository credential custody and broad privileged runtime handoff remain pre-existing risks. Hosted hostile workers cannot be launched until a scoped repository broker, secret custody and runtime isolation are implemented.
- No subscription/entitlement source, atomic compute/inference reservations, durable external dispatch, worker leases or cost accounting is implemented. Current tenant metadata authorization does not authorize paid execution.

## Exact Phase 2B prerequisites and order

1. Local GitHub web app setup and real browser sign-in are complete. Configure separate preview app/secrets, exercise isolated preview sign-in, revocation and recovery, and establish abuse/cleanup/quota policy. Obtain separate approval for remote preview or production changes.
2. Add separate cloud CLI link-start/approve/exchange and immutable device credential schema. Bind short-lived initiating secret, verified user and explicit active organization; atomically consume, hash credentials, define audience/scopes/expiry/rotation/replay/revocation. Preserve existing github login and local configuration.
3. Add worker enrollment with distinct identities/invitation/epoch/lease and tenant authority. Workers cannot use website cookies, customer global instance bearer or unrestricted GitHub user credentials.
4. Add organization-owned server entitlements and atomic reservations at actual resource admission, then durable Bun supervisor outbox/claim/lease/stop and quota/partition tests. No paid workload dispatch before these boundaries are tested together.
5. Implement repository credential broker, tenant-bound secret custody and untrusted-worker isolation before BYOK All pilot. Establish scoped audit administration/invitations only when actual workflows need them.
6. Attach website billing in a separately scoped phase: verified Stripe events as billing source of truth, billing account to org subscription/projection, downgrade/revocation and reservation effects. Never trust frontend plan claims; retain cleanup/revocation access after downgrade.

Managed compute/inference and metered billing remain later phases. Current identity IDs, memberships, audit and D1 transaction boundaries support those additions without changing local orchestration or redesigning tenant authority.

## Attached live OAuth verification and follow-up review

Source fix: `55826573b717e88023e9b271816cf222e8b22974`, against original Phase 2A documentation commit `79e2787481ec9f7661817f60e3bdebec7242b81e`. Documentation and review evidence were committed in `81b43c86053faea3ace82d0ba2fa95ec64bf6a43`. The complete follow-up is incorporated here; the [standalone record](cloud-oauth-issuer-follow-up.md) remains available. Existing CLI GitHub Device Flow, root orchestration source and local engine dependencies are unchanged.

### Actual failure and correction

The owner registered a dedicated GitHub web OAuth app, populated the private local configuration and exercised sign-in in Brave. GitHub returned `code`, `iss` and `state`; the original strict callback schema accepted only `code` and `state`. It returned `invalid_state` before consuming the pending transaction or exchanging the code. Initial simulated provider/default-Worker tests omitted the issuer parameter, so their success did not establish real provider compatibility. The browser cookie was not identified as the cause of this rejection.

The callback now accepts an optional issuer whose decoded string must exactly equal `https://github.com/login/oauth`. This fixed value matches the observed real GitHub callback and existing authorization/token endpoint prefix. The provider exports the constant; authorization and token endpoints retain their previous fixed URLs. The client never fetches an endpoint supplied by `iss` or treats it as customer identity.

[RFC 9207 section 2.4](https://www.rfc-editor.org/rfc/rfc9207#section-2.4) describes exact issuer comparison and permits static configuration when server metadata is not used. GitHub's root OAuth metadata URL returned 404 during investigation; no discovery metadata or support flag was invented. Missing `iss` remains accepted under the existing single-provider contract. A supplied wrong/empty/malformed/duplicate issuer is denied before transaction consumption or provider exchange. A future additional provider must define its own issuer/support policy and bind it to each flow.

Strict rejection of unrelated fields, browser-bound state, PKCE, verified numeric GitHub identity, session issuance, replay defense and tenant authority remain intact. Safe internal audit reasons now distinguish `oauth_callback_parameters_invalid` from `oauth_browser_proof_missing_or_invalid`; the public error remains generic `invalid_state`. Neither reason contains incoming code, state, issuer, cookie or arbitrary query values.

### Automated and live verification

| Check | Evidence |
| --- | --- |
| Cloud `bun run check` | Strict TypeScript and Biome pass, 18 files. |
| Cloud `bun run test` | 25 pass, zero failures/skips, 8.46s. Two added tests cover issuer validation/replay and safe diagnostic distinctions. Existing no-issuer, tenant/session/CSRF, atomic audit and D1-failure cases pass. |
| Bundled default Worker/workerd | URL-encoded issuer callback completes confidential exchange and actual PKCE verifier/challenge equality against simulated upstream GitHub HTTPS with real D1. |
| Hostile callback inputs | Wrong host/scheme/path/trailing slash, empty/duplicate issuer and wrong-browser requests cannot consume state or create an account. Credential values are absent from emitted diagnostic records. |
| Cloud `bun run build` | Pass; no deployment performed. |
| Real owner browser sign-in | Owner reported successful sign-in in Brave after the fix. Read-only local D1 verification confirmed the persisted records below. |

The live local database contained exactly one active user, one verified GitHub identity, one personal organization, one active owner membership, one active session and one successful-login audit. The personal organization's owner membership matched its server-owned user. IDs, profile data and credentials were omitted from the verification output. Session revocation remains covered by automated D1 tests; the owner's live session was not revoked as part of this read-only check.

The API remained loopback-only. `.dev.vars` is ignored and private (0600); its values were neither printed nor committed. The dev-output check found no callback query values, and credential screening found no configured client secret or AUTH_SECRET in dev/test/build output or staged documentation. No migrations, Cloudflare secret uploads or infrastructure provisioning were introduced by this fix. Earlier full-root/packaging results remain historical evidence, not a claimed rerun for this cloud-only change.

### Independent review and preserved evidence

SwarmForge reviewer `w-670eb68c-2893-4a39-908a-266cd866ade8`, team `phase2a-oauth-20261008`, run `20f35b3b-c293-4803-ae39-f408e1c81f1c`, returned **APPROVED** and independently ran all 25 cloud tests. No substantive P0/P1 finding was reported. The [original report](reviews/phase-2a/oauth-issuer-review.md), [original structured result](reviews/phase-2a/oauth-issuer-result.json) and [evidence adjudication](reviews/phase-2a/README.md#oauth-issuer-follow-up) are retained.

| Original evidence | Artifact ID | SHA-256 |
| --- | --- | --- |
| Review report | art-fd99bfe3-06dd-4256-a309-d730dac7daa6 | 8941fda8e19f47e8aacf030168d41a0742c22433555d5c5e3df29c5547272d3c |
| Structured result | art-ce3658c4-3c6e-4c86-9518-8e16f1e59cc8 | 7212c1ead453d2b9dcf1c8ef7867d52f5df06fea10362fb4a974bfc3f2cf5626 |

The reviewer created redundant merge commit `ea3583845f9a5d8b54eb224ed8df67d32d3aaa82` despite the read-only Git instruction. Both that commit and source fix `5582657` have exactly the same complete Git tree `cd4038b613a5152787042c3c7f2e78416708617f`; independent `git diff --exit-code` confirmed no file differences. No reviewer commits were integrated. The auto-recorded clone base `9f2953e` differs from intended inspection base `79e2787`, explicitly named in the report. Actual VM HEAD, clean attached branch, remote persistence and preserved output were verified before normal settled destruction.

Report wording about a GitHub "breaking change" describes the observed callback incompatibility; an official rollout date or behavior of every OAuth client was not verified. Duplicate-parameter denial occurs in the router before schema parsing. This is GitHub web OAuth, not an implemented OIDC system; broad "no vulnerabilities" wording is limited to reviewed source and tested cases. Missing-issuer compatibility is documented local policy for the fixed single-provider flow.

### Cleanup and remaining scope

The follow-up team inventory contained exactly one worker, destroyed through normal settled cleanup with outputs preserved, no pending work/controls and no additional page. The original three Phase 2A workers remain destroyed. No unrelated worker was cleaned up for this follow-up.

Source fix and live-verification documentation are committed and pushed to both Phase 2A review branches. Production and remote preview remain undeployed. Public rollout abuse limits, quota/CPU checks, cross-browser verification, retention and recovery gates still apply; successful local sign-in is not a production deployment, load test or compliance claim.
