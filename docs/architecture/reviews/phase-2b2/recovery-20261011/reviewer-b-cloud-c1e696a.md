# Reviewer B — Cloud Test-Fix Contribution Review: `1574331..c1e696a29ea5c935c7e8491bb01bd97f61873c19`

**Verdict: APPROVED.** Test-only robustness fixes; no assertion weakening, no
production/fixture/config change, and no false production claims. Not an overall
phase approval — the final combined review follows.

## Provenance (verified, read-only, no source edit/push/merge/deploy)

- `/tmp/cloud-fixes.bundle` SHA256
  `f5134269c8b385d747872b97b96f89972dc5f7fdfe90de5f96f235e7525b5968`, 9578B —
  MATCHES; fetched `refs/private/cloud-fixes` =
  `c1e696a29ea5c935c7e8491bb01bd97f61873c19` (tree
  `346112b42acfdab565f1182fc3189f4e50603e78`, requires `1574331`). `git fsck`
  clean. Isolated detached worktree at exact `c1e696a`.
- `git diff 1574331..c1e696a --stat`: **only** `apps/cloud/test/abuse.integration.ts`
  (+113) and `apps/cloud/test/hosted-schema.integration.ts` (+5/-3). No
  production, fixture, or config change. Original branch `/workspace/repo`
  unchanged at `45c29d3`.

## Executed evidence

- Focused `abuse.integration.ts` + `hosted-schema.integration.ts`:
  **8 pass / 0 fail**, repeated **5x** identically (author's "identical
  diagnostic 8/8").
- Memory-capped focused run (`NODE_OPTIONS=--max-old-space-size=64`):
  **8 pass / 0 fail**.
- Full integration suite `node --experimental-strip-types --test
  test/*.integration.ts`: **125 pass / 0 fail** on two consecutive runs
  (`125/125`, matching the author). One earlier run reported 1 fail; see
  Warning below.
- `bun run test:sql`: **90 pass / 0 fail** (matches author).

## Clock-boundary audit fix (`abuse.integration.ts`) — correct, not weakened

- Production `src/abuse.ts:6-26`: `minute=floor(now/60000)`,
  `bucket=sign(secret,"rate:${group}:${source}:${minute}")`,
  `expires_at=(minute+2)*60000`, and the counter only advances via
  `ON CONFLICT DO UPDATE … WHERE count<limit RETURNING count` — so the (limit+1)th
  call inserts no row and returns false without exceeding `limit`.
- Production handler `src/index.ts:705-719` writes the `login.failure` audit
  **only** when `budget(ctx,"failure-audit",8, ctx.actor ?? undefined)` is true.
- The new `failureAuditRows` helper (`:15-36`) re-derives the exact HMAC bucket
  identity (`minute=floor(expires_at/60000)-2`, sources `127.0.0.1|::1|unknown`)
  and matches **only** `failure-audit` buckets — no unrelated rate-limit bucket
  is compared, and an unmatched bucket would surface as `length==0` failure, not
  a silent pass.
- The HTTP test (`:57-88`) replaces the flaky single-window
  `assert.equal(audits.n, 8)` with a stronger per-window invariant:
  `1<=windows<=4`, `Σ bucket.count === audits`, each `1<=count<=8`,
  `audits>=1`. This still proves the handler cap end-to-end (an uncapped window
  would show `count>8`; an audit written without a budget grant would break
  `Σcount===audits`) and removes the wall-clock straddle flake.
- The deterministic test (`:103-...`) freezes only the test `Date.now` at a
  minute boundary and drives the real production `budget` over real workerd D1:
  exactly 8 `true` then `false` in each of two consecutive minutes, then asserts
  the two exact bucket rows `[8,8]` with `expires_at=[(m+2)*60000,(m+3)*60000]`
  and total rows `2`; clock restored in `finally`. This is meaningful exact-8
  saturation coverage under a controlled clock — not manufactured green.

### Non-blocking observation (window bound)
The `1..4` window bound is a tolerant sanity heuristic, not derived from the 20
attempts. It does not weaken the cap proof (the exact per-bucket cap and
`Σcount===audits` invariants hold regardless of window count, and exact-8 is
proven deterministically). A user-agent cannot influence it beyond the number of
minute boundaries the local test crosses. Acceptable as-is; deriving it from the
observed bucket set would be marginally more principled.

## hosted-schema body-lifetime fix — correct, assertions unchanged

- `hosted-schema.integration.ts`: `const worker = await reg.json()` moved to
  immediately after the `201` (`:800-803`) and removed from after the D1 burst
  (`:850`). This avoids Miniflare/undici "Body is unusable" when a dispatchFetch
  response is left unread across many `prepare().run()` calls. All
  post-migration identity/FK/row assertions are byte-identical; only the read
  position changed.

## Findings

None blocking. No weakened assertions, no false production claim, no test
configuration/timeout/doc change.

## Warning (reported honestly)

One of the four full-suite runs reported a single failure whose identity was not
captured before a clean rerun; the next two runs were 125/125 and the focused
set passed 8/8 five times (including under a 64 MB heap). I could not reproduce
the flake or attribute it to either changed file, so this is recorded as
observed, unconfirmed full-suite flakiness — not a defect of this contribution.

## Statement

Range `1574331..c1e696a29ea5c935c7e8491bb01bd97f61873c19`: **APPROVED**.
Test-only robustness fixes validated by focused 8/8 (5x), memory-capped 8/8,
full 125/125 (two clean runs) and SQL 90/90; the exact-8 cap is proven
deterministically and the HTTP invariant is exact. Overall Phase 2B.2 A/B/C
acceptance remains INCOMPLETE pending the final combined review.
