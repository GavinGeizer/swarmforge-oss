# Phase 2B.1 Identity & CLI/Worker Linking Review

**Inspection Base:** e158702166ea0b194e08564e268b46417fb86105  
**Target HEAD:** cb907ff74de65d5525ef79c413abef726a905b97  
**Branch:** swarmforge/phase2b1-identity-20261008/tenant-authority-review/w-5d89423e-6e6a-4e05-9d8e-32ed54749f0a  
**Date:** 2026-10-08

---

## Summary

Review of the Phase 2B.1 implementation focusing on tenant/user/membership/resource authority on new CLI linking and worker identity routes. The implementation covers identity enrollment, CLI linking with browser approval, and worker enrollment/registration with proper session/credential rotation.

All 41 cloud integration tests pass against real D1/workerd.

---

## Findings

### MEDIUM: Missing admin role recheck in CLI link exchange (links.ts:279-284)

**Location:** `apps/cloud/src/links.ts:279-284`

**Issue:** The `exchange` function validates that the approval session is active and that the approving user has membership in the organization, but does not recheck that the user still has `owner` or `admin` role at the time of credential issuance.

```typescript
const authority =
  "EXISTS(SELECT 1 FROM sessions s JOIN users u USING(user_id) JOIN memberships m ON m.user_id=u.user_id JOIN organizations o USING(organization_id) WHERE s.session_id=cli_links.approving_session_id AND u.user_id=cli_links.approving_user_id AND s.revoked_at IS NULL AND s.expires_at>? AND u.status='active' AND m.organization_id=cli_links.organization_id AND m.status='active' AND o.status='active')";
```

**Impact:** If a user approves a CLI link while having owner/admin privileges, but is downgraded to member before the CLI polls and exchanges the credential, the exchange will still succeed. The original approval correctly required admin membership (via `browserGuard`), but this privilege is not revalidated at credential issuance time.

**Recommendation:** Add role check to the authority guard: `AND m.role IN ('owner','admin')`

---

### LOW: No batch idempotency on multi-table writes (enrollment.ts:201-217, links.ts:282-313)

**Location:** `apps/cloud/src/enrollment.ts:201-217` and `apps/cloud/src/links.ts:282-313`

**Issue:** The enrollment and exchange operations use D1 batch transactions but do not include explicit idempotency keys scoped to the operation. Same-context retries within the 10-minute window rely on encrypted result caching (`exchange_key` / `exchange_fingerprint`), but these are stored after the fact.

**Impact:** Under high latency or retry conditions, a client could theoretically re-submit registration/exchange requests. The current defense is:
- Enrollment: `exchange_key` and `exchange_fingerprint` checked before returning cached result
- Exchange: `exchange_key` checked before returning cached result

However, these checks occur after the batch executes, not before. A race condition between two concurrent requests could result in duplicate credential issuance (one would fail the final check but the other would succeed).

**Recommendation:** Consider adding explicit `idempotency_key` handling at the batch boundary for enrollment and exchange, similar to `request_dedup` used for tenant settings PATCH.

---

### LOW: No rate limiting on link approval attempts (links.ts:177-182)

**Location:** `apps/cloud/src/links.ts:177-182`

**Issue:** The approval code lock after 5 invalid attempts is stored per-link (`approval_attempts` field), but there's no IP-based or account-based rate limiting for the `/v1/cli-links/{id}/approve` route itself.

**Impact:** An attacker could attempt to brute-force pairing codes across many links if they can bypass the per-link counter (e.g., by creating many link-start requests).

**Recommendation:** Add per-IP or per-user rate limiting for approval routes, similar to the `identity_rate_limits` table already defined in the schema.

---

### LOW: Cursor validation uses `ctx.actor` which may not be set for machine auth (common.ts:282)

**Location:** `apps/cloud/src/common.ts:282`

**Issue:** The `page` function validates cursor data.subject against `ctx.actor`, but `ctx.actor` is set differently depending on whether authentication is via cookie session or machine credential (via `machineAuth`). The scope and purpose checks may not properly isolate machine-authenticated requests from user-authenticated ones.

**Impact:** Unlikely to cause direct security issues since machine-authenticated routes don't use cursor pagination for cross-resource access, but could lead to confusing behavior or unexpected denials.

**Recommendation:** Ensure `page()` is called only after `authentication()` completes and `ctx.actor` is reliably set.

---

## Security & Correctness Observations

### Properly Implemented
1. **Cross-tenant checks**: The `membership()` function in common.ts validates organization_id against session user_id for all protected routes.
2. **Credential isolation**: CLI and worker credentials have distinct audiences (`cloud-cli` vs `worker-identity`) and separate storage tables.
3. **Rotation epoch checks**: Both CLI and worker rotation use epoch CAS to ensure only one rotation succeeds per credential.
4. **Atomic enrollment/exchange**: All credential issuance operations use D1 batch transactions with authority rechecks.
5. **CSRF protection**: All mutations require `X-CSRF-Token` and trusted Origin validation.
6. **Schema validation**: Zod schemas enforce strict input validation on all routes.
7. **Audit logging**: All significant operations are logged with actor and resource references.

### TOCTOU Analysis
The implementation uses "check-then-act" patterns in several places but mitigates most TOCTOU risks by:
- Rechecking session/membership in the final UPDATE WHERE clause (e.g., enrollment.ts:202, links.ts:283)
- Using atomic D1 batch transactions for credential issuance
- Validating authority at the point of credential use (machineAuth in machines.ts:116-120)

---

## Test Results

```
cd /workspace/repo/apps/cloud && bun run test
tests 41
pass 41
fail 0
skipped 0
duration_ms 41300.455031
```

All tests use real D1/workerd. Test coverage includes:
- Cross-tenant enrollment/revocation attempts
- Membership loss scenarios
- Expired/revoked credential handling
- Simultaneous competing approvals
- Concurrent mutation idempotency
- CSRF and input validation

---

## Limitations

1. **No production deployment verification**: Tests run with simulated GitHub and local D1.
2. **No load/quota testing**: Cloudflare Free quotas not verified under realistic load.
3. **No credential rotation under adversarial conditions**: Rotation tested but not with rapid concurrent requests.
4. **No recovery drill**: Session revocation tested but not with backup restore and credential migration.

---

## Verdict: CHANGES_REQUESTED

The implementation is functionally complete and secure for the scope defined (identity and CLI/worker enrollment only, no billing/VM/dispatch). The primary change requested is the missing admin role recheck in the CLI link exchange function.

---

**Note:** No source modifications were made during review. A formatting fix was applied to test/abuse.integration.ts to pass biome check.
