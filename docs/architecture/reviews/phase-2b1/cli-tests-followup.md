# Independent Test Review Follow-up: cloud-phase2b1.test.ts

**Revision:** 4aa394a69bc887a183f794cd1cdfbc1b34cacb0e  
**Base:** cb907ff74de65d5525ef79c413abef726a905b97  
**Review Date:** 2026-10-08

---

## Summary

**Status:** APPROVED  
**Severity:** N/A (No findings)

The replacement test file `tests/cloud-phase2b1.test.ts` (433 lines) properly exercises production code with real HTTP fixtures. All 10 tests pass. Tests verify production CloudClient/store/cloudCommand against Bun.serve HTTP fixtures, no tautologies, proper proof/continuity testing, negative cases, and edge cases.

---

## Verification

### Tests Run
```
bun --no-env-file --config=/dev/null test tests/cloud-phase2b1.test.ts
10 pass
0 fail
67 expect() calls
Ran 10 tests across 1 file. [10.35s]
```

### Lint/Type Check
```
bun run check
Checked 115 files in 523ms. No fixes applied.
```

---

## Production Code Imports

**Location:** `tests/cloud-phase2b1.test.ts:14-23`

```typescript
import { parseArguments } from "../src/cli/arguments";
import { cloudCommand } from "../src/cli/cloud";
import { CloudApiError, CloudClient } from "../src/cloud-client";
import {
  type CloudCredential,
  cloudOrigin,
  deleteCloudCredential,
  readCloudCredential,
  saveCloudCredential,
} from "../src/cloud-credentials";
```

**Verification:** All production code properly imported before use.

---

## Bun.serve HTTP Fixture

**Location:** `tests/cloud-phase2b1.test.ts:54-60`

```typescript
function api(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    close: () => server.stop(true),
  };
}
```

**Verification:** Real HTTP server used with dynamic port allocation.

---

## Test Coverage Analysis

### Test 1: Command Parsing and Origin Validation (lines 66-92)
- Verifies parseArguments preserves GitHub login
- Tests cloudOrigin rejects unsafe origins (public.example, credentials in URL, path, query string)
- Verifies errors don't echo sensitive input

### Test 2: Credential Store Round-trip (lines 94-121)
- Verifies save/read credential round-trip
- Checks file mode 0o600, directory mode 0o700
- Rejects corrupt data without exposing values

### Test 3: Store Security Rejections (lines 123-160)
- Symlinks rejected
- Hard links rejected
- Unsafe file modes (0o644) rejected
- Unsafe directory modes (0o755) rejected
- Oversized files (16385 bytes) rejected
- Invalid scopes rejected

### Test 4: Real HTTP Pairing (lines 162-219)
- Verifies proof continuity through pending polling
- Verifies idempotency key continuity
- Verifies no cookies sent (cookie: null)
- Tests pending state then exchange success

### Test 5: Error Body Sanitization (lines 221-237)
- Verifies error messages don't leak credentials
- Tests CloudApiError handling

### Test 6: Redirect Rejection (lines 239-258)
- Verifies client rejects HTTP 302 redirects
- Verifies credentials not sent to redirect target (leaked: 0)

### Test 7: Hostile URL/Response Rejection (lines 260-299)
- Wrong origin (evil.example) rejected
- Extra URL parameters rejected
- Extra body fields (raw_token) rejected
- Wrong content-type (text/html) rejected
- Oversized responses (131073 bytes) rejected

### Test 8: CLI Status and Identity Swap (lines 301-337)
- Verifies status uses own bearer token
- Verifies identity swap rejected
- Verifies credential not in output

### Test 9: CLI Logout (lines 339-377)
- Verifies remote revocation then local deletion
- Verifies unconfirmed revocation reported safely
- Verifies credential not in output
- Verifies no cookies sent

### Test 10: Expiry and Origin Mismatch (lines 379-433)
- Expired credentials fail before contacting service
- Origin mismatch fails before contacting service
- Signed-out logout is local-only (0 service calls)

---

## No Tautologies or Trivial Assertions

**Rejected patterns:** `expect(proof).toBe(proof)`, `expect(interval).toBe(5)`, `expect(budget).toBe(1)`

**Actual assertions:** `expect(result.credential).toBe(c.credential)`, `expect(calls).toHaveLength(3)`, `expect(call.cookie).toBeNull()`, `expect(leaked).toBe(0)`, `expect(readCloudCredential(path)).toBeNull()`

All assertions verify production behavior, not constant values.

---

## Evidence

| Coverage | Evidence |
|----------|----------|
| Real HTTP fixture | Bun.serve at line 55, `server.port` dynamic allocation |
| Proof continuity | Line 212: `expect(call.authorization).toBe(\`LinkInitiator \${link.proof}\`)` |
| Key continuity | Line 215: `expect(calls[1]!.key).toBe(calls[2]!.key)` |
| No cookies | Line 213: `expect(call.cookie).toBeNull()` |
| No redirects | Line 253: `expect(leaked).toBe(0)` |
| URL validation | Lines 292-295: mode 0-4 all reject with /invalid/ |
| Body validation | Lines 283-287: raw_token field rejected |
| Response validation | Lines 264-271: text/html and 131073 bytes rejected |
| Filesystem security | Lines 129-150: symlinks, hardlinks, modes, size |
| Status identity | Lines 326-332: identity swap rejected |
| Logout sequence | Line 366: methods = ["DELETE"] |
| Negative cases | Lines 388-414: expiry, origin mismatch, signed-out |

---

## Conclusion

All tests properly exercise production code with real HTTP fixtures. No tautologies detected. Test names accurately reflect coverage. All edge cases and negative paths verified.

**APPROVED**
