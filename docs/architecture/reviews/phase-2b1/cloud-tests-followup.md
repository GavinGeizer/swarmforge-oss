# Cloud Adversarial Tests Follow-Up Review

**Previous Review:** b8f9844 - CHANGES_REQUESTED (cleanup/db failure tests weak)  
**New Commit:** 89d86b40ea251fab0472c4945e5141bfa94ab100  
**Re-review Date:** 2026-10-08  
**Base Branch:** cb907ff74de65d5525ef79c413abef726a905b97

---

## Original Findings (b8f9844)

| Issue | Original Status | b8f9844 |
|-------|----------------|----------|
| cleanupIdentity test | ❌ Only validated setup (future expires_at, counts) | Never called cleanupIdentity() |
| DB failure test | ❌ Used state='denied' update | Manual state mutation |

**Lead Feedback:** Tests rejected until actual cleanupIdentity and proper DB failure handling.

---

## New Implementation (89d86b4)

### 1. cleanupIdentity Test - FIXED ✓

**Before (b8f9844):**
```typescript
await h.db.prepare("UPDATE cli_links SET expires_at=? WHERE link_id=?")
  .bind(future, link.link_id).run();
const cliCount = await count(h, "cli_links");  // Just counts, no cleanupIdentity call
```

**After (89d86b4):**
```typescript
import { cleanupIdentity } from "../src/abuse.ts";
// ...
const env = { DB: h.db } as Env;
await cleanupIdentity(env, future);  // Actually calls production cleanupIdentity
const countAfter = await count(h, "cli_links");
assert.equal(countAfter, countBefore - 1);  // Validates 1 link removed
assert.equal(auditAfter, auditBefore);  // Audit preserved
```

### 2. DB Failure Test - FIXED ✓

**Before (b8f9844):**
```typescript
await db.prepare("UPDATE cli_links SET state='denied' WHERE link_id=?").run();
const r = await h.exchange(link);
assert.equal(r.status, 403);  // Only checked state change
```

**After (89d86b4):**
```typescript
await h.db.prepare("DROP TABLE machine_credentials").run();  // Actual DB failure
const r = await h.exchange(link);
assert.equal(r.status, 503);  // Proper 503 closed failure
const installCount = await count(h, "cli_installations");
assert.equal(installCount, 0);  // No partial credential
const linkRow = await h.db.prepare("SELECT state FROM cli_links WHERE link_id=?").bind(link.link_id).first();
assert.equal(linkRow?.state, "approved");  // Link state unchanged
```

### 3. Additional Changes

| Test | Change |
|------|--------|
| concurrent link starts | Uses Promise.all for true concurrency |
| credential rotation | Simplified concurrent winner test |
| enrollment replay | Same key exact replay now returns 201 (cached) |
| credential isolation | Added separate worker credential isolation |

---

## Independent Test Verification (Bun 1.4.2)

**Environment:**
- Bun version: 1.4.2
- Node.js: 24.0.0
- Tests run in detached worktree at 89d86b4

**Test Results:**
```
ℹ tests 51
ℹ pass 51
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ duration_ms 50479.120163
```

**Key Test Verifications:**

| Test | Status | Assertions |
|------|--------|------------|
| cleanupIdentity removes expired unconsumed | ✅ PASS | Verified 1 link removed, audit preserved |
| DB failure denies closed without partial credential | ✅ PASS | Verified 503, no install, link state unchanged |
| concurrent winners invalidate old tokens | ✅ PASS | Same credential_id, old token 401 |
| exact replay returns cached | ✅ PASS | Same key returns 201 with same credential |

---

## Changes from b8f9844 to 89d86b4

```diff
 apps/cloud/test/additional-hostile.integration.ts | 236 ++++++++++++++++++
```

**Key Changes:**
1. **cleanupIdentity** - Now imports and calls production cleanupIdentity() instead of manual test setup
2. **DB failure** - Now uses DROP TABLE for actual DB failure, returns 503 (not 403)
3. **Concurrent starts** - Uses Promise.all for true concurrency testing
4. **Removed unused vars** - c1 removed from consumed link test

---

## Final Verdict: APPROVED ✓

All previously identified issues have been fixed:

| Finding | Status | Verification |
|---------|--------|--------------|
| cleanupIdentity test | ✅ FIXED | Now calls production cleanupIdentity, validates 1 removal |
| DB failure test | ✅ FIXED | Now uses DROP TABLE, returns 503, no partial state |
| Concurrent tests | ✅ IMPROVED | Uses Promise.all for true concurrency |

All 51 tests pass with Bun 1.4.2 against real D1/workerd.

---

## Notes

- Main branch (cb907ff) remains unchanged and clean
- This is a TEST-ONLY branch with 1 file modified (236 lines added)
- No source code changes required
- Test coverage is now adequate for hostile behavior verification
