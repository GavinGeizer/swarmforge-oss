# Phase 2A identity API attachment to Phase 1 contracts

The implemented account foundation uses `/v1/me` and `/v1/tenants/{tenant_id}` naming from [Phase 1 contracts](cloud-api-contracts.md). Session-cookie web auth is the only cloud principal implemented in this phase. Github access/App tokens and the local instance bearer are never cloud credentials. Current organization roles are `owner`, `admin`, `member`, as specified by the Phase 2A user request; Phase 1's tentative `operator`/`viewer` split remains a future product decision, not an automatic mapping to paid capabilities.

Metadata routes cover current account, personal organization, tenant metadata/settings, memberships and own sessions. Owner/admin may update the organization display name and list members; ordinary members may read their organization metadata. No invitation/role mutation system is exposed yet. Account creation atomically establishes a personal organization/owner membership from verified provider identity. Existing local `team_id` and `task_id` are never tenant authority.

Website authorization code flow uses separate `/v1/auth/github` and callback routes. It does not replace `swarmforge github login`; CLI linking endpoints from Phase 1 are still unimplemented. Session termination and logout require the authenticated account plus CSRF proof. Account/membership/session state is authoritative at D1 on every request; cached browser account objects and signed cursors do not replace current membership checks.

## Implemented contracts

All IDs below are UUID strings except the internal external-provider subject (GitHub numeric ID string). Timestamps are integer Unix milliseconds. API JSON is validated with strict Zod schemas in `apps/cloud/src/schemas.ts`; OAuth profile payloads may contain provider fields, but only verified numeric ID and login are retained. Responses omit raw credentials, hashes and provider tokens. Errors are `{error:{code,message,request_id}}`, with the same generated ID in `X-Request-ID`.

| Method and path | Request | Success schema | Authority and retry |
| --- | --- | --- | --- |
| GET `/health` | None | 200 `{status:"ok"}` | Public coarse status; safe repeat. |
| GET `/ready` | None | 200 `{status:"ready"}` or coarse 503 | Public dependency check; no configuration values returned. |
| GET `/v1/auth/github` | None | 302 fixed GitHub authorize URL and browser-proof cookie | Public flow initiation. Each invocation creates a new ten-minute transaction; no idempotency key. |
| GET `/v1/auth/github/callback` | `code` (1–1024 chars), `state` (43-char base64url), optional `iss` exactly `https://github.com/login/oauth`, browser-proof cookie; no other parameters | 302 fixed `/v1/me` and session cookie | Pinned issuer when supplied; browser/state bound, verified provider identity. Atomically consumed once; retry requires a new flow. No tenant claim accepted. |
| GET `/v1/me` | Optional `limit`, `cursor` | 200 `{subject_id,display_name,memberships:[{tenant_id,role}],next_cursor}` | Active account session; memberships queried only for that user, active organization/membership. |
| GET `/v1/me/personal-organization` | None | Organization | Account's server-owned personal organization and active membership. Never accepts a requested owner. |
| GET `/v1/session` | None | Session plus `{csrf_token}` | Current authenticated session only. |
| GET `/v1/sessions` | Optional `limit`, `cursor` | 200 `{items:[Session],next_cursor}` | User-qualified query, including own expired/revoked metadata; cursor user/purpose bound. |
| DELETE `/v1/sessions/{session_id}` | Exact trusted Origin and `X-CSRF-Token`; UUID path | 200 `{session_id,revoked_at}` | Own session only; other users' IDs return 404. Repeating another session's revocation returns stable original metadata. Revoking caller ends future access (401), so callers must reconcile an ambiguous self-revocation by reauthenticating. |
| POST `/v1/auth/logout` | Exact trusted Origin and `X-CSRF-Token` | 200 `{session_id,revoked_at}`, cleared cookie | Current session revoked atomically with audit; later requests are 401. |
| GET `/v1/tenants/{tenant_id}` | UUID path | Organization | Active account plus active owner/admin/member membership; other/unknown IDs return 404. |
| PATCH `/v1/tenants/{tenant_id}` | JSON `{display_name}`, exact trusted Origin, `X-CSRF-Token`, `Idempotency-Key` | Organization | Owner/admin only; current authority rechecked in mutation transaction and before replay. Same tenant/session/operation/key + normalized payload returns original response; different payload or expired retained key returns 409. |
| GET `/v1/tenants/{tenant_id}/memberships` | UUID path, optional `limit`, `cursor` | 200 `{items:[{subject_id,display_name,role}],next_cursor}` | Owner/admin only. Tenant-qualified active rows and user/tenant/purpose-bound signed cursor; authorization rechecked each page. |

`Organization = {tenant_id,display_name,status,created_at,updated_at}`; status is active/disabled/deleted. `Session = {session_id,created_at,expires_at,revoked_at}` with nullable revoked_at. Roles are owner/admin/member. `display_name` is trimmed, 1–100 characters, control characters forbidden. PATCH rejects extra JSON fields. Idempotency keys match `[a-zA-Z0-9_.:-]{1,128}` and live for 24 hours; retained expired records conflict until operator cleanup. They cannot replay another tenant's or session's result.

Lists default to 20, accept 1–100, use keyset UUID ordering and return nullable signed next_cursor. Cursors expire in ten minutes and are opaque to clients; modified/wrong-user/wrong-tenant/wrong-purpose cursors return 400. Duplicate query keys and extra fields on paginated/OAuth requests return 400. GETs are safe to retry; snapshots may change between pages, and cursors never confer authority. All mutations require valid session, CSRF proof and origin; no client role or subscription claim is accepted.

| Status/code | Meaning |
| --- | --- |
| 400 `invalid_request`, `invalid_state`, `invalid_cursor` | Strict input/cookie/cursor/state validation failed; no secret detail returned. |
| 401 `unauthenticated` | Missing, invalid, expired or revoked session; repository/instance bearer does not substitute. |
| 403 `forbidden`, `csrf_denied`, `account_disabled` | Origin, role, CSRF or disabled-account denial. |
| 404 `not_found` | Unknown route/resource or inaccessible organization/other user's session. |
| 405 `method_not_allowed` | Unsupported method on a recognized resource. |
| 409 `idempotency_conflict` | Conflicting or expired retained key. |
| 413 `body_too_large` | PATCH JSON exceeds 128 KiB (declared or streamed). |
| 502 `identity_provider_unavailable` | Provider could not verify a consumed callback; start again. |
| 503 `temporarily_unavailable` | Configuration/database/authorization/audit/output dependency failure; denied closed. |

Unknown hosted-task/VM/worker/billing/linking routes stay 404. There is no commercial entitlement check on account metadata: a future paid route must add server-owned capability evaluation after membership/role checks. Existing Phase 1 future contracts remain designs, not deployed endpoints.

## Phase 2B CLI and worker prerequisites

CLI cloud linking is a separate `swarmforge cloud login`, website approval of a short-lived initiating-secret-bound link and explicit organization selection. No access to website cookies or CLI GitHub credential files. Use the Phase 1 link-start/approve/exchange schemas, hash initiating secrets, expire in ten minutes, rate-limit starts/polls, atomically consume and issue a distinct audience/scoped credential. Replays require the original initiating secret/key; any encrypted retry cache is bounded by expiry.

A linked installation needs an immutable device/credential ID, user+organization binding, scopes, creation/expiry/rotation epoch, last-used and revoked metadata. Future device listing/revocation must recheck account membership. Rotation must invalidate old credentials and clarify concurrent refresh/replay handling; never give unlimited worker access via a website session. Worker enrollment uses its own invitation/identity/epoch/lease, separate from account/CLI principals. These schemas and routes are intentionally not added until Phase 2B consumers exist.

Entitlements/subscriptions later attach to immutable organization/billing-account identifiers with server-owned projection. Membership role, repository permissions and paid capability are separate checks. No frontend plan/tier claim is authoritative. Billing source of truth will be Stripe, and provider webhooks must be verified, idempotent and auditable; no subscription/customer fields, billing adapter or Stripe dependency are added in Phase 2A because no current route needs them.

Resource reservations and task dispatch require tenant-owned idempotency, atomic quotas and durable supervisor delivery before any hosted worker side effect. Current metadata deduplication is the actual PATCH integration point; it is not a general license to execute paid tasks. Downgrades never block revocation/cleanup. Inference/compute accounting and any repository broker remain independent future prerequisites.
