# OAuth Issuer Security Review

**Review Date:** 2026-10-08
**Worker ID:** w-670eb68c-2893-4a39-908a-266cd866ade8
**Task ID:** oauth-issuer-security-review
**Run ID:** 20f35b3b-c293-4803-ae39-f408e1c81f1c
**Base Commit:** 79e2787481ec9f7661817f60e3bdebec7242b81e
**Target Commit:** 55826573b717e88023e9b271816cf222e8b22974

## Verdict: APPROVED

The OAuth issuer validation fix has been reviewed. No security vulnerabilities or regressions identified. All 25 tests pass.

---

## Summary of Changes

The change addresses a GitHub breaking change where OAuth callbacks now include an `iss` (issuer) parameter per RFC 9207. The fix:

1. Adds explicit issuer validation
2. Maintains backward compatibility (optional `iss`)
3. Preserves all existing security properties

---

## Files Changed

| File | Lines Changed | Purpose |
|------|---------------|---------|
| `apps/cloud/src/provider.ts` | 2-82 | Added `githubIssuer` constant |
| `apps/cloud/src/index.ts` | 367,390,400,407,885 | Added `iss` validation, audit reasons |
| `apps/cloud/test/auth.integration.ts` | 151-299 | Added 2 test suites (150 lines) |
| `apps/cloud/test/runtime.integration.ts` | 103,140 | Updated to include `iss` in callbacks |
| `apps/cloud/README.md` | 54-55 | Documented the fix |
| `docs/architecture/phase-2a-api.md` | 18 | Updated API spec |

---

## Security Findings

### Finding 1: Issuer Validation (INFO)
**Location:** `apps/cloud/src/index.ts:390`, `apps/cloud/src/provider.ts:2`

**Description:** The `iss` parameter is validated against the pinned GitHub issuer `https://github.com/login/oauth`. Missing `iss` is accepted for backward compatibility.

**Risk:** Informational - This is a security improvement.

**Verification:** Test `GitHub issuer is pinned before state consumption and valid issuer callbacks retain replay protection` validates hostile variants:
- `https://attacker.invalid/login/oauth` → 400
- `https://github.com` → 400
- `http://github.com/login/oauth` → 400
- `https://github.com/login/oauth/` → 400
- `https://github.com.evil.invalid/login/oauth` → 400

---

### Finding 2: Strict Parameter Validation (INFO)
**Location:** `apps/cloud/src/index.ts:392`

**Description:** Uses Zod's `.strict()` to reject unknown query parameters. Prevents parameter pollution attacks.

**Risk:** Informational - This is a security improvement.

**Verification:** Test validates duplicate `iss` parameters return 400.

---

### Finding 3: Fixed Audit Reasons (INFO)
**Location:** `apps/cloud/src/index.ts:56-70`, `apps/cloud/src/index.ts:400,407`

**Description:** Errors use fixed `auditReason` values without including credential values in logs.

**Risk:** Informational - Prevents credential leakage.

**Verification:** Test validates credentials do not appear in audit events or logs.

---

### Finding 4: Validation Before State Consumption (INFO)
**Location:** `apps/cloud/src/index.ts:386-418`

**Description:** Schema validation occurs before database state consumption. Invalid callbacks never consume OAuth transactions.

**Risk:** Informational - This is a security improvement.

**Verification:** Tests verify `oauth_transactions.consumed_at` remains null after rejected callbacks.

---

### Finding 5: Browser Proof Binding (INFO)
**Location:** `apps/cloud/src/index.ts:394,402-408`

**Description:** Browser cookie validation remains unchanged. Missing/invalid browser proof returns 400 with `oauth_browser_proof_missing_or_invalid`.

**Risk:** Informational - No regression.

---

### Finding 6: Replay Protection Intact (INFO)
**Location:** `apps/cloud/src/index.ts:409-418`

**Description:** The state hash + browser hash + timestamp check for replay protection is unchanged.

**Risk:** Informational - No regression.

**Verification:** Test validates successful callback cannot be replayed.

---

## Test Results

```
✔ verified provider login creates persistent personal authority and revocable session
✔ callback replay and arbitrary state cannot create accounts
✔ GitHub issuer is pinned before state consumption and valid issuer callbacks retain replay protection
✔ callback audit distinguishes invalid parameters and missing browser proof without credentials
... (21 more tests)
ℹ tests 25
ℹ pass 25
ℹ fail 0
```

---

## No Vulnerabilities Found

| Category | Status |
|----------|--------|
| OIDC/IAM | ✅ No issues |
| Token handling | ✅ No issues |
| Cookie handling | ✅ No issues |
| Audit logging | ✅ No credential leakage |
| Parameter validation | ✅ Strict mode enabled |
| Replay attacks | ✅ Protection intact |

---

## Conclusion

The change is a security improvement that addresses GitHub's RFC 9207 compliance without introducing vulnerabilities. All existing security properties are preserved.
