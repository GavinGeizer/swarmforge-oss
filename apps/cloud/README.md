# SwarmForge Cloud account API

Standalone Workers/D1 application. It does not import the Bun coordinator, local SQLite lifecycle, Freestyle or CLI GitHub credentials. No task execution, worker enrollment, payments or inference endpoints are implemented.

Requirements: Bun 1.4.2 for dependencies, Node 24 for cf/testing. The cloud dependency lock is independent of the root app. cf 1.0.0-beta.13 uses the pinned Wrangler build/dev backend; commands and configuration remain cf/cloudflare.config.ts. Miniflare is pinned to the matching current SDK alpha; integration tests use its shipped v4-option converter and real workerd/D1, not mocked SQL.

From this directory:

```sh
bun install --frozen-lockfile
bun run prepare:local
bun run migrate:local
bun run types
bun run check
bun run test
bun run build
bun run dev
```

`prepare:local` creates private `.dev.vars` without printing secrets or overwriting existing configuration. Add the separate web GitHub OAuth app's ID/secret there. Local homepage is `http://localhost:8788`, callback `http://localhost:8788/v1/auth/github/callback`. Navigate to `/v1/auth/github` to sign in. Missing credentials return 503; no fake login or development authentication bypass exists. Use localhost exactly, not another Host/IP. Browser Secure cookies are supported on localhost; otherwise develop with HTTPS.

## Routes and policy

| Route | Policy / response |
| --- | --- |
| `GET /health` | Public coarse liveness `{status:"ok"}`; no sensitive data. |
| `GET /ready` | Public coarse readiness; checks origin/config and migrated D1, returns ready or safe 503. |
| `GET /v1/auth/github` | Confidential GitHub web OAuth, minimal read:user, PKCE, browser-bound state. |
| `GET /v1/auth/github/callback` | Atomically consumes state, exchanges server-side, verifies numeric GitHub ID, creates persistent account/personal organization/owner/session. |
| `GET /v1/me` | Active account cookie; own memberships, limit/cursor. |
| `GET /v1/me/personal-organization` | Active personal organization membership required. |
| `GET /v1/session` | Current active session metadata and CSRF proof. |
| `GET /v1/sessions` | Own session metadata only, limit/cursor. No token/hash values. |
| `DELETE /v1/sessions/{id}` | Own session, exact trusted Origin + X-CSRF-Token. Resource-idempotent revocation. |
| `POST /v1/auth/logout` | Current active session + CSRF; revokes and clears browser cookie. Subsequent use is 401. |
| `GET /v1/tenants/{id}` | Current active membership; other/unknown organization is 404. |
| `PATCH /v1/tenants/{id}` | Owner/admin only; JSON `{display_name}`, CSRF and Idempotency-Key required. Atomic current authority recheck, dedupe, mutation and audit. |
| `GET /v1/tenants/{id}/memberships` | Owner/admin, tenant-qualified bounded list/cursor. |

Roles owner/admin/member follow Phase 2A's requirements. Session cookies alone authenticate this API; GitHub/App/instance bearers do not. Ordinary members can read organization metadata but cannot update settings or list all members. Future invitation/identity-linking/role mutations are not exposed. Query pagination is limit 1–100 and signed user/tenant/purpose-bound cursor; authorization is rechecked on every read and before returning a deduped mutation. Unknown routes, including hosted execution/billing/enrollment, return 404. Mutations fail with 403 when CSRF/origin is missing, 400 for malformed strict inputs, 413 over 128 KiB, 409 for conflicting/expired idempotency keys, safe 503 for database/authorization/audit dependency failure.

Responses have generated X-Request-ID, no-store, nosniff, no-referrer and CSP/frame protection; HTTPS adds HSTS. CORS is exact APP_ORIGIN or WEBSITE_ORIGIN, never wildcard. Mutation origin is mandatory. With SameSite=Lax cookies, an optional separate website must be same-site with the API; unrelated workers.dev/website sites need a separate future BFF design, not weaker cookie defaults. No public operational metrics exist here.

## D1 and identity lifecycle

Migration `migrations/0001_identity.sql` creates users, external identities, organizations, memberships, sessions, OAuth transactions, audit events and request deduplication, with indexed keys/checks/FKs. D1 batch transactions serialize registration and roll back mutations when auditing fails. GitHub `(provider, numeric subject)` is immutable account identity; usernames are mutable metadata and not unique authority. No email-based linking. All new account, identity, personal organization, owner membership and session records are created in one transaction; consumed OAuth state is deliberately separate and never reused after provider/DB failure.

Opaque session tokens have 256 bits of randomness, SHA-256 storage references, Secure/HttpOnly/__Host/SameSite=Lax cookies and 12-hour absolute expiry. No cross-request authorization cache. Revocations deny subsequent requests; already-authorized in-flight reads may finish. Privileged writes recheck current user/session/membership in their atomic transaction. Disabled users cannot authenticate; disabled organizations/revoked memberships cannot authorize organization access. Account-status and membership administration are operator-owned metadata actions until explicit APIs are delivered later.

OAuth state/browser proof expire in ten minutes, are hashed and consumed with atomic UPDATE RETURNING; verifier plaintext is AES-GCM encrypted under a domain-separated AUTH_SECRET key. Callback rejects replay, wrong browser, expired state, invalid provider data and redirect responses. Provider access tokens remain transient. CSRF and cursor signatures use distinct HMAC message domains. Sessions may be revoked without a subscription check. Organization settings keys are scoped to organization/session/operation/key; exact retries return original result, changed payloads conflict, expiry is 24 hours and expired keys are rejected pending cleanup.

Audit events contain generated actor/resource references, fixed actions/outcomes, timestamp/request ID and safe reason metadata. No codes, cookies, tokens, verifier plaintext, client secrets, unverified email or IP address are stored in diagnostic records. Suggested audit retention is 90 days, pending owner policy. Pending OAuth/expired sessions/dedupe cleanup must be operator-scheduled and tested: retain unexpired state/keys, keep security audit according to policy, revoke sessions after restoring older backups. No automatic retention microservice is introduced.

## Preview and secrets

See [deployment operations](../../docs/cloud/DEPLOYMENT.md). Configuration has local/preview modes only, no production route or binding. Preview requires explicit HTTPS origin and separate D1 UUID. The deployment wrapper refuses databases not named swarmforge-cloud-preview. Before invoking it, register a dedicated preview GitHub OAuth app and configure secret bindings. No production deployment or live GitHub sign-in is performed by the local tests.

## Verification scope

Node tests execute the handler against real local D1 and execute the bundled default Worker in workerd with simulated GitHub endpoints. They cover actual confidential exchange, PKCE verifier equality, persistent identity/tenant/session, replay/expiry/revocation, cross-tenant authorization/cursors/dedupe, concurrency/atomic rollback, strict requests, dependency failures and credential-free persistence/logging. Provider redirect/invalid/oversize data tests exercise the real provider adapter. Local results do not establish provider production availability, Cloudflare Free CPU/quotas under load or compliance.
