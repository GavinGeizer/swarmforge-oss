# Credential Storage Review

**Worker ID:** w-74d1d8ad-ecff-4825-a887-c7a9d345624a
**Task ID:** credential-storage-review
**Run ID:** bf2bc184-8b61-4e3d-a082-188dc1560307

## Git State
- **Branch:** swarmforge/phase2b1-identity-20261008/credential-storage-review/w-74d1d8ad-ecff-4825-a887-c7a9d345624a
- **HEAD:** cb907ff74de65d5525ef79c413abef726a905b97
- **Base Commit:** e158702166ea0b194e08564e268b46417fb86105
- **Status:** Clean working tree, fast-forward merge from phase2b1-cloud-linking

---

## Findings (Ordered by Severity)

### 1. MEDIUM: Credential Storage Path Resolution Uses User-Writable Env Var

**Location:** `src/cloud-credentials.ts:62-68`

```typescript
export function cloudCredentialPath(path?: string, env = process.env) {
  return resolve(
    path ??
      env.SWARMFORGE_CLOUD_CREDENTIALS_PATH ??
      join(dirname(defaultConfigPath(env)), "cloud-credentials.json"),
  );
}
```

**Impact:** The `SWARMFORGE_CLOUD_CREDENTIALS_PATH` environment variable allows the user to specify any path for credential storage. While the storage functions validate the path (checking for private ownership, no symlinks, etc.), an attacker who can set this env var could:
1. Redirect credentials to a location they control (if path validation doesn't catch it)
2. Cause credential file to be created in an unexpected location
3. Potentially interfere with credential storage in edge cases

**Reproduction:** Set `SWARMFORGE_CLOUD_CREDENTIALS_PATH` to a path outside user control before running CLI.

**Recommendation:** Either require absolute paths or validate that the resolved path is within a trusted directory hierarchy (e.g., user's home directory or XDG config directory).

---

### 2. MEDIUM: Credential Deletion Does Not Validate Path Before Unlink

**Location:** `src/cloud-credentials.ts:197-204`

```typescript
export function deleteCloudCredential(path: string) {
  try {
    if (!readCloudCredential(path)) return;
    unlinkSync(path);
  } catch {
    throw storageError();
  }
}
```

**Impact:** The function calls `readCloudCredential` first (which validates the path), but then unconditionally calls `unlinkSync(path)` without re-validating. A TOCTOU race condition could theoretically allow:
1. Path validation passes, file is readable
2. Malicious actor replaces file with symlink to sensitive file
3. unlinkSync removes the wrong file

**Reproduction:** Exploit timing window between read validation and unlink.

**Recommendation:** Re-validate the path immediately before unlink, or use `unlinkat` with a pre-opened directory file descriptor.

---

### 3. LOW: Credential Schema Does Not Enforce Minimum Expiry

**Location:** `src/cloud-credentials.ts:56-57`

```typescript
expires_at: z.number().int().positive(),
authorization_expires_at: z.number().int().positive(),
```

**Impact:** Credentials can be issued with extremely short expiry (e.g., 1 millisecond). While the cloud-client validates expiry after exchange, an invalid short-lived credential could be accepted by the schema.

**Reproduction:** Attempt to save a credential with expires_at=1 (1ms from epoch).

**Recommendation:** Add minimum expiry validation (e.g., `expires_at > Date.now()` or at least 60 seconds in the future).

---

### 4. LOW: No Audit Logging for Credential Operations

**Location:** Throughout `src/cloud-credentials.ts`

**Impact:** Save, read, and delete operations on credentials produce no local audit trail. While the cloud service maintains audit logs for server-side operations, local credential operations (login, logout, rotation) are not logged locally.

**Recommendation:** Add local audit logging for credential operations for troubleshooting and security monitoring.

---

### 5. INFO: Cloud Client Does Not Expose Credential Details

**Location:** `src/cloud-client.ts` and `src/cli/cloud.ts`

The implementation correctly:
- Never logs credential values
- Never exposes credentials in CLI output
- Uses atomic file operations with fsync
- Validates file permissions (0600) and directory permissions (0700)
- Prevents symlink attacks via O_NOFOLLOW and lstat checks
- Uses atomic rename for writes

---

## Cloud API Contract Compliance

### Verified Against docs/architecture/phase-2b1-api.md

| Feature | Status | Notes |
|---------|--------|-------|
| CLI linking with LinkInitiator proof | ✅ | Implemented in `src/cloud-client.ts` |
| Atomic credential exchange | ✅ | Server-side validated in tests |
| Credential rotation | ✅ | `rotate()` method in CloudClient |
| Installation revocation | ✅ | `revoke()` method implemented |
| Organization-bound credentials | ✅ | tenant_id enforced in exchange |
| No credential leakage in logs | ✅ | Verified in code review |

---

## Test Observations

**Server-side tests (apps/cloud/test/):**
- Linking tests validate proof-bound polling, atomic exchange, and credential isolation
- Auth tests validate session management and revocation
- Tests verify secrets are not stored in plaintext in database

**Root tests (tests/):**
- Some pre-existing test failures unrelated to credential storage (finalization, settings, serve, onboarding, packaging)
- No specific tests for `cloud-credentials.ts` storage security
- No tests for credential path validation edge cases

---

## Security Summary

| Aspect | Status | Notes |
|--------|--------|-------|
| File permissions (0600) | ✅ | Enforced |
| Directory permissions (0700) | ✅ | Enforced |
| Symlink prevention | ✅ | O_NOFOLLOW + lstat checks |
| Atomic writes | ✅ | rename + fsync |
| Schema validation | ✅ | Zod strict schema |
| Credential format | ✅ | Matches documented sfcli_ token |
| No log leakage | ✅ | Verified |
| Expired credential handling | ✅ | Checked before use |

---

## Recommendations Summary

| Priority | Issue | Effort |
|----------|-------|--------|
| MEDIUM | Validate SWARMFORGE_CLOUD_CREDENTIALS_PATH | Low |
| MEDIUM | Fix TOCTOU in deleteCloudCredential | Low |
| LOW | Add minimum expiry validation | Low |
| LOW | Add local audit logging | Medium |

---

## Verdict

**CHANGES_REQUESTED**

The credential storage implementation is fundamentally sound with proper permission checks, atomic writes, and symlink protection. However, there are medium-severity issues around path validation for environment variables and a potential TOCTOU race condition in credential deletion that should be addressed before production deployment.

---

## Limitations

- Reviewed code only; no live credential files accessed
- Server-side implementation in apps/cloud/ reviewed via tests and migration files only
- Integration with actual Cloudflare Workers deployment not tested
- Tests not modified as per instructions
