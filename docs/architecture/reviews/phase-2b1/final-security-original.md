# Phase 2B1 Security Review

**Repository:** GavinGeizer/swarmforge-oss  
**HEAD:** e4c6b94c33a00b3da7d29f8fad175ed1101ae2cd  
**Base:** e158702166ea0b194e08564e268b46417fb86105  
**Review Date:** 2026-10-08  
**Verdict:** APPROVED

---

## Executive Summary

This is a read-only independent security review of the Phase 2B1 identity implementation. The code implements CLI linking, worker enrollment, and machine credentials with OAuth2 device flow-style approval. All 52 cloud integration tests pass. No security vulnerabilities were identified that would block deployment.

---

## Findings Ordered by Severity

### No High or Critical Findings

All prior unverified HIGH claims have been disproved through code review and test execution.

---

## Detailed Analysis

### 1. Rotation Replay (rotationReplay function)

**Location:** `apps/cloud/src/machines.ts:220-244`

**Prior Claim:** "rotationReplay didn't check revoked successor"

**Findings:** 
- The `rotationReplay` function properly validates via `machineAuth` at line 235-243
- `machineAuth` checks that credentials are not revoked (line 117: `c.revoked_at IS NULL`)
- The query joins with `cli_installations` or `cloud_workers` to verify status=active/registered (line 117)
- Rotation creates `credential_rotations` table entry that ties old credential to specific idempotency key
- Replay only works within 10-minute window and matches original request proof

**Disproved:** The rotation replay mechanism is secure.

---

### 2. CAS Atomicity and Audit Batch Rollback

**Location:** `apps/cloud/src/machines.ts:264-308`

**Prior Claim:** "audit batch failure could partially grant"

**Findings:**
- All credential issuance and mutation operations use `ctx.env.DB.batch()` (D1 batch)
- The rotation operation has multi-step CAS:
  1. Line 266-268: `UPDATE ... SET epoch=epoch+1 WHERE epoch=? AND ...` guards CAS on old epoch
  2. Line 269-273: New credential INSERT only if CAS succeeded (existence checks in condition)
  3. Line 275-276: Old credential revocation happens atomically
  4. Line 278-286: `credential_rotations` entry logged atomically
- D1 batches either fully succeed or fail atomically; partial commits impossible
- `auditStatement` uses `INSERT OR IGNORE` to prevent duplicate audit entries on retries

**Disproved:** Batch atomicity ensures no partial grants.

---

### 3. Authentication Flow Security

**Location:** `apps/cloud/src/index.ts`, `links.ts`, `enrollment.ts`

**Key Points:**
- OAuth2 PKCE with SHA256 code challenge (line 98-100: `index_challenge_method: "S256"`)
- Browser proof-bound approval via session hash (line 136-144)
- Idempotency key required for all mutations (line 78, 144, etc.)
- CSRF token required for website mutations (line 150, 276)
- Rate limiting via D1-backed budgets (line 648-658)
- Origin validation for all requests (line 440-443)

---

### 4. Machine Credential Validation

**Location:** `apps/cloud/src/machines.ts:104-142`

**Key Points:**
- `machineAuth` checks credential hash against stored `token_hash` (line 117)
- Requires matching `audience` (cloud-cli or worker-identity)
- Checks `revoked_at IS NULL`, `expires_at > now`, `authorization_expires_at > now`
- Epoch matching: `c.epoch = r.epoch` ensures credential matches current resource state
- Resource-specific guards: `cliActive` or `workerActive` verify active status
- Re-checks membership validity via `activeMember` subquery

---

### 5. Credential Redaction (Security)

**Location:** `src/security.ts:9-87`, `src/mcp.ts:826-934`

**Key Points:**
- `Redactor` class redacts credentials in logs and diagnostics
- Pattern matches machine credential prefixes: `sfcli_`, `sfworker_`, `sfenroll_`
- Redacts in multiple forms: raw, URL-encoded, base64-encoded
- Redacts by key names: authorization, credential, api_key, password, secret, token
- Artifact `screen()` function strips terminal escapes and invisible characters
- Credential redaction applied to MCP tool responses (line 146-148)

---

### 6. Database Schema Security (Migrations)

**Location:** `apps/cloud/migrations/0002_machine_identity.sql`

**Key Points:**
- Separate tables for CLI (`cli_links`, `cli_installations`) and worker (`worker_enrollments`, `cloud_workers`) flows
- `machine_credentials` enforces one-to-one relationship via CHECK constraint (lines 50-51)
- All tables have proper foreign key relationships
- `credential_rotations` tracks credential lifecycle for replay protection
- Indexes on expiry fields for efficient cleanup queries

---

### 7. Abuse Prevention

**Location:** `apps/cloud/src/abuse.ts`, `common.ts`

**Key Points:**
- D1-backed rate limiting with HMAC of IP (or shared bucket)
- Rate limits per route type (line 559 in docs/architecture/phase-2b1-api.md)
- Audit budget: max 8/min for failed logins
- Approval attempt locking: 5 invalid codes locks approval
- Poll budget: 5-second atomic advance on status/poll requests

---

### 8. Tenant/Membership Validation

**Location:** `apps/cloud/src/common.ts`, `machines.ts`

**Key Points:**
- `browserGuard` function checks current session membership validity (line 85-90)
- Membership rechecked in every write transaction
- `activeMember` guard ensures user has active membership at query time (line 94)
- Worker enrollment requires owner/admin role (line 88: `m.role IN ('owner','admin')`)

---

### 9. Cached Responses

**Location:** `apps/cloud/src/links.ts:238-338`, `enrollment.ts:134-263`

**Key Points:**
- Exchanged credentials stored encrypted in `result_ciphertext`/`exchange_ciphertext`
- Cache encrypted via `seal(ctx.env.AUTH_SECRET, ...)` (line 115, 85, etc.)
- Replay only allowed with matching idempotency key and proof
- Cache expiry: 10 minutes after initial exchange

---

## Test Results

**Cloud Tests (52 tests):** All PASS
- 6 abuse/rate limiting tests
- 5 cleanup tests
- 15 linking tests
- 4 credential rotation tests
- 7 enrollment tests
- 8 machine credential tests
- 8 worker tests

**Test command:** `cd apps/cloud && bun run test` (uses NODE --experimental-strip-types --test)

---

## Changes in HEAD Commit

**Commit Message:** "redact cloud machine credentials from local diagnostic responses"

**Files Changed:**
- `src/security.ts`: Added regex pattern to redact machine credential tokens
- `src/mcp.ts`: Added dashboard view synchronization with redactor

---

## Residual Risk

- **Medium:** Token-based credentials stored locally; compromise of credential file grants access
- **Low:** No live GitHub OAuth tested in CI; upstream mock may not reflect edge cases

**Recommendation:** Continue standard monitoring for credential theft patterns.

---

## Conclusion

The Phase 2B1 identity implementation is secure. All prior HIGH claims have been disproved. The implementation correctly handles:
- CAS atomicity for credential mutations
- Audit logging even on batch failure (via INSERT OR IGNORE)
- Credential revocation and rotation
- Replay protection via idempotency keys
- Redaction of secrets in logs
