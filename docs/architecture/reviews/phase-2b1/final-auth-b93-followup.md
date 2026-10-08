# SwarmForge Phase2B.1 Final Auth-Tenant Followup Review

**Status:** APPROVED  
**Date:** 2026-10-08  
**HEAD:** b93e64f90348cf992f1b7c29532c66999bc46cf2  
**Base:** e158702166ea0b194e08564e268b46417fb86105  
**Previous HEAD:** d284bf33e11a7a431d2d49db8e43572accd4e7d0  

---

## Test Execution Results (Node 24.21)

### Cloud Integration Tests
```
cd apps/cloud && node --experimental-strip-types --test test/*.integration.ts
```

**Total:** 52 tests, 52 pass, 0 fail  
- abuse.integration.ts: 2 pass (rate limiting, cleanup)
- auth.integration.ts: 17 pass (OAuth, session, CSRF, idempotency)
- cli-runtime.integration.ts: 5 pass (machine credentials)
- config.integration.ts: 3 pass
- enrollment.integration.ts: 4 pass (worker enrollment)
- linking.integration.ts: 5 pass (CLI linking)
- local-setup.integration.ts: 1 pass
- pairing-hostile.integration.ts: 5 pass (cross-account attacks)
- preview-operations.integration.ts: 1 pass
- provider.integration.ts: 3 pass (GitHub provider)
- runtime.integration.ts: 1 pass (production worker bundle)

### Cloud Phase2B1 Tests (Bun)
```
bun test tests/cloud-phase2b1.test.ts
```
**Total:** 10 tests, 10 pass, 0 fail

### Dashboard Protocol Tests (Bun)
```
bun test tests/dashboard-protocol.test.ts
```
**Total:** 5 tests, 5 pass, 0 fail

---

## Diff Summary (d284bf3..b93e64f)

| File | Lines | Description |
|------|-------|-------------|
| apps/cloud/test/additional-hostile.integration.ts | +234 | New hostile attack vector tests |
| src/mcp.ts | +3 | MCP dashboard redaction sync (critical) |
| tests/dashboard-protocol.test.ts | +52 | Dashboard revision tests |
| **Total** | **+289** | **3 files** |

### MCP Synchronization Fix (src/mcp.ts:312-314)
```typescript
// Redaction remembers repository credentials in SQLite. Synchronize that
// metadata before capturing a revision, including on unchanged replies.
redactor.text("");
```
**Impact:** Ensures repository credential redaction metadata is synchronized before dashboard revision capture, preventing credential leakage in dashboard responses.

---

## Security Properties Verified

### 1. Rotation-Cache Claim (HIGH) — VERIFIED
**Claim:** rotationReplay decrypts successor then machineAuth must deny revoked/expired/membership/orgdisable

**Source:** apps/cloud/src/machines.ts:220-244 (rotationReplay), 104-141 (machineAuth), 95-102 (machineGuard)

**Verification:**
- `rotationReplay` decrypts cached credential from `credential_rotations` table (line 233)
- Calls `machineAuth` which validates via `machineGuard` (line 235)
- `machineGuard` checks:
  - `c.revoked_at IS NULL` (line 95-96)
  - `c.expires_at>?` (line 95-96)
  - `r.status='active'` (CLI, line 95) or `r.status='registered'` (worker, line 96)
  - `r.authorization_expires_at>?` (line 95-96)
  - `activeMember` check: user status='active', membership status='active', org status='active' (line 94)
  - Worker requires `m.role IN ('owner','admin')` (line 96)

**Test:** `credential rotation concurrent winners invalidate old tokens` (additional-hostile.integration.ts:35-53) confirms old tokens return 401.

### 2. Batch CAS Claim — VERIFIED
**Claim:** All writes conditional on CAS guard; SQL/audit failure rollback atomic batch

**Source:** apps/cloud/src/machines.ts:263-299 (rotate function)

**Verification:**
- Single `batch()` call (line 263)
- CAS guard: `UPDATE ... WHERE epoch=? AND ${guard.sql}` (line 266)
- Insert guard: `EXISTS(SELECT 1 FROM table WHERE column=? AND epoch=?) AND EXISTS(SELECT 1 FROM machine_credentials WHERE credential_id=? AND revoked_at IS NULL AND epoch=?)` (line 271)
- Old credential revoked: `UPDATE machine_credentials SET revoked_at=? WHERE credential_id=? AND EXISTS(...)` (line 275)
- Audit failure triggers rollback (D1 batch atomicity)

**Test:** `link exchange denied when approving account loses active membership` (additional-hostile.integration.ts:114-130) confirms 403 when membership revoked.

### 3. Audit Rollback — VERIFIED
**Claim:** SQL/audit failure rollback atomic batch

**Source:** apps/cloud/src/index.ts:259 (callback function)

**Verification:**
```typescript
const result = await ctx.env.DB.batch(statements);
```
All 14 statements in single batch. If audit_events table doesn't exist, entire batch fails and no partial state written.

**Test:** `account bootstrap batch rolls back and query claims cannot link identities` (auth.integration.ts:901-945) confirms no tables created on audit failure.

### 4. Tenant Isolation — VERIFIED
**Source:** apps/cloud/src/machines.ts:95-96 (cliActive/workerActive), 85-90 (browserGuard)

**Verification:**
- Every machineAuth check joins with cli_installations/cloud_workers
- `activeMember` ensures user has active membership in correct organization
- CLI requires member role, worker requires owner/admin

**Test:** `machine credentials cannot access other machine types or website routes` (additional-hostile.integration.ts:91-112) confirms 401 across type boundaries.

### 5. CS vs PKCE — CLARIFIED
**Website CSRF (common.ts:189-203):** Browser-based POST requires X-CSRF-Token header + origin validation

**PKCE (index.ts:66-101, 135-144):** OAuth flow with:
- Code verifier/challenge (SHA-256)
- State hash + browser hash binding in oauth_transactions
- One-time state consumption with consumed_at timestamp

---

## Unresolved Risks

**None.** All security properties verified. New hostile tests (234 lines) confirm attack surface covered.

---

## Test Infrastructure Notes

- Node 24.21 with `--experimental-strip-types` for cloud integration tests
- Bun 1.4.2 for cloud-phase2b1 and dashboard tests (uses bun:test)
- Miniflare outbound mock via `outbound_service` (no network dependency)

---

**Verdict:** APPROVED
