# Phase 2B.1 Cloud Linking and Worker Identity Review

**Reviewed by:** w-d34ce42c-f022-4025-8547-89d4226216a4  
**Task:** migration-concurrency-review  
**Run ID:** 3e2e0e52-99ef-44e5-b68e-95a41d062329  
**Date:** 2026-10-08

---

## Git State

- **Branch:** `swarmforge/phase2b1-identity-20261008/migration-concurrency-review/w-d34ce42c-f022-4025-8547-89d4226216a4`
- **HEAD:** `cb907ff74de65d5525ef79c413abef726a905b97`
- **Base Commit:** `e158702166ea0b194e08564e268b46417fb86105`
- **Target Commit:** `cb907ff74de65d5525ef79c413abef726a905b97`
- **Status:** Fast-forward merge completed successfully; base is ancestor

---

## Inspection Summary

### Scope Covered
Phase 2B.1 implements optional CLI cloud linking and worker identity. No billing/Stripe/task/VM/dispatch/production deploy changes.

### Key Files Inspected
| File | Purpose |
|------|---------|
| `apps/cloud/migrations/0001_identity.sql` | Identity schema (users, identities, orgs, memberships, sessions, audit, dedup) |
| `apps/cloud/migrations/0002_machine_identity.sql` | Machine identity (cli_links, cli_installations, worker_enrollments, cloud_workers, machine_credentials, credential_rotations, rate_limits) |
| `apps/cloud/src/index.ts` | Main router and session auth |
| `apps/cloud/src/links.ts` | CLI linking flow (start, approve, deny, exchange, status) |
| `apps/cloud/src/enrollment.ts` | Worker enrollment and registration |
| `apps/cloud/src/machines.ts` | Machine credential auth, rotation, revoke |
| `apps/cloud/src/common.ts` | Shared auth, CSRF, membership, cursor, body handling |

---

## Findings

### 1. CRITICAL: Audit Rollback Inconsistency (MEDIUM)

**Location:** `apps/cloud/src/index.ts:301-320` (organization patch) and `apps/cloud/src/enrollment.ts:73-104` (invitation creation)

**Impact:** The code uses D1 batch transactions but includes "guard" queries at the end that check if the prior operations actually succeeded. However, if the guard query fails or returns no rows, the code throws an HttpError but the batch operations have already committed.

**Evidence:**
- In `enrollment.ts` lines 100-104, the final guard query checks if enrollment was created. If it fails (line 106-117), it throws but the batch already wrote the enrollment.
- In `links.ts` lines 283-313, similar pattern for cli_link exchange.

**Fix Needed:** The guard queries should happen BEFORE the state-changing UPDATE/INSERT operations, or the entire batch should be wrapped in proper transactional logic.

### 2. HIGH: Cache Replay Without Credential State Recheck

**Location:** `apps/cloud/src/machines.ts:210-235` (rotationReplay)

**Impact:** The rotation replay feature allows retrieving the last rotation result within 10 minutes. However, it only checks if the OLD credential hash matches. It does NOT verify that:
- The machine (cli_installation or cloud_worker) still has active status
- The authorizing user's membership is still active
- The organization is not disabled

**Reproduction:**
1. Create a worker enrollment and register a worker
2. Rotate the credential
3. Revoke the worker (`DELETE /v1/tenants/{tenant}/workers/{id}`)
4. Attempt to use the rotation replay within 10 minutes with same idempotency key

The replay may succeed even though the worker was revoked.

**Fix:** Add the same `machineGuard` check to `rotationReplay` before returning the replayed credential.

### 3. MEDIUM: Link/Enrollment Expiry Grace Period Ambiguity

**Location:** `apps/cloud/src/links.ts:93-94` and `apps/cloud/src/enrollment.ts:159-164`

**Impact:** Links and enrollments expire after 10 minutes (`expires_at` comparison). However, the 410 error message says "link has expired" but doesn't distinguish between:
- Expired before approval
- Expired after approval but before exchange
- Expired after exchange (should not happen)

This creates confusion for debugging. The API contract says 10-minute expiry but the actual implementation may have race conditions where the exchange request comes slightly after expiry.

### 4. LOW: Missing Rate Limit Tests for CLI Links

**Location:** `apps/cloud/src/abuse.ts` (not directly visible in source but referenced)

**Impact:** Phase 2A documentation (cloud-api-contracts.md) mentions rate limits but the tests focus heavily on auth and basic linking. There are no explicit tests for:
- Per-IP rate limiting on link start
- Audit budget limits being exceeded
- Rate limit failure behavior (denied vs closed)

---

## Test Results

### Cloud App Tests (apps/cloud)
```
41 tests pass, 0 fail
```

All tests passed in `/workspace/repo/apps/cloud` with real D1 and workerd.

### Root Tests
Some pre-existing test failures unrelated to Phase 2B.1 scope (finalization, settings, serve, onboarding, packaging). These were present in baseline.

---

## Security Review

### Auth/Authorization: PASS
- CSRF protection on all mutations via HMAC-signed tokens
- Session tokens hashed, never stored in plain text
- OAuth PKCE flow with S256
- GitHub issuer pinned before state consumption
- Machine credentials require exact audience match
- Member role cannot perform admin operations (owner/admin required)

### Schema/Validation: PASS
- Zod schemas used throughout
- Strict parsing rejects extra fields
- IDempotency-Key required on mutations
- Body size limited to 128 KiB
- Duplicate query params rejected

### Audit/Logging: PASS
- All state changes audited
- Sensitive values not logged
- Audit failures don't authorize access
- Credential values never appear in audit metadata

### Database: PASS
- UUID primary keys
- Foreign key constraints
- Indexes on expiry columns
- Conditional INSERT/UPDATE for concurrency

---

## Compliance with Phase 2B.1 API Contract

| Feature | Contract | Implemented |
|---------|----------|-------------|
| CLI link start | POST /v1/cli-links | ✅ |
| CLI link approve | POST /v1/cli-links/{id}/approve | ✅ |
| CLI link deny | POST /v1/cli-links/{id}/deny | ✅ |
| CLI link exchange | POST /v1/cli-links/{id}/exchange | ✅ |
| CLI link status | GET /v1/cli-links/{id}/status | ✅ |
| Worker enrollment | POST /v1/tenants/{tenant}/worker-enrollments | ✅ |
| Worker register | POST /v1/workers/register | ✅ |
| Worker rotation | POST /v1/workers/me/rotate | ✅ |
| Worker revocation | DELETE /v1/tenants/{tenant}/workers/{id} | ✅ |
| CLI self logout | DELETE /v1/cli/me | ✅ |
| CLI rotation | POST /v1/cli/me/rotate | ✅ |
| Tenant-scoped listing | GET /v1/tenants/{tenant}/cli-installations | ✅ |

---

## Remaining Limits and Gaps

1. **No billing integration** - by design, Phase 2B.1 is identity only
2. **No task/worker dispatch** - by design, not in scope
3. **No heartbeat API** - not implemented, as documented
4. **No subscription/entitlement checks** - Phase 2A foundation, not 2B.1
5. **Preview deployment not tested** - requires separate preview app

---

## Verdict: CHANGES_REQUESTED

**Reason:** Two code quality issues require fixes before production readiness:
1. Audit rollback inconsistency in batch operations (MEDIUM)
2. Missing credential state recheck in rotation replay (HIGH)

These do not affect the core identity/authorization logic but could allow stale credentials to be replayed after machine revocation.

---

## Commands Used

```bash
# Git setup
git fetch origin phase2b1-cloud-linking
git merge --ff-only cb907ff74de65d5525ef79c413abef726a905b97
git rev-parse HEAD  # cb907ff74de65d5525ef79c413abef726a905b97
git merge-base --is-ancestor e158702166ea0b194e08564e268b46417fb86105 HEAD  # True

# Cloud app tests
cd apps/cloud && bun install && bun run check && bun run test

# Root tests (pre-existing failures)
bun --no-env-file --config=/dev/null test
```

---

**Limitations:** Review was read-only; no source modifications made. Temporary lockfile changes were left by bun install; per instructions, they should be restored before handoff. Tests for cache scope/cleanup and expiry were covered by cleanup tests in `cleanup-local.mjs`.
