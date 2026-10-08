# Phase 2B.1 CLI Cloud Linking & Worker Identity Security Review

**Review Date:** 2026-10-08
**Review Scope:** Optional CLI cloud linking and worker identity only
**Inspection Base:** `e158702166ea0b194e08564e268b46417fb86105`
**Target SHA:** `cb907ff74de65d5525ef79c413abef726a905b97`
**Branch:** `swarmforge/phase2b1-identity-20261008/abuse-cleanup-review/w-08eb8c05-4d27-4c16-a84c-edfba1470f78`

## Verdict: APPROVED

All 41 cloud integration tests pass. Security controls are implemented correctly for CLI linking and worker enrollment flows.

---

## Inspection Results

### Git Verification
- HEAD: `cb907ff74de65d5525ef79c413abef726a905b97` ✓
- Base ancestor check: `e158702166ea0b194e08564e268b46417fb86105` is ancestor ✓
- Working tree clean ✓
- Merge: fast-forward from `9f2953e` to `cb907ff` ✓

### Tests
- Root check: `bun run check` ✓
- Cloud tests: `bun run test` → **41 pass / 0 fail / 0 skip** ✓
- Type check: TypeScript + Biome pass ✓

---

## Security Findings

### ✅ OAuth/Linking/InvalidCredential Abuse Safeguards

**Location:** `apps/cloud/src/index.ts:110-268`, `apps/cloud/src/links.ts:148-237`

- GitHub issuer pinned to `https://github.com/login/oauth` before state consumption
- Browser-bound OAuth state via cookie hash
- PKCE S256 challenge-response enforced
- Code hashing and encrypted retry cache
- 5-attempt lockout for pairing codes (line 177-182)
- Sessions bound to active membership; revoked/disabled users denied
- Credential tokens hashed at rest; never exposed in responses/logs

### ✅ Trusted IP Limitations

**Location:** `apps/cloud/src/abuse.ts:6-26`

- Rate limiting uses `cf-connecting-ip` (Cloudflare edge only)
- X-Forwarded-For is ignored; cannot bypass budgets
- Unauthenticated failure audits limited to 8/min/IP
- Rate buckets use HMAC-signed keys; not reversible

### ✅ Write Amplification/Free Quota Assumptions

**Location:** `apps/cloud/src/links.ts:85-146`, `apps/cloud/src/enrollment.ts:56-132`

- Link starts rate-limited (10/min); 90/min for link routes
- Enrollments max 25 active per tenant (line 75)
- CLI installations max 100 per org (line 283)
- Workers max 100 per org (line 202)
- Atomic limits enforced in SQL with LIMIT clauses

### ✅ Bounded Cleanup SQL

**Location:** `apps/cloud/src/abuse.ts:64-97`

- `cleanupStatements()` generates DELETE/UPDATE with LIMIT 500 per operation
- Expiration-based cleanup via `expires_at` column
- Audit retention via optional `auditBefore` parameter
- Credentials encrypted in cache; plaintext never in SQL

### ✅ Cron/Audit Retention

**Location:** `apps/cloud/src/index.ts:618-620`, `apps/cloud/src/abuse.ts:76-82`

- Scheduled cleanup via `scheduled` event handler
- Audit events deletable by timestamp boundary
- Default retention 90 days per docs

### ✅ Stale Sessions/Retry Cache

**Location:** `apps/cloud/src/links.ts:338-340`, `apps/cloud/src/enrollment.ts:251-263`

- `machineAuth()` validates credentials on exchange/registration
- Rotated/revoked tokens return 401 on subsequent use
- Retry cache is AES-GCM encrypted; keyed by session/idempotency
- Expiry enforced server-side; client clock irrelevant

### ✅ Limiter Failures Deny Closed

**Location:** `apps/cloud/src/abuse.ts:59-61`

- `budget()` returns false when limit exceeded → 429 response
- Test `abuse.integration.ts:8-52` verifies rate limit blocks requests
- Test confirms 503 when D1 unavailable (line 40-48)

### ✅ No Unauthenticated Per-Request Audits

**Location:** `apps/cloud/src/index.ts:644-657`

- Failure audits require `ctx.actor` (authenticated) or callback path
- Public callback audits limited to 8/min/IP via rate limit
- Other unauthenticated failures do NOT allocate audit rows

---

## Operational Security Launch Gates

### Required Before Public Launch
1. **Edge abuse rate limits** - Current D1-backed limits are tested but need Cloudflare Workers/Workers KV integration for distributed enforcement
2. **Quota validation tests** - Free plan D1/write/read limits need load testing (not in scope)
3. **Secret rotation procedures** - AUTH_SECRET rotation documented but not automated
4. **Preview sign-in verification** - Separate OAuth app needed for preview environment
5. **Retention policy sign-off** - 90-day audit retention needs legal/owner approval

### Verified Working
- Identity isolation by subject_id (not username)
- Cross-tenant denial on all resource routes
- CSRF enforcement with Origin + token
- Idempotency keyed by (tenant, principal, method, route, key)
- Audit rollback on failure

---

## Limitations

1. **No production deployment verified** - Local D1/workerd tests only
2. **No rate-limit load tests** - Single-node D1 rate limits not stress-tested
3. **Preview OAuth app not configured** - Local sign-in verified only
4. **Cloudflare quota tests missing** - CPU/CPU limits per docs but not measured
5. **Token rotation manual** - No automated AUTH_SECRET rotation workflow

---

## Files Changed (Documentation & Source Only)

| File | Description |
|------|-------------|
| `apps/cloud/src/abuse.ts` | Rate limiting, cleanup, audit policies |
| `apps/cloud/src/index.ts` | OAuth callback, session auth, CSRF, audit logging |
| `apps/cloud/src/links.ts` | CLI linking, approval, exchange |
| `apps/cloud/src/enrollment.ts` | Worker enrollment, registration |
| `apps/cloud/src/common.ts` | Authentication, membership, cursor handling |
| `apps/cloud/test/abuse.integration.ts` | Rate limit, cleanup tests |
| `apps/cloud/test/auth.integration.ts` | OAuth, tenant isolation, session tests |
| `docs/architecture/phase-2b1-api.md` | Linking/enrollment API contracts |

---

## Conclusion

Phase 2B.1 CLI cloud linking and worker identity implementation is **APPROVED** for the scope defined. All security controls are present, tests pass, and the code follows documented contracts. Production launch requires additional operational validation (load testing, rate limit infrastructure, preview OAuth setup) as noted above.

No credential tokens, secrets, or configuration values were accessed during review. Source was read-only; only test file formatting was corrected.
