# Phase 2A implementation plan

User Phase 2A request is the governing specification and authorizes autonomous implementation, previews, migrations, tests and commits. No production deployment, Stripe, worker enrollment/execution, managed compute/inference or CLI repository identity changes.

## Verified baseline

HEAD `cda607e`; clean checkout. All Phase 1 documents present. Existing Bun coordinator, WAL SQLite lifecycle, GitHub Device Flow/App adapter, global API bearer, injectable worker/agent interfaces, runtime-stop hook and event redaction confirmed. Separate metrics listener still used public API bind without authentication. Existing website is separate Astro/Workers-static-assets checkout with Wrangler configuration; it is not modified for an unrelated cloud API.

Baseline: `bun --no-env-file --config=/dev/null test` — 586 pass, 2 skip, 0 fail, 3,671 assertions, 71.90s. Baseline source staged at `swarmforge/phase2a-base-20261008` for exact SwarmForge worker handoff. Lead branch `phase2a-cloud-foundation`.

## Design

Standalone `apps/cloud` Workers application and independent Bun dependency lock. Plain TypeScript/Web APIs/Zod plus D1 bindings; no framework. Cloudflare `cf` programmatic configuration, pinned tooling, Node 24 for the cloud tooling (cf config explicitly does not load on Bun); existing app runtime stays Bun. No commercial core imports. Local D1-compatible integration testing uses Miniflare/workerd and only the upstream GitHub identity provider is simulated in tests.

Cloud web GitHub OAuth is separate from CLI Device Flow: minimal identity scope, confidential server exchange, S256 PKCE (verified supported by current GitHub docs), short-lived hashed browser-bound state, encrypted verifier, exact callback origin, immutable numeric GitHub identity, no email/username matching. Opaque session cookie, token hash at rest, absolute expiry, server revalidation, CSRF HMAC, explicit organization owner/admin/member roles. Tenant-qualified D1 queries, signed principal/tenant-bound keyset cursors, atomic mutation/idempotency/audit and concurrent registration protection. Response validation, safe structured errors/logs, explicit origin policy, streamed input bounds and security headers.

No billing/entitlement enforcement layer is needed by free account metadata routes. Future subscriptions attach to organization IDs; CLI/device credentials remain Phase 2B contracts.

## Ownership and order

1. Lead: operational metrics loopback bind and configured bearer protection; failing exposure test then narrow fix and local compatibility checks.
2. SwarmForge coder `w-82055b62-07b6-4c24-9137-883a70c02e3c`: owns only `apps/cloud` application/source/schema/local integration tests/package lock/readme. Base `cda607e`; no deployment/root/website changes. Commits and persists assigned branch.
3. Lead: separate cf preview/local configuration, binding type generation, local migration/build reproducibility, CI cloud checks, docs and integration. No remote production resources.
4. Independent SwarmForge reviewers: architecture/backwards compatibility and authentication/tenant isolation. Review exact candidate hashes/commit with read-only source, meaningful tests and preserved reports; resolve introduced P0/P1 issues and re-review substantive corrections.
5. Integrated verification: entire Bun suite, cloud migration/runtime/API/security tests, both static checks, standalone CLI build/package verification, cloud build and no commercial dependencies/auth-flow source changes. Record skips and untested live authorization/deployment truthfully.
6. Preserve reports, destroy only this team's completed workers after source durability checks, record inventory and commit completed work.

## Acceptance focus

Invalid/replayed/wrong-browser OAuth; repeated and concurrent identity registration; disabled users; expiration/revocation; session forgery; organization ID spoofing; changed roles/membership revocation; tenant/user-bound cursors and dedupe; atomic batch rollback and dependency failures; no secrets in DB diagnostics/output; public metrics cannot be reached while authorized local diagnostics still work.
