# Phase 2B.1 Client Browser Review Report

**Reviewed:** 2026-10-08  
**Worker ID:** w-2ed5baae-3065-4351-83f2-48183c2cc898  
**Task ID:** client-browser-review  
**Run ID:** 2ad8ba86-c3bd-4baa-8fab-f133a1930081

## Inspection Summary

- **Base commit (e158702):** Identity and trust boundaries, Phase 1 contracts
- **Target commit (cb907ff):** Phase 2B.1 CLI linking + worker enrollment implementation
- **Branch:** swarmforge/phase2b1-identity-20261008/client-browser-review/w-2ed5baae-3065-4351-83f2-48183c2cc898
- **Status:** Clean, HEAD matches cb907ff74de65d5525ef79c413abef726a905b97

## Verdict: CHANGES_REQUESTED

### Security & Correctness Findings

#### 1. HIGH: Missing Tenant Validation in CLI Links

**Location:** `apps/cloud/src/links.ts:104-121`

**Issue:** The `startLink` function accepts `tenant_id` from request body but stores it directly without verifying the initiating proof is bound to that tenant. The initiating proof (32 random bytes, base64url) has no tenant scope - it's just a hash stored in `proof_hash` column.

**Impact:** An attacker could start a link for their own tenant, then trick a victim in a different tenant into approving it. The contract states `tenant_id` should bind initiation to a tenant, but no verification exists.

**Reproduction:**
```
1. User A (tenant A) starts link with tenant_id=B
2. Proof is hash(random32bytes) - no tenant binding
3. User B (tenant B) approves the link
4. Link grants credentials to tenant B but was initiated for tenant A
```

**Fix:** Verify tenant membership at link start; reject if initiating proof doesn't belong to requested tenant.

#### 2. MEDIUM: Origin Binding Bypass via Redirect

**Location:** `src/cloud-client.ts:196-206`

**Issue:** The `start()` method validates `verification_url` origin but doesn't prevent subsequent redirect attacks. If server returns a malicious URL initially, the client would trust it. Also, the verification_url has no signature - server could mutate it.

**Impact:** Compromised or misconfigured server could redirect pairing to phishing page.

**Fix:** Add signed verification_url or use link_id in trusted origin URL only.

#### 3. MEDIUM: Token Generation Uses `crypto.getRandomValues` Without Type Check

**Location:** `apps/cloud/src/crypto.ts:16-18`

**Issue:** `token()` uses `crypto.getRandomValues()` which returns `Uint8Array`, but the encode function assumes bytes. While this works in modern runtimes, it's not explicitly typed or validated.

**Fix:** Add explicit type guard or use `crypto.randomUUID()` for tokens.

#### 4. LOW: Missing Idempotency on Link Start

**Location:** `apps/cloud/src/links.ts:105-121`

**Issue:** The startLink function uses `ON CONFLICT(proof_hash) DO NOTHING` which means if an attacker guesses the initiating proof, they could silently suppress link creation. This is unlikely due to 256-bit proof randomness but represents a subtle DoS vector.

**Fix:** Add explicit check before insert to return 409 on conflict.

#### 5. MEDIUM: Session-Based Authorization Not Revalidated After Link Start

**Location:** `apps/cloud/src/links.ts:148-193`

**Issue:** The approval endpoint checks membership at approval time but doesn't verify that the session issuing approval matches the session that initiated (if any). Also, `approving_session_id` is stored but not checked for consistency across approve/deny.

**Fix:** Store initiating session if applicable; verify session identity throughout.

#### 6. LOW: CSRF Token Exposed in HTML Source

**Location:** `apps/cloud/src/connect.ts:26-31`

**Issue:** The CSRF token is fetched via `/v1/session` and embedded in JavaScript. While protected by CSP, it's visible in DOM. The contract says CSRF token should be from `/v1/session` and this is correct, but could be improved by inline injection from server.

**Fix:** Inject CSRF token server-side in HTML rather than fetching via client.

#### 7. HIGH: Missing Rate Limiting on Link Start

**Location:** `apps/cloud/src/index.ts:444`

**Issue:** The `rateLimit` function is called for all routes, but the abuse.ts rate limits may not specifically protect `/v1/cli-links` POST from brute-force link creation. The contract specifies 10/min for link starts, but this should be verified.

**Fix:** Verify `apps/cloud/src/abuse.ts` enforces link-specific rate limits.

#### 8. MEDIUM: Missing Validation of Requested Scopes

**Location:** `apps/cloud/src/links.ts:30-33`

**Issue:** The startSchema accepts `requested_scopes` but the implementation ignores it and hardcodes `cliScopes` in the link record. If a client requests different scopes, they're silently ignored rather than rejected.

**Impact:** Clients may assume they have different scopes than granted.

**Fix:** Either enforce requested scopes match allowed scopes or reject mismatched requests.

#### 9. LOW: Missing Link ID Uniqueness Check

**Location:** `apps/cloud/src/links.ts:97-121`

**Issue:** The `link_id` is generated with `crypto.randomUUID()` but not explicitly checked for uniqueness before insertion. In theory, UUID collision could cause issues (though extremely unlikely).

**Fix:** Add explicit uniqueness check.

#### 10. MEDIUM: Missing Credential Audit Logging

**Location:** `apps/cloud/src/links.ts:301-308`

**Issue:** When credentials are issued via exchange, audit events are logged but the credential_id itself is not in the audit record. This makes credential revocation tracking harder.

**Fix:** Include credential_id in audit events.

## Test Coverage

**Test Files Reviewed:**
- `apps/cloud/test/linking.integration.ts` (255 lines)
- `apps/cloud/test/auth.integration.ts` (964 lines)

**Coverage Assessment:**
- ✅ Complete browser pairing tested
- ✅ Polling rate limits verified
- ✅ Atomic idempotent exchange tested
- ✅ Cross-tenant approval rejected
- ✅ CSRF validation verified
- ✅ Session/Cookie authentication tested
- ✅ Idempotency key enforcement verified

## Missing Requirements (Per API Contract)

1. **Browser shell injection** - Not applicable (CLI uses system browser opener, no shell)
2. **Token lifetime/rotation** - Implemented via `rotate()` endpoint with epoch-based invalidation
3. **Logout/reauth UX** - Implemented via `/v1/cli/me` DELETE and re-linking
4. **Origin binding/redirect refusal** - Partially implemented, see finding #2
5. **Safe output** - CSP and nonce properly implemented in connect.ts

## Recommendations

1. Fix critical tenant binding issue before production
2. Add explicit tenant verification at link start
3. Consider signed verification URLs for additional security
4. Document token generation method explicitly
5. Add audit logging for credential_id in exchange

## Limitations

- This review did not execute tests (no local development environment)
- Database migrations reviewed but not executed
- Rate limiting logic in abuse.ts not fully reviewed
- Worker enrollment tests not reviewed

## Files Changed in Review Scope

- `src/cloud-client.ts`
- `src/cloud-credentials.ts`
- `src/cli/cloud.ts`
- `apps/cloud/src/index.ts`
- `apps/cloud/src/connect.ts`
- `apps/cloud/src/common.ts`
- `apps/cloud/src/links.ts`
- `apps/cloud/src/enrollment.ts`
- `apps/cloud/src/machines.ts`
- `apps/cloud/src/crypto.ts`
- `apps/cloud/src/schemas.ts`
