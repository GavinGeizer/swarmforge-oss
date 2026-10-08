# Worker Identity Review Report

**Run ID:** 5d2f0bf0-c03f-48a4-b7e8-6ada76b5247e  
**Worker ID:** w-8926825e-eec9-4bbb-9721-014c20fda6bb  
**Task ID:** worker-identity-review  
**Date:** 2026-10-08

---

## Git State Verification

- **Base commit (e158702166ea0b194e08564e268b46417fb86105):** Verified as ancestor of HEAD
- **Target commit (cb907ff74de65d5525ef79c413abef726a905b97):** Verified as HEAD
- **Branch:** swarmforge/phase2b1-identity-20261008/worker-identity-review/w-8926825e-eec9-4bbb-9721-014c20fda6bb

---

## Files Inspected

| File | Description |
|------|-------------|
| `docs/architecture/phase-2b1-api.md` | Phase 2B.1 identity API contracts |
| `docs/architecture/identity-and-trust.md` | Identity and trust boundaries |
| `docs/architecture/entitlements.md` | Capability entitlements |
| `apps/cloud/src/enrollment.ts` | Worker enrollment routes (392 lines) |
| `apps/cloud/src/machines.ts` | Machine credential auth (444 lines) |
| `apps/cloud/src/schemas.ts` | Zod schema definitions |
| `apps/cloud/test/enrollment.integration.ts` | Enrollment tests (254 lines) |
| `apps/cloud/test/pairing-hostile.integration.ts` | Pairing security tests (201 lines) |

---

## Test Results

**Command:** `node --experimental-strip-types --test test/enrollment.integration.ts test/pairing-hostile.integration.ts`  
**Result:** 9 tests passed, 0 failed, 0 skipped

### Enrollment Tests
1. ✅ Single-use worker enrollment and encrypted retry
2. ✅ Cross-tenant enrollment/revocation, loss of owner authority, expired invitations
3. ✅ Worker rotation invalidates old epoch; suspended tenant/disabled authorizer/expired credentials denied
4. ✅ Audit/database failures cannot partly enroll/consume/authorize

### Pairing-Hostile Tests
5. ✅ Simultaneous account approvals cannot cross-bind
6. ✅ Approval code lock, idempotency conflict, unapproved scopes, cross-proof replay
7. ✅ Rotation retry is proof/idempotency/audience bound
8. ✅ Multiple memberships require fresh browser authority
9. ✅ Approval page safely redirects through browser login, rejects open redirects

---

## Security Findings

### ✅ PASSING: Worker Enrollment Security
- **Location:** `apps/cloud/src/enrollment.ts:134-263`
- **Finding:** Registration properly checks owner/admin membership and session validity via `authority` SQL subquery (lines 198-199)
- **Impact:** Prevents impersonation; worker credentials bound to active, authorized enroller

### ✅ PASSING: Idempotency and Replay Protection
- **Location:** `apps/cloud/src/enrollment.ts:166-174`
- **Finding:** Consume check enforces exact `exchange_key` + `exchange_fingerprint` match after first registration
- **Impact:** Prevents credential replay with mismatched context

### ✅ PASSING: Credential Epoch/Rotation
- **Location:** `apps/cloud/src/machines.ts:236-299`
- **Finding:** Rotation CAS (`UPDATE ... SET epoch=epoch+1 WHERE epoch=?`) ensures only current epoch can rotate
- **Impact:** Stale tokens cannot rotate; 10-minute retry window for lost response

### ✅ PASSING: Authority Guards
- **Location:** `apps/cloud/src/machines.ts:85-102`
- **Finding:** `browserGuard` enforces active membership + owner/admin role for enrollment approval
- **Impact:** Prevents member-only users from creating worker enrollments

### ✅ PASSING: No Implicit Dispatch Authority
- **Location:** `apps/cloud/src/enrollment.ts` & `apps/cloud/src/machines.ts`
- **Finding:** Worker scopes limited to `["worker:identity","worker:rotate"]` (no heartbeat/dispatch)
- **Impact:** Workers cannot claim eligibility for compute/execution without additional capabilities

### ✅ PASSING: Audit Trail Integrity
- **Location:** `apps/cloud/src/enrollment.ts:92-100`
- **Finding:** Enrollment creation/revocation logged to audit_events via batch
- **Impact:** Complete audit trail for all identity mutations

---

## Pre-existing Issues (Not Introduced in This PR)

### ⚠️ LOW: Code Formatting
- **Location:** `apps/cloud/test/abuse.integration.ts:90-94`
- **Finding:** Biome check fails on formatting in pre-existing test file
- **Status:** Not related to identity/cloud linking scope

---

## Summary

**Verdict:** APPROVED

### Key Security Properties Verified
1. **No Impersonation:** Worker enrollment requires active owner/admin session membership
2. **Idempotency:** Exact proof/key/fingerprint match enforced for registration/retry
3. **Credential Rotation:** Epoch-based CAS prevents stale token use
4. **Scope Isolation:** Worker credentials cannot access CLI/website/session APIs
5. **No Dispatch Authority:** Identity only; no heartbeat/dispatch scopes
6. **Audit:** All mutations logged to audit_events

### Limitations
- Tests require Miniflare runtime; local setup scripts (`prepare-local.mjs`, `migrate-local.mjs`) must be run
- `bun run check` fails due to pre-existing formatting issue in `test/abuse.integration.ts`
- Lockfile version incompatibility resolved by regenerating `bun.lock`

---

**End of Report**
