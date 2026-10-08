# Phase 2B.1 Checkpoint Review

**Worker:** w-ca2ea4f8-8f13-41ef-a9f8-d0d9c5d040a6  
**Task:** architecture-review  
**Run:** 6c778892-59af-4d71-950a-5782c99bb778  
**Date:** 2026-10-08

## Inspected Commits

- **Base:** e158702166ea0b194e08564e268b46417fb86105
- **Previous:** cb907ff74de65d5525ef79c413abef726a905b97
- **Current:** 69fd0ab9927f6312dc7b930745ffa9157383cec6
- **Branch:** swarmforge/phase2b1-identity-20261008/architecture-review/w-ca2ea4f8-8f13-41ef-a9f8-d0d9c5d040a6
- **Status:** HEAD is 69fd0ab, base is ancestor

## Verdict: APPROVED

Phase 2B.1 checkpoint adds real CLI runtime integration, last_seen_at throttling, tenant device list field, and comprehensive identity operations documentation.

## Delta from cb907ff

12 files changed, +367 insertions, -15 deletions.

**Key Changes:**
- `apps/cloud/test/cli-runtime.integration.ts` (new) - Real Bun CLI integration test
- `apps/cloud/src/machines.ts` - Added last_seen_at field to cli_installations table
- `apps/cloud/src/enrollment.ts` - Added last_seen_at update with 5-minute throttling
- `apps/cloud/test/abuse.integration.ts` - Updated to reflect new schema
- `apps/cloud/test/machine-helpers.ts` - Helper updates for new field
- `docs/cloud/IDENTITY.md` (new) - Comprehensive identity operations guide
- `docs/architecture/phase-2b1-api.md` - Updated to document device list field
- Other documentation files updated

## New: CLI Runtime Integration Test

**File:** `apps/cloud/test/cli-runtime.integration.ts`

A complete end-to-end test that:
1. Spawns real Bun CLI against workerd/D1 via HTTP bridge
2. Tests login, status, organizations, tenant switch (use), rotate, and logout
3. Verifies credential file permissions (0600)
4. Confirms credential not leaked in stdout/stderr
5. Tests tenant reauthorization changes installation_id
6. Verifies server-side revocation works
7. Checks last_seen_at is updated on status

This is the first real CLI integration test using the actual CLI entry point.

## New: last_seen_at Throttling

**File:** `apps/cloud/src/enrollment.ts:102-109`
```typescript
if (last_seen == null || Date.now() - last_seen >= 300000) {
  const now = Date.now();
  await env.DB.prepare(
    "UPDATE cli_installations SET last_seen_at=? WHERE installation_id=?"
  ).bind(now, installation_id).run();
}
```

Updates last_seen_at only when 5 minutes have elapsed since the last update, reducing D1 write pressure while maintaining activity tracking.

## New: Device List Field

**File:** `apps/cloud/src/machines.ts:57-62`
```sql
CREATE TABLE cli_installations (
  installation_id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  scopes TEXT NOT NULL,
  last_seen_at INTEGER,
  expires_at INTEGER NOT NULL,
  authorization_expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  FOREIGN KEY(subject_id) REFERENCES users(subject_id)
);
```

Added last_seen_at field tracks when device was last active.

## Security & Correctness

### Credential Leak Prevention

**Test:** `cli-runtime.integration.ts:130-131, 205-207`
- Verifies credential not in stdout/stderr after login
- Checks all CLI outputs don't leak any credentials

### Throttling Correctness

**Test:** `cli-runtime.integration.ts:134-140`
- Verifies last_seen_at is set after status command
- Ensures throttling doesn't prevent legitimate updates

### Permissions Preserved

**Test:** `cli-runtime.integration.ts:129`
- Confirms credential file has 0600 permissions

## Test Results

**Cloud Tests:** 42 pass / 0 fail / 0 skip (increased from 41)

New test: "real Bun CLI pairs with workerd/D1, persists privately, checks status, reauthorizes tenant and revokes server/local credentials"

## Verification Commands

```bash
# Root checks
bun run check  # TypeScript/Biome pass

# Cloud checks
cd apps/cloud
bun run check  # TypeScript/Biome pass
bun run test   # 42 pass, 0 fail
```

## Limitations

1. No live cloud pairing test against real Cloudflare preview/prod
2. CLI throttling uses system time, not server time (acceptable for local)
3. Device list endpoint not separately tested beyond integration

## Compatibility Notes

- Adds new column (last_seen_at) with default NULL - backward compatible
- No schema migration needed for existing installations
- Last_seen_at starts NULL, populated on first status after update
- Documentation clarifies credential storage, revocation, and throttling

## Files Changed

```
apps/cloud/src/enrollment.ts
apps/cloud/src/machines.ts
apps/cloud/test/abuse.integration.ts
apps/cloud/test/cli-runtime.integration.ts
apps/cloud/test/machine-helpers.ts
docs/architecture/cloud-api-contracts.md
docs/architecture/identity-and-trust.md
docs/architecture/phase-2a-api.md
docs/architecture/phase-2b1-api.md
docs/cloud/DEPLOYMENT.md
docs/cloud/IDENTITY.md
apps/cloud/README.md
```

---

**Review completed:** 2026-10-08  
**No P0/P1 findings identified**
