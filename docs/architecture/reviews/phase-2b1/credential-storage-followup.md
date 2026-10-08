# Credential Storage Follow-up Review

**Worker ID:** w-74d1d8ad-ecff-4825-a887-c7a9d345624a
**Task ID:** credential-storage-review
**Run ID:** f9a02dbf-2363-44e6-bddc-b40f5979cc82

---

## Corrections to Original Review

### Finding 1 (Path via Env Var): CORRECTED - NOT A VULNERABILITY

**Original Claim:** MEDIUM severity - `SWARMFORGE_CLOUD_CREDENTIALS_PATH` env var allows arbitrary path specification.

**Correction:** This is not a vulnerability. If an attacker can modify the target user's environment variables, they already have full control over that user's process execution and can directly manipulate credential files through other means. The credential storage functions still validate the resolved path for:
- Ownership (file and directory owned by running UID)
- Permissions (0600 for file, 0700 for directory)
- No symlinks anywhere in path

**Reproduction:** Requires ability to modify target user's environment - which grants arbitrary code execution as that user, far exceeding credential theft scope.

---

### Finding 2 (TOCTOU in deleteCloudCredential): CORRECTED - NOT A VULNERABILITY

**Original Claim:** MEDIUM severity - Race condition where symlink could replace file between validation and unlink.

**Correction:** This is not a vulnerability:
1. POSIX `unlink()` removes the symlink itself, NOT the target file
2. The parent directory is validated as 0700 and owned by same user
3. A different user cannot replace the file in an 0700 directory owned by the credential owner
4. The same-user vs root case is not a confidentiality boundary (root can already read everything)

The TOCTOU window cannot be exploited by an attacker who does not already have write access to the parent directory.

---

### Finding 3 (No Minimum Expiry): CORRECTED - INTENTIONAL DESIGN

**Original Claim:** LOW severity - Credentials with extremely short expiry could be accepted.

**Correction:** This is intentional and correct. Expired credentials must remain parseable to:
- Allow `logout` to function (which checks expiry and calls server revoke)
- Allow `status` to identify expired state and prompt re-login
- Enable credential recovery/audit operations

The client checks credential validity (expiry) before USE, not before storage:
- `src/cli/cloud.ts:128-134`: Checks `expires_at <= Date.now()` before using credentials
- Server-side validation in `src/cloud-client.ts:251-257`: Validates expiry after exchange

---

### Finding 4 (No Local Audit Logging): CORRECTED - INTENTIONAL DESIGN

**Original Claim:** LOW severity - Local audit logging not implemented for credential operations.

**Correction:** Local audit logging was intentionally NOT added to avoid:
- Storing sensitive information (credential IDs, tenant IDs, timestamps) in local logs
- Creating additional attack surface for credential disclosure
- Violating the principle that only the server should maintain authority-related audit trails

Server-side audit logs already track all credential operations (login, logout, rotation).

---

## Confirmed Security Controls

The implementation is sound:

| Control | Status | Verification |
|---------|--------|--------------|
| File permissions (0600) | ✅ | `saveCloudCredential`: `openSync(..., 0o600)` |
| Directory permissions (0700) | ✅ | `parent()`: creates/validates 0700 |
| Symlink prevention | ✅ | `O_NOFOLLOW` + `lstat` checks |
| Atomic writes | ✅ | `renameSync()` + `fsyncSync()` |
| Schema validation | ✅ | Strict Zod schema with server URL validation |
| Credential format | ✅ | Regex: `^sfcli_[A-Za-z0-9_-]{43}$` |
| No log leakage | ✅ | No credential values in CLI output |
| Expiry enforcement | ✅ | Checked before credential use |
| Server-side revocation | ✅ | Revoke called on logout/rotation |

---

## Conclusion

**VERDICT: APPROVED**

After re-evaluation with the correct threat model:
- No medium or low severity findings remain valid
- The credential storage implementation correctly handles:
  - Secure file permissions and ownership validation
  - Symlink attack prevention
  - Atomic write operations
  - Credential lifecycle (login/logout/rotate/status)
  - Expired credential handling for recovery
- The server maintains authoritative audit trails

The original findings resulted from applying an overly broad threat model that assumed capabilities (modifying target user's environment, different-user parent directory manipulation) that would already constitute full compromise of the target system.

---

## Verification Commands

```bash
# Check type checking and code style
bun run check

# Inspect credential storage implementation
grep -n "storageError\|parent\|regular" src/cloud-credentials.ts
grep -n "cloudCredentialPath" src/cloud-credentials.ts
grep -n "deleteCloudCredential" src/cloud-credentials.ts
```

No source mutations required.
