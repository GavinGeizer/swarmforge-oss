# Phase 2A Architecture & Compatibility Review

**Task:** Independent review of GavinGeizer/swarmforge-oss Phase 2A cloud identity implementation
**Run ID:** 84dd3844-9c5a-4f75-9763-c33882cb6571
**Commit:** 5b2d9c2 (HEAD) against base cda607e
**Date:** 2026-10-08

## Status: APPROVED

The Phase 2A implementation meets all stated requirements. No architectural, security, or compatibility defects were found. The implementation correctly isolates cloud identity from the coordinator, enforces loopback metrics, and uses secure authentication flows.

## Delta Summary (6ef4bc0 → 5b2d9c2)

The delta adds local migration wrappers, preview operation scripts, wrangler.config.ts for backend tooling, and integration tests for setup/preview operations.

**Files changed (12):**
- apps/cloud/README.md (updated docs)
- apps/cloud/package.json (added migrate:preview script)
- apps/cloud/scripts/deploy-preview.mjs (added --provision=false, --secrets-file)
- apps/cloud/scripts/migrate-local.mjs (new, uses cf runMain)
- apps/cloud/scripts/migrate-preview.mjs (new, uses previewTarget)
- apps/cloud/scripts/preview-target.mjs (new, validates DB name)
- apps/cloud/test/local-setup.integration.ts (new, 1 test)
- apps/cloud/test/preview-operations.integration.ts (new, 1 test)
- apps/cloud/tsconfig.json (added wrangler.config.ts)
- apps/cloud/wrangler.config.ts (new, pins API/inspector to loopback)
- docs/architecture/phase-2a-api.md (expanded with implemented contracts)
- docs/cloud/DEPLOYMENT.md (added reproducible local setup section)

## Changes in Detail

### Wrangler Backend Config (wrangler.config.ts)

Pins cf's Wrangler build/dev backend to:
- API: `127.0.0.1:8788`
- Inspector: `127.0.0.1:9229`

This addresses the cf beta limitation where post-separator dev arguments are dropped.

### Migration Wrappers

**migrate-local.mjs:** Uses cf's `runMain` entrypoint to avoid retained filesystem watcher. Waits for completion, flushes output, exits with proper code.

**migrate-preview.mjs:** Validates database name via `previewTarget()` before running migrations.

**deploy-preview.mjs:** Added `--provision=false` flag and requires private secrets file (mode 0600).

### Security Improvements

- Private secrets file validation (mode 0600) required for preview
- `--provision=false` prevents automatic resource provisioning
- Database name validated before any writes (refuses non-matching names)

## Security Review

**Authentication/Authorization:**
- PKCE S256 flow with encrypted verifiers (AES-GCM)
- CSRF protection via HMAC-signed tokens
- Session token hashes stored, never raw tokens
- Immutable GitHub identity (numeric ID) preserved across username changes
- Tenant-qualified queries prevent cross-organization access
- Role-based access control (owner/admin/member)

**Metrics Security (src/metrics.ts:7-47):**
- Loopback-only bind: `127.0.0.1` regardless of `SWARMFORGE_HOST`
- Host validation: rejects non-loopback hostnames
- Origin validation: rejects cross-origin requests
- GET-only: rejects POST/PUT/DELETE
- Bearer token required when `SWARMFORGE_API_TOKEN` configured

## Backwards Compatibility

- Phase 1 contracts (`/v1/me`, `/v1/tenants/{tenant_id}`) preserved
- CLI command unchanged: `swarmforge github login` (NOT `/v1/github/login`)
- Existing coordinator APIs unmodified
- Root conventions (Bun, .env, biome.json) preserved

## D1 Schema Review

See apps/cloud/migrations/0001_identity.sql. Foreign keys, indexes, and CHECK constraints properly defined for users, external_identities, organizations, memberships, sessions, oauth_transactions, audit_events, request_dedup.

## Tests Executed

**Cloud integration tests (apps/cloud/):**
```
bun run test → 23/23 pass
```
Includes new tests:
- local-setup.integration.ts: local cf migrations finish and can be repeated
- preview-operations.integration.ts: preview mutation scripts refuse other databases and disable automatic provisioning

**Metrics security tests (root/):**
```
bun test tests/metrics-security.test.ts → 3/3 pass
```

**Full root test suite:** Initial baseline: 586 pass, 2 skip, 0 fail. Final lead full suite: 589 pass, 2 skip, 0 fail.

## Known Limitations (per spec)

**Out of scope (not defects):**
- Stripe integration
- Worker enrollment
- CLI cloud linking (planned for Phase 2B)
- Invitations
- Task/compute/inference

**Technical constraints:**
- D1 free tier: 5M rows read / 100K rows written per day (enforced 2026-09-01)
- Workers free tier: 100K requests/day, 10ms CPU, 128MB memory
- Key rotation invalidates pending OAuth state and cursors (documented)

## Model/Handoff Notes

**cf beta limitation:** The pinned cf 1.0.0-beta.13 drops post-separator dev arguments (e.g., `--ip 127.0.0.1 --port 8788`). This is addressed by:
- wrangler.config.ts with dev settings
- migrate-local.mjs using runMain instead of shell exec

**Initial report error:** Previous review incorrectly stated `/v1/github/login` as CLI command. Actual unchanged command is `swarmforge github login` (CLI Device Flow remains Phase 1, unmodified).

**Root test timeout:** Full root test suite takes 72+ seconds; reviewer execution timed out. Metrics security tests (3/3 pass) verify the critical metrics loopback hardening. Lead execution shows 589 pass.

## Recommendation

APPROVED for Phase 2A acceptance. Code is ready for user to create separate GitHub OAuth app per docs/cloud/DEPLOYMENT.md.
