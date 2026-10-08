# CLI linking and worker identity operations

Phase 2B.1 adds identity only to the separate `apps/cloud` application. Root self-hosting, Bun orchestration, SQLite, Freestyle, repository authentication and GitHub Device Flow require no cloud account. No enrolled worker can launch a workload through this service. See [implemented routes and schemas](../architecture/phase-2b1-api.md).

## Local setup and validation

Use Bun 1.4.2 and Node 24. From the root checkout:

```sh
bun install --frozen-lockfile
bun run check
bun test
bun run build
bun run package
bun run package:verify
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

The additive `0002_machine_identity.sql` migration follows `0001_identity.sql`. Repeating `migrate:local` is safe and reports no pending migration. It operates only on the fixed local UUID and `.wrangler/state`. Tests create isolated real D1 databases, apply both migrations and run the default Worker under workerd. Tests simulate GitHub upstream responses; the CLI integration also runs the real Bun CLI against a loopback HTTP bridge into that Worker.

The existing separate confidential GitHub OAuth app remains the website identity provider. Populate private `.dev.vars` through a local editor with `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and the generated `AUTH_SECRET`; never paste secrets into CLI arguments. Homepage is `http://localhost:8788`, callback `/v1/auth/github/callback`. There are no new required environment variables or OAuth apps for CLI pairing. Follow [deployment procedures](DEPLOYMENT.md) for origins and preview isolation. Live browser linking requires running the migrated API and completing real GitHub sign-in; simulated integration tests do not establish a live preview result.

From another terminal at the root, run:

```sh
bun --no-env-file --config=/dev/null src/cli.ts cloud login --cloud-url http://localhost:8788 --no-browser
bun --no-env-file --config=/dev/null src/cli.ts cloud status
bun --no-env-file --config=/dev/null src/cli.ts cloud organizations
bun --no-env-file --config=/dev/null src/cli.ts cloud use <organization-uuid>
bun --no-env-file --config=/dev/null src/cli.ts cloud rotate
bun --no-env-file --config=/dev/null src/cli.ts cloud logout
```

Use `swarmforge` instead of the Bun prefix for the packaged executable. `SWARMFORGE_CLOUD_URL` can set the exact cloud origin; no commercial default is silently contacted. HTTPS is mandatory except localhost/127.0.0.1. `--credentials` or `SWARMFORGE_CLOUD_CREDENTIALS_PATH` selects the credential file. `--json` prints safe metadata. `--no-browser` prints the approval URL and manual pairing code without launching a browser; no TTY is required, but a human must approve. SIGINT/SIGTERM cancels pending pairing. Denial, expiry, unavailable service, invalid response or revoked credentials return nonzero with fixed safe errors.

## Pairing, organization selection and recovery

The CLI retains a 256-bit initiating secret in memory and sends it only to the configured cloud origin in `Authorization: LinkInitiator`. The displayed code is a separate 72-bit browser approval challenge. Links expire after ten minutes. Polling is bounded to five seconds and requires the initiating proof. The approval page displays the requesting installation name and organization choice, uses the existing active browser session/CSRF proof, and requires explicit approval plus the displayed code. The browser session never leaves the browser. The code alone cannot poll or exchange credentials.

Approval binds the user, organization, session and scopes. Exchange rechecks that authority in the atomic D1 transaction, consumes the link once and creates one installation and credential. Exact same-proof/key retries recover the encrypted response while the transaction is live and the issued credential remains valid. Other keys/proofs conflict or deny. Five invalid browser code attempts lock a pending link; start a fresh one. Requested organizations are choices, never evidence of membership.

`cloud use` creates a fresh link requesting the selected organization and needs new browser approval. It cannot retarget an existing credential. The CLI atomically saves the new credential, then attempts to revoke the previous installation at its original origin. An unconfirmed revocation is reported; use the website device revocation API to remove that installation. Failed local storage triggers an attempt to revoke the newly issued installation.

CLI credentials expire after 24 hours, worker credentials after one hour; both have a maximum 30-day authorization grant. Rotation advances the resource epoch and invalidates previous credentials. The same rotation key can recover the successor for ten minutes only on the rotation route; the old token cannot access ordinary APIs. The current CLI does not persist pending rotation keys: if a rotation response or local write is lost, repeat browser login and revoke the previous installation. Rotation does not extend the authorization grant. Fresh approval/enrollment is required after grant expiry.

Logout requests server revocation and deletes the local file. If the server is unreachable, it reports that server revocation was not confirmed and exits nonzero. Local deletion cannot revoke a copied token. Website `DELETE /v1/tenants/{tenant}/cli-installations/{id}` is the recovery path; owner/admin can manage all installations in their organization, members only their own. No credential value is returned by listing/status APIs.

## Credential storage

OS credential vault integration is deferred: the advertised package is Linux x64 and the implemented fallback uses POSIX permissions on Linux/macOS. Windows storage fails explicitly. The file is separate from GitHub credentials, normally beside the XDG/default SwarmForge config as `cloud-credentials.json`. It must have a user-owned private parent directory (0700), a user-owned regular file with no group/world permissions (0600), one hard link, and no symlinks in the path. Ancestors must be owned by the user/root and not writable by other users, except root-owned sticky temporary directories. Use a canonical path on systems whose usual temporary path is a symlink.

Reads use no-follow/nonblocking flags and bounded strict schemas. Writes use an exclusive private temporary file, fsync and atomic rename, followed by directory fsync. This protects against accidental disclosure and replacement by other users; it does not encrypt against the same OS user, root or disk access. Exclude this file from backups/uploads unless separately protected. Do not copy it to workers, agent environments, prompts, snapshots or artifacts. Corrupt or unsafe storage is refused with a fixed error; repair the directory/file permissions or choose a fresh private path, then revoke the prior installation and sign in again.

## Worker enrollment

An owner/admin website session creates a short-lived organization-owned invitation at `POST /v1/tenants/{tenant}/worker-enrollments`, with Origin, CSRF and an idempotency key. Its response contains a single-use enrollment secret. Transfer it through a protected channel into customer worker memory/configuration; do not log it, place it in process arguments or publish it as an artifact. An actual worker enrollment CLI/runtime integration is deferred to Phase 2B.2.

The worker exchanges it at `POST /v1/workers/register` using `Authorization: Enrollment`, an idempotency key and the strict contract body. The authorizing account/session must still be active and owner/admin at consumption. The invitation's organization is authoritative; runtime hints establish no ownership. It receives a separate `sfworker_` credential with only `worker:identity` and `worker:rotate`. `GET /v1/workers/me` verifies it; `POST /v1/workers/me/rotate` rotates it. Owner/admin listing and revocation are tenant-qualified website operations. Invitations and registered identities do not confer execution, repository or entitlement scopes.

## Revocation policy

Every machine request checks hashed credentials, audience, expiry, epoch, resource status, active account, active organization and active authorizing membership directly in D1. Workers additionally require the authorizer to retain owner/admin role. Membership removal, account disablement and organization suspension deny the next request; there is no cross-request authorization cache. Already authorized in-flight reads can finish. Privileged mutations recheck authority in their atomic transaction.

Restoring an active membership/account/organization may restore access to an unrevoked credential whose grant and token are still valid. For permanent invalidation revoke the installation/worker; changing status alone is temporary suspension. Ownership changes do not transfer existing machine identities: grants remain tied to their authorizer, and workers lose access if that user ceases to be owner/admin. Browser logout/revocation prevents pending exchange but does not revoke already consumed machine grants. Revoke those separately for incident response.

After restoring an older D1 backup, revoke restored browser sessions and all machine credentials/resources before opening service, advance resource epochs and rotate `AUTH_SECRET` to invalidate pending encrypted material and signed cursors/CSRF. Do not assume a backup preserves the latest revocations. Key rotation alone does not invalidate independently hashed session/machine tokens. A tested remote recovery drill remains a rollout prerequisite.

## Abuse, quotas and cleanup

The application enforces fixed one-minute D1 budgets using HMAC references to trusted Cloudflare `CF-Connecting-IP`: OAuth initiation 20/min, callback 60/min, CLI initiation 10/min, link routes 90/min, worker routes 60/min and other protected routes 120/min. Loopback tests share a fallback bucket when the edge header is absent. Never expose the local emulator publicly or trust a reverse proxy that forwards user-controlled edge identity headers. Per-link polling and five-attempt approval locking apply independently. Technical caps are 100 active installations, 100 registered workers and 25 pending worker invitations per organization; these are protective caps, not subscription plans.

Counter/authorization dependency failure denies access with safe 503. Over-budget requests return 429 with bounded Retry-After. Unauthenticated generic denials do not create an audit row; authenticated denials and OAuth callback failures share a capped eight/minute diagnostic budget. Successful security mutations remain atomically audited. Structured application logs contain request ID, route template, method and status, never raw URLs/query parameters, headers, body or raw exception text.

Application rate limiting still requires a D1 operation per attempt and is not protection against distributed quota exhaustion. Configure edge request/bot controls and alerts for public identity routes before preview exposure, verify what the selected Cloudflare plan supports, and measure CPU/D1 writes under expected traffic. Missing edge protections are a rollout risk, not a reason to allow failed authentication. Workerd tests measure local elapsed time only, not the Free plan's 10 ms edge CPU limit. See current official quota references in the deployment guide.

Scheduled cleanup runs every ten minutes and bounds each of nine queries to 500 rows. It deletes expired transient state/rate counters/dedupe/rotation caches, clears expired encrypted reply/code material, deletes unreferenced expired invitations/links and removes unreferenced expired sessions. Referenced identities and security audits remain for investigation. A backlog may require repeated runs and quota monitoring. Expired credentials and revoked resources remain as historical metadata; plan archive/account deletion policy before large adoption.

Local maintenance, while the local database exists:

```sh
cd apps/cloud
bun run cleanup:local
# Optional only after the owner chooses the audit retention period:
bun run cleanup:local -- --audit-retention-days 90
```

Default cleanup never deletes audits. Explicit local audit pruning accepts 7–3650 days, bounded to 500 events/run. The 90-day value is a technical recommendation, not an approved product policy. Remote scheduled cleanup uses the same bounded statements without audit pruning. No public maintenance endpoint exists. Before changing retention decide deletion/export requirements, backup retention and investigation access.

## Preview gate

No remote preview or production deployment is authorized by Phase 2B.1. The existing preview wrappers verify the database name, explicit separate UUID, HTTPS origin, private secrets file and disabled automatic provisioning. Apply both migrations only after separate preview authorization, then deploy with the documented cf wrapper. Confirm exact GitHub callback configuration, live browser pairing, revocation, operational edge controls, CPU/quota measurements and recovery before permitting customers. The external coordinator API/metrics/inspector remain separate private operational interfaces.
