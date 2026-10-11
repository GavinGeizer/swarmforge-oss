# Cloud failure fixes — implementation report

Worker: `w-209c8ef1-de93-49e2-8a02-17da282327ad`
Task: `diagnose-new-cloud-runner-failures`
Run: `d10168ee-85b5-4573-8423-29bdb1a99cc3`
Scope: ONLY `apps/cloud/test/abuse.integration.ts` and
`apps/cloud/test/hosted-schema.integration.ts` in private `/workspace/phase2b2-ready`.
Production, shared fixtures and config are read-only and untouched.

## Artifacts
- Incremental bundle: `.swarmforge/artifacts/phase2b2-cloud-fixes-c1e696a.bundle`
  - contains `c1e696a29ea5c935c7e8491bb01bd97f61873c19` (HEAD)
  - requires `157433166479c099a54cbee52ca9203dc722eb9f`
  - `git bundle verify`: okay
- Base: `1574331` (tree `bb2ff7fefd568ef07b93223fb42d375af1726b0c`)
- Result commit: `c1e696a` (tree `346112b42acfdab565f1182fc3189f4e50603e78`)
- Branch: `phase2b2-diagnostic-repair`

## Change 1 — failure-audit per-minute cap (`abuse.integration.ts`)

Test-only option preserving strong semantics (no production clock seam, no
client-controlled time, no cap change):

- HTTP case now derives the **exact** `failure-audit` bucket rows by recomputing
  `sign(AUTH_SECRET, "rate:failure-audit:<source>:<minute>")` (fixture secret,
  group, source `127.0.0.1`/`::1`/`unknown`, window derived from `expires_at`),
  and asserts: each bucket `count <= 8`, `sum(counts) == login.failure audits`.
  It no longer assumes one window.
- New deterministic fixed-clock test calls the **production** `budget(ctx,...8)`
  over real D1 with `Date.now` frozen at a minute boundary (restored in `finally`):
  first 8 `true`, 9th `false`; advance one minute, first 8 `true`, 9th `false`;
  the two real D1 rows are exactly `count=8` with the expected window expiries;
  no other rows. This is the exact-8 saturation + boundary regression proof.
- Original coverage kept: 10 public starts, spoofed `x-forwarded-for` cannot
  bypass the link-start budget (429 + retry-after + no extra links), and the
  dropped-table case still denies closed with 503.

Evidence source (read-only): `src/abuse.ts:12-25` (minute key),
`src/index.ts:706-719` (budget 8) — production cap is already correct.

## Change 2 — response body lifetime (`hosted-schema.integration.ts`)

In "clean install and 2B.1 upgrade": consume `reg.json()` immediately after the
`201` status assert, **before** the `0003` migration `prepare().run()` burst. The
later `/v1/workers/me` `200` check remains **after** migrations; every row,
foreign-key and audience assertion is unchanged.

Root cause evidence: an unread Miniflare `dispatchFetch` response left across a
D1 migration burst becomes disturbed (`reg.bodyUsed` flips `false`→`true` with no
read), so the deferred `json()` throws `Body is unusable: Body has already been
read` (undici `body.js:430`). Confirmed on the real test under
`node --max-old-space-size=64` (2/3 fail before, 0/3 after).

## Verification (exact source, pinned toolchain)

- `bun run check` (tsc --noEmit + biome): clean, 70 files.
- Focused `node --experimental-strip-types --test test/abuse.integration.ts
  test/hosted-schema.integration.ts`: 8/8 pass.
- RED repro under `node --max-old-space-size=64 --experimental-strip-types --test
  test/hosted-schema.integration.ts test/abuse.integration.ts`: 8/8 x3 (was 2/3 fail).
- Full cloud `bun run test`: node integration **125/125 pass** (was 124 + new
  deterministic test) and bun SQL `test/*.test.ts` **90 pass / 0 fail**.
- Static: `bun run check` clean.

An earlier full run was interrupted by the harness process-group timeout
(`cancelled 9`, `Promise resolution is still pending`) — a harness artifact, not a
code failure; the clean re-run above is authoritative.

## Boundaries / handoff

- Root `hosted-supervisor.test.ts:799` journal-timeout/order is owned by a
  separate lifecycle worker and was not touched.
- No push, merge, deploy or VM action was performed. `original 45c` untouched.
