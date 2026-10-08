# Cloud API local and preview operations

The cloud API lives in `apps/cloud` and uses an independent Bun lockfile. The self-hosted coordinator remains the root application. Use Node 24 for `cf` and integration tooling; `cf` programmatic configuration cannot load on Bun. Bun 1.4.2 remains the dependency manager and root application runtime. The website is a separate Wrangler-configured checkout and is not migrated by this phase.

## Environment separation

`apps/cloud/cloudflare.config.ts` supports `local` and `preview` only. Other modes are rejected. It declares no production custom domains, routes or resource bindings. Local worker name is `swarmforge-cloud-local`; metrics remain with the external coordinator, not the Worker. Local API origin is `http://localhost:8788` and the D1 local UUID is `00000000-0000-4000-8000-00000000002a`.

Preview uses worker/database name `swarmforge-cloud-preview`. Configuration requires explicit `CF_PREVIEW_D1_ID` and HTTPS `CF_PREVIEW_API_ORIGIN`; optionally `CF_PREVIEW_WEBSITE_ORIGIN`, otherwise same origin. `scripts/deploy-preview.mjs` and `scripts/migrate-preview.mjs` check the actual D1 database name before any writes and refuse other names. Deployment disables automatic resource provisioning. All account operations use `cf`; the new companion `wrangler.config.ts` contains only local backend tooling settings. Existing Wrangler website commands remain separate. Preview is an isolated persistent Worker configuration, not a request to deploy the commercial production service.

Secrets are `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `AUTH_SECRET` via Cloudflare secret bindings and private local `.dev.vars`. The client ID is not confidential but is kept in the same per-environment configuration process. `scripts/prepare-local.mjs` generates a random local AUTH_SECRET without printing it or overwriting an existing file. Never commit `.dev.vars`, export the provider secret to the browser, reuse the CLI OAuth app or put secrets into command arguments/history. Keep local and preview GitHub apps/secrets separate.

`AUTH_SECRET` protects encrypted OAuth PKCE verifiers and session CSRF/cursor signatures with domain separation. Rotation invalidates pending OAuth state/CSRF/cursors; existing opaque session token hashes are independent. Coordinate rotation with session revocation or explicit user reauthentication. Full key rollover/versioned device credentials are Phase 2B work.

## GitHub web OAuth setup

After code validation, create a dedicated confidential GitHub OAuth app. Local homepage: `http://localhost:8788`; callback: `http://localhost:8788/v1/auth/github/callback`. For preview, use the exact API origin and `/v1/auth/github/callback`, and register it on a different GitHub OAuth app. No arbitrary `redirect_uri` or return URL is accepted by the API. A changed domain/port requires updating both app registration and Cloud API configuration.

The API requests minimal `read:user`, uses S256 PKCE, exchanges codes server-side and verifies the numeric GitHub ID via `/user` on every sign-in. GitHub access tokens stay transient and are not local CLI or cloud session credentials. Neither username changes nor email matching create identity authority. Configure secrets before real sign-in: a missing/invalid configuration fails readiness and authentication closed. The user chose to register this separate app after code is ready; no live GitHub authorization is claimed by this phase.

Official [GitHub web authorization documentation](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps) currently specifies S256 PKCE challenge/verifier support and identity revalidation after every exchange.

## Cloudflare Free constraints verified 2026-10-08

Workers Free: 100,000 requests/day, 10 ms CPU per HTTP request, 128 MB memory. D1 Free: 10 DBs/account, 500 MB per DB, 5 GB total storage, seven-day Time Travel, 50 queries/invocation; daily five million rows read and 100,000 rows written. Index maintenance also consumes writes. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [D1 quota behavior](https://developers.cloudflare.com/d1/platform/pricing/).

D1 daily query limit enforcement began September 1, 2026; exhausted queries fail until midnight UTC. Auth/authorization/audit-dependent mutations must return a safe unavailable error and never grant access on dependency failure. New identity flows may need restart after an ambiguous provider/DB outcome; consumed callback state is intentionally not replayable. [Enforcement notice](https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/).

Use indexed bounded lookups and small atomic D1 batches. Verify deployment CPU/query/write volume before paid rollout; local integration tests do not prove edge CPU capacity or D1 quotas under load. No long-running agent, VM lifecycle, inference or artifact execution occurs in Workers.

## Logging and recovery

Configuration enables logs/traces, strips request query strings at platform level (`redactQueryString:true`), and disables invocation logs to keep callback URLs out of stored invocation messages. Application logging uses safe route templates/request IDs/status, not incoming URL/headers/body or raw exception text. [Configuration reference](https://developers.cloudflare.com/cf/projects/config-explorer/), [invocation logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/).

D1 is authoritative for sessions, account/membership status and dedupe. No cross-request auth cache. Take encrypted metadata backups and test restore before live customers; never restore revoked sessions as active authority. Issuer tokens are not stored in the schema. Audit retention is a documented technical recommendation, pending owner policy; cleanup must not erase live dedupe or pending OAuth state. Local/preview migration and exact check commands are recorded with the final implementation summary and package README.

No Cloudflare production resources, website routing or production secrets are changed by this phase. Production deployment needs separate authorization and operational validation.

## Reproducible local setup

From the repository root, run:

```sh
cd apps/cloud
bun install --frozen-lockfile
bun run prepare:local
bun run migrate:local
bun run types
bun run check
bun run test
bun run build
bun run dev
```

Migrations and dev use `.wrangler/state`; the backend tooling file pins API to `127.0.0.1:8788` and inspector to `127.0.0.1:9229`. Keep the inspector private. The root Bun coordinator/metrics are separate listeners. The pinned beta does not forward post-separator dev arguments, so these options are configuration rather than ineffective CLI flags. Local migrations await the public cf `runMain` entrypoint and flush output before exit, working around its retained filesystem watcher without guessing completion from output or terminating pending writes. Repeating migration reports `[]` and leaves the schema intact.

`curl -i http://localhost:8788/health` returns 200. With generated AUTH_SECRET and migrated database, `/v1/me` without a cookie returns 401. `/ready` and OAuth initiation return 503 until the dedicated GitHub app is configured. No synthetic sign-in is enabled. The automated default Worker test uses intercepted upstream HTTPS responses in workerd; live sign-in still needs the owner's app setup.

## Preview procedure (not executed in this phase)

These commands create/change isolated remote preview resources. Run them only when preview setup is authorized, after checking the account and dedicated OAuth application. They are not production deployment commands.

```sh
cd apps/cloud
cf auth login
export CLOUDFLARE_ACCOUNT_ID='<preview-account-id>'
cf d1 create --name swarmforge-cloud-preview
# Use the UUID returned above. No existing production database is permitted.
export CF_PREVIEW_D1_ID='<new-preview-database-uuid>'
export CF_PREVIEW_API_ORIGIN='https://swarmforge-cloud-preview.<account-subdomain>.workers.dev'
# Default website origin is the API origin. Use a same-site origin if separate.
bun run migrate:preview
```

Create a private file outside the repository with JSON keys `AUTH_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and their string values. Generate AUTH_SECRET with at least 32 random bytes; do not copy a local key or put values into shell arguments. A local editor or secret manager can fill the file. Register the preview callback at exactly `${CF_PREVIEW_API_ORIGIN}/v1/auth/github/callback` on its separate OAuth app before deploying.

```sh
chmod 600 /private/path/swarmforge-preview-secrets.json
export CF_PREVIEW_SECRETS_FILE='/private/path/swarmforge-preview-secrets.json'
bun run deploy:preview
```

The wrapper performs read-only `cf d1 get` to check the name, then `cf deploy --mode preview --provision=false --secrets-file <private-file>` to upload the version and its secrets together. Origins/configuration are validated and production modes rejected. For later secret changes use the same reviewed deployment procedure; never use diagnostic dry-run output with real secret values. Remove the private transfer file securely according to the workstation's storage policy. The resource commands/flags were checked against the installed pinned CLI; no remote migration/deployment, public callback, or secret upload was exercised here.

## Retention and recovery policy

Owner approval is still needed for the audit retention period (technical recommendation: 90 days), account deletion/export and incident procedures. Operator cleanup should remove expired OAuth transactions, expired dedupe rows and expired/revoked sessions only after their security/audit retention obligations are met. Delete dependent dedupe rows before session deletion; preserve live idempotency records and unexpired sessions. Audits use immutable references and safe reason codes, not provider profile payloads or secrets.

D1 batch is atomic; an audit failure rolls back account bootstrap and settings/session mutations. Callback state is consumed before contacting GitHub: a failed/ambiguous exchange or database failure requires starting sign-in again. Disabling accounts/organizations or revoking membership/session takes effect on the next authorization lookup; already-authorized in-flight reads may complete. Restore from backup must revoke restored sessions before opening service, and invalidate pending state/CSRF/cursors through coordinated AUTH_SECRET rotation. Validate this operator recovery procedure in preview before live customers.
