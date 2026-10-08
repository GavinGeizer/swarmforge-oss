# GitHub Device Flow Regression Test Review

**Reviewed:** 2026-10-08  
**Worker ID:** w-2ed5baae-3065-4351-83f2-48183c2cc898  
**Task ID:** client-browser-review  
**Run ID:** 90fc04c7-b707-4251-b517-0468dac54003  
**Test Branch:** origin/swarmforge/phase2b1-identity-20261008/github-compatibility-tests/w-5831cfa8-e4f2-46d9-a6dd-798ff59b95b2  
**Test Commit:** 04e3cbaf0b2e9fc2f096d4af2b4eda5ec17f429c

## Test File
- Path: `tests/github-device-flow-regression.test.ts`
- Total tests: 9
- Test runner: Bun test (`bun test`)
- Execution time: 6.24s

## Test Suite Structure

### Mock Setup
- `setupFetchMock()` creates comprehensive mock responses for all GitHub API endpoints
- Mocks: device code, access token, user info, repo permissions
- Proper teardown: `globalThis.fetch = originalFetch` in `afterEach`
- Uses proper Response objects with ReadableStream bodies (matches real fetch API)

### File Handling
- Creates isolated temp directories with `mkdtempSync`
- Cleans up in `afterEach`
- Credential files created with 0600 permissions
- Tests credential file permissions (0600 required, 0644 should fail)

## Individual Test Analysis

### 1. `successful flow writes credential file` ✅
**Purpose:** Tests complete happy path

**What it verifies:**
- Credential file created at expected path
- `expectCredential()` validates schema (version: 1, clientId, repository, login)
- Log contains "Connected GitHub account"

**Assessment:** Adequate coverage for basic flow

### 2. `uses correct device flow scope` ❌ **NO ASSERTIONS**
**Purpose:** Should verify `repo` scope is requested

**Critical issue:** 
```typescript
test("uses correct device flow scope", async () => {
  setupFetchMock();
  const { loginGithub } = await import("../src/github-oauth");
  const path = join(tempDir, "scope-test.json");

  await loginGithub({
    clientId: "test_client_id",
    repository: "testuser/test-repo",
    path,
    signal: AbortSignal.timeout(30000),
    write: () => {},
  });
  // NO ASSERTIONS - just runs without error
});
```

**Problems:**
- No verification that scope parameter is passed correctly
- No assertion checking device code request contains `scope: "repo"`
- Test passes as long as no exception thrown
- Lead note confirmed: "uses-correct-scope test has no assertions"

**Required fix:** Add assertion that validates scope was requested:
```typescript
const capturedCalls: {url:string,body?:any}[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async function(url, opts) {
  capturedCalls.push({url:url as string,body:opts?.body});
  // ... return mock response
};
// ... run test ...
const deviceCall = capturedCalls.find(c => c.url.includes('/login/device/code'));
expect(deviceCall?.body).toContain('scope=repo');
```

### 3. `denied authorization throws` ✅
**Purpose:** Tests error handling when access denied

**What it verifies:**
- Mock returns `{error: "access_denied"}`
- Throws with pattern `/denied|expired|rejected/i`

**Assessment:** Adequate error path coverage

### 4. `missing repo scope throws` ✅
**Purpose:** Tests scope validation

**What it verifies:**
- Mock returns scope `read:user` (not `repo`)
- Throws with pattern `/repository authorization/i`

**Assessment:** Correctly validates scope check exists

### 5. `missing push permission throws` ✅
**Purpose:** Tests permission validation

**What it verifies:**
- Mock returns `permissions: {push: false, pull: true}`
- Throws with pattern `/push permission/i`

**Assessment:** Correctly validates permission check

### 6. `invalid device code throws` ✅
**Purpose:** Tests device flow validation

**What it verifies:**
- Mock returns `{invalid: "response"}` (missing required fields)
- Throws with pattern `/device flow/i`

**Assessment:** Correctly validates schema parsing

### 7. `credential requires private permissions` ✅
**Purpose:** Tests file permission validation

**What it verifies:**
- Creates file with 0644 permissions (not private)
- `githubOauthToken()` throws with `/not privately owned/i`

**Assessment:** Correctly validates file permissions

### 8. `credential requires correct repository` ✅
**Purpose:** Tests repository binding validation

**What it verifies:**
- Creates credential bound to `other/repo`
- Calls `githubOauthToken(path, "test/test")`
- Throws with `/different repository/i`

**Assessment:** Correctly validates repository binding

### 9. `credential file shows login output` ✅
**Purpose:** Tests user info display

**What it verifies:**
- Log contains user login name

**Assessment:** Adequate output verification

## Critical Findings

| Severity | Finding | Test | Impact |
|----------|---------|------|--------|
| HIGH | No assertions in `uses correct device flow scope` | #2 | Test doesn't verify scope parameter passed to GitHub API |
| MEDIUM | No test for `authorization_pending` polling | None | Loop behavior not validated |
| MEDIUM | No test for `slow_down` interval increase | None | Polling rate limit handling not tested |
| LOW | No test for expiration timeout | None | Deadline-based failure not explicitly tested |
| LOW | No test for signal abort handling | None | AbortSignal behavior not validated |

## Test Evidence Provided

The test file provides evidence for:
- ✅ Device flow initiation
- ✅ Token exchange
- ✅ User info retrieval
- ✅ Repository info retrieval
- ✅ Scope validation (throws when missing)
- ✅ Permission validation (throws when missing)
- ✅ Credential file creation with proper permissions
- ✅ Repository binding validation
- ✅ Error message patterns

## Recommendations

### Critical (before merge):
1. **Add assertions to `uses correct device flow scope`** - Must verify that `scope=repo` is included in the device code request body

### High priority:
2. Add test for `authorization_pending` polling loop behavior
3. Add test for `slow_down` interval increase handling

### Medium priority:
4. Add explicit test for timeout/expired deadline
5. Add test for AbortSignal cancellation

## Conclusion

**Verdict:** CHANGES_REQUESTED

**Rationale:** The test suite has good coverage but the `uses correct device flow scope` test has no assertions, which means it doesn't actually verify that the correct scope is sent to GitHub. This is a critical gap as scope validation is the primary security boundary in the OAuth flow.

**Test execution:** 9 tests pass in worktree at commit 04e3cbaf0b2e9fc2f096d4af2b4eda5ec17f429c

**Main branch:** /workspace/repo remains at cb907ff (clean, dirty=false, persisted=false)
