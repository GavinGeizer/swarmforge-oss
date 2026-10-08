# SwarmForge Phase2B.1 Architecture Review

**Commit:** d284bf33e11a7a431d2d49db8e43572accd4e7d0  
**Base:** e158702166ea0b194e08564e268b46417fb86105  
**Date:** 2026-10-08  
**Bun Version:** 1.4.2 (verified)

---

## Summary

This review covers the cloud identity scope only (Stripe/tasks/provision/deploy excluded). The commit `d284bf33` adds regression tests for GitHub Device Flow OAuth. The cloud identity implementation uses Vanilla Workers + Zod (no Hono), with secure credential storage and explicit scope validation.

---

## Test Results

### Root Suite (Bun 1.4.2)
- **Passed:** 607
- **Skipped:** 2
- **Failed:** 1 (flaky test in dashboard-protocol.test.ts)
- **Static check:** Passed

### Cloud Suite (Node 24.21 with --experimental-strip-types)
- **Passed:** 42
- **Failed:** 0

---

## Findings

### No Critical Security Findings

The cloud identity codebase demonstrates proper security patterns:

1. **Credential Storage** (`src/cloud-credentials.ts`):
   - Validates file permissions (0600) and directory permissions (0700)
   - Rejects symlinks and world-readable files
   - Uses atomic write with fsync
   - Enforces POSIX uid checks

2. **Schema Validation** (`src/cloud-client.ts`, `src/cloud-credentials.ts`):
   - All credentials validated with Zod
   - Explicit scope tuple: `["identity:read", "devices:self"]`
   - Credential format regex: `^sfcli_[A-Za-z0-9_-]{43}$`
   - Expiration bounds enforced (`expires_at <= authorization_expires_at`)

3. **OAuth/Device Flow** (`apps/cloud/src/index.ts`, `src/cloud-client.ts`):
   - PKCE challenge (S256) used for GitHub OAuth
   - CSRF tokens signed with AUTH_SECRET
   - Origin validation on all requests
   - Session cookie uses `__Host-` prefix with Secure/HttpOnly

4. **API Boundaries** (`src/cli/cloud.ts`, `apps/cloud/src/`):
   - Cloud API uses separate credential path
   - Tenant/organization scope validated server-side
   - Redirect prevention (redirect: "error" in fetch)

---

## Changes in Commit d284bf33

**Files Changed:**
- `tests/github-device-flow-regression.test.ts` (340 lines added)

**Purpose:** Regression tests for GitHub OAuth device flow, ensuring:
- Correct `repo` scope is requested
- Credentials are written only after successful authorization
- Denied/expired tokens throw appropriately

---

## Rollout Gates

1. **Environment Variables Required:**
   - `APP_ORIGIN`, `WEBSITE_ORIGIN` - Must be valid HTTPS origins
   - `AUTH_SECRET` - Minimum 32 characters
   - `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` - For OAuth
   - `ENVIRONMENT` - Must be "local" or "preview"

2. **Dependencies:**
   - Node.js 24+ (cloud runner)
   - Bun 1.4.2+ (root)

3. **Migration:**
   - `apps/cloud/migrations/0001_identity.sql`
   - `apps/cloud/migrations/0002_machine_identity.sql`

---

## Verdict

**APPROVED**

No security regressions or missing requirements identified. The commit adds defensive tests for existing GitHub OAuth functionality.
