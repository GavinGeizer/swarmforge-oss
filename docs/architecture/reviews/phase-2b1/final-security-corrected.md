# Phase 2B1 Security Review (Corrected)

**Repository:** GavinGeizer/swarmforge-oss  
**HEAD:** e4c6b94c33a00b3da7d29f8fad175ed1101ae2cd  
**CI-only delta:** 27846bc225abb93ced54bddf1e63d895a233a129  
**Base:** e158702166ea0b194e08564e268b46417fb86105  
**Review Date:** 2026-10-08  
**Verdict:** APPROVED (with caveats)

---

## Executive Summary

Read-only security review of Phase 2B1 identity implementation. All 52 cloud integration tests pass. Prior HIGH claims (rotationReplay not checking revoked successor, audit batch partial grant) disproved via code review and tests. CI-only commit 27846bc adds root CLI install before cloud package.

**Caveats:** Edge CPU limits, D1 quota throttling, and live preview mutation scripts are untested; no blanket "secure deployment" claim without infrastructure monitoring.

---

## Actual Test Results

```
ℹ tests 52
ℹ pass 52
ℹ fail 0
ℹ duration_ms 60923.696994
```

**Named tests from actual output:**
- `public starts/polls and failure audit writes are bounded` (abuse.integration.ts)
- `credential rotation concurrent winners invalidate old tokens` (cli-runtime.integration.ts)
- `enrollment exact replay returns cached credential while changed body returns conflict` (enrollment.integration.ts)
- `machine credentials cannot access other machine types or website routes` (machine-helpers.ts)
- `link exchange denied when approving account loses active membership` (linking.integration.ts)
- `rotation retry is proof/idempotency/audience bound and cannot resurrect revoked credentials` (pairing-hostile.integration.ts)

---

## Findings (Ordered by Severity)

### 1. Rotation Replay Checks Revoked Successor (Disproved Claim)

**Location:** `apps/cloud/src/machines.ts:220-244`

**Original claim:** "rotationReplay didn't check revoked successor"

**Correction:** `rotationReplay` properly validates via `machineAuth` at line 235-243. The `machineAuth` function (line 117) checks:
- `c.revoked_at IS NULL` - verifies credential not revoked
- `r.status='active'` or `r.status='registered'` - verifies resource active status
- `c.epoch=r.epoch` - epoch matches current resource state

**Test:** `rotation retry is proof/idempotency/audience bound and cannot resurrect revoked credentials`

---

### 2. Audit Batch Atomicity (Disproved Claim)

**Location:** `apps/cloud/src/machines.ts:264-308`, `common.ts`

**Original claim:** "audit batch failure could partially grant"

**Correction:** D1 batches (`ctx.env.DB.batch()`) are atomic - either all statements succeed or none. The rotation uses multi-step CAS:
1. Line 266-268: `UPDATE ... SET epoch=epoch+1 WHERE epoch=?` guards CAS on old epoch
2. Line 269-273: Credential INSERT only if CAS succeeded (existence checks in condition)
3. Line 275-276: Old credential revocation
4. Line 278-286: `credential_rotations` entry logged

**Critical correction:** `INSERT OR IGNORE` does NOT help through failed batch/outage. When the entire batch rolls back, both the mutation AND audit event are lost together.

**Test:** `credential rotation concurrent winners invalidate old tokens`

---

### 3. Credential Redaction (Corrected Understanding)

**Location:** `src/security.ts:19-60`

**Correction:** Two distinct redaction mechanisms:
- Lines 19-31: For KNOWN loaded secrets, redactors generate variants (raw, URL-encoded, base64) from `this.secrets()` (loaded credentials, API tokens)
- Line 58: NEW generic regex `/(?:sfcli_|sfworker_|sfenroll_)[A-Za-z0-9_-]{43}/g` redacts RAW unknown machine tokens in diagnostics, even if coordinator never loaded that credential

The regex does NOT do arbitrary token detection; it only matches known machine token prefixes.

---

### 4. OAuth Code Challenge (Spelling Correction)

**Location:** `apps/cloud/src/index.ts:98-100`

**Correction:** Field is `code_challenge_method` (not `index_challenge_method`):
```typescript
code_challenge_method: "S256",
```

---

### 5. Idempotency Key Requirements (Correction)

**Correction:** NOT all mutations require `Idempotency-Key`:
- Required: Link start, link approve/deny, link exchange, worker enrollment, credential rotation
- NOT required: Self-revoke (`DELETE /v1/cli/me`), tenant delete (`DELETE /v1/tenants/{tenant}/...`) - these are resource-idempotent

---

### 6. Exchange/Cache Expiry (Correction)

**Location:** `apps/cloud/src/links.ts:238-338`, `enrollment.ts:134-263`

**Correction:** Encrypted exchange cache expiry is bounded to original 10min link/invitation window:
- Line 119: Link expires at `now + 600000` (10 minutes from start)
- Line 86: Enrollment expires at `now + 600000` (10 minutes from creation)
- Replay is only possible WITHIN this original window, not 10min from exchange

---

### 7. MachineAuth Current Membership Proof (Measurable)

**Location:** `apps/cloud/src/machines.ts:85-90, 94, 117`

**Proof:** `machineGuard` at line 85-90 and `activeMember` at line 94 verify current membership:
```typescript
const activeMember = `EXISTS(SELECT 1 FROM users u JOIN memberships m USING(user_id) JOIN organizations o USING(organization_id) WHERE u.user_id=r.user_id AND m.organization_id=r.organization_id AND u.status='active' AND m.status='active' AND o.status='active')`
```

This guard is evaluated EVERY time `machineAuth` is called (line 117), not just at credential issuance.

---

### 8. Audit Rollback Measured

**Location:** `apps/cloud/src/links.ts:204-313`

**Measured in test:** `link exchange denied when approving account loses active membership`

The exchange operation's batch includes:
1. UPDATE cli_links SET state='consumed'...
2. INSERT cli_installations...
3. INSERT INTO machine_credentials...
4. INSERT INTO audit_events...

All or nothing via D1.batch() - if authority check fails mid-batch, no credential and no audit event are created.

---

## CI-Only Delta (27846bc)

**File:** `.github/workflows/cloud-ci.yml`

**Change:** Adds root CLI install before cloud package:
```yaml
- name: Install CLI dependencies for the real CLI integration test
  working-directory: .
  run: bun install --frozen-lockfile
```

**Reason:** Real Bun CLI subprocess resolves root imports; cloud package alone insufficient.

---

## Unverified Limits (Not Tested)

- **Edge CPU limits:** No assertions about Cloudflare Workers CPU budget
- **D1 quota throttling:** Rate limits implemented but D1 write quota not exercised under load
- **Live preview mutation scripts:** `scripts/preview.ts` not tested in production environment

---

## Summary

**Verdict:** APPROVED with caveats. All identified vulnerabilities disproved through code review and 52 cloud tests. CI-only fix 27846bc noted. Infrastructure monitoring required for untested limits.

**Source references:**
- Security review: `apps/cloud/src/links.ts`, `enrollment.ts`, `machines.ts`
- Redaction: `src/security.ts`
- Tests: `apps/cloud/test/*.integration.ts`
