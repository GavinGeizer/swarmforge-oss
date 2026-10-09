# Foundation architecture review: `c90fba0` vs approved `b61f244` (schema frozen) — READ-ONLY

Verdict: **CHANGES_REQUESTED** (1 HIGH, 2 MEDIUM, 2 LOW). No admission worker start on this candidate.
Complementary scope only (C owns auth/security): mutation guards, idempotency, policy/meter interfaces,
operational script correctness, introduced complexity. No admission/dispatch implementation reviewed (none exists).

## Provenance (clean checkout head vs inspected candidate SHA, recorded separately)

- Review checkout (own assigned branch, untouched): `/workspace/repo` HEAD `fec66971536cb117b36c85faabd98883d6491cb2`,
  branch `swarmforge/phase2b2-hosted-20261009/architecture-atomic-admission/w-452f4e44-e8fb-4036-a854-2e66b4ce3dd8`,
  `git status` clean before and after. No product edits, no lockfile changes, no commits.
- Inspected candidate SHA: `c90fba0e57be593833399bdd875c0c13314f5638`
  ("feat(cloud): server-owned entitlement policy and execution-grant authority", parent `b61f244...`),
  on `origin/swarmforge/phase2b2-hosted-20261009/hosted-foundation/w-f1ddeedb-2c4a-4ccd-a81a-c04f9f147c3b`.
  Approved-frozen base `b61f244` = my prior APPROVED schema (corrected DDL + DTOs + 5 schema tests).
  Diff `b61f244..c90fba0`: 7 new files, +1590/−0 (pure addition; frozen DDL/DTOs untouched):
  `src/hosted-authority.ts` (259 lines), `src/hosted-entitlements.ts` (429), `scripts/hosted-policy-local.mjs` (88),
  `test/hosted-helpers.ts` (253), `test/hosted-test-router.ts` (70),
  `test/hosted-authority.integration.ts` (219), `test/hosted-entitlements.integration.ts` (272).
- Executed in isolated scratch archive (`git archive c90fba0 -- apps/cloud`, since removed; scratch-only
  `npm install` — sandbox Bun 1.3.14 cannot parse pinned lockfileVersion-2, so pinned-1.4.2 execution was
  impossible here; run under Node 24 + Miniflare alpha/workerd D1): candidate tests **9/9 pass**
  (4 authority + 5 entitlements), plus targeted probes below. Pinned-1.4.2 re-run still required before freeze.

## HIGH-1: `currentPolicy` latest-version vs `activePolicyGuard` ANY-live-row — capability/version binding gap

- `hosted-entitlements.ts:currentPolicy` returns `ORDER BY version DESC LIMIT 1` (latest, even revoked/expired) for
  denial classification; `activePolicyGuard` checks `EXISTS(any unrevoked in-window row)`. If versions overlap in
  window (normal after `putPolicy`: v1 revoked so no overlap — but operator error, clock skew, or future multi-policy
  writes can leave two live rows), the read path reports `policy_version: <latest>` while a downstream admission batch
  composing `activePolicyGuard` may bind a DIFFERENT (older, still-live) row's version/capabilities. Consequence: the
  admission reply's `policy_version` (from preflight) need not equal the policy row whose capabilities/quotas the
  conditional DML actually enforced — a check-then-write fallback across two policy rows. No test covers overlapping
  live rows.
- Exact lines: `hosted-entitlements.ts` `currentPolicy` (~line 130: `ORDER BY version DESC LIMIT 1`) vs
  `activePolicyGuard` (~line 118: bare `EXISTS`). `entitlementsRoute` binds `policy_version: decision.policy_version`
  from the latest-row decision while counts/capabilities come from mixed sources.
- Repro (real D1 probe): seed v1 (valid 1..99), manually insert v2 live overlapping window (same org, unrevoked,
  valid 1..99): `currentPolicy` → v2; a batch using `activePolicyGuard` + `ORDER BY version DESC LIMIT 1` inside the
  SAME batch would agree — but nothing forces the admission owner to reuse that exact row; the exported guard alone
  does not pin a version. Demonstrated structurally; overlapping-row D1 state is constructible with two `putPolicy`
  calls with clock overlap (valid_for_ms windows always overlap until revoke commits — revoke+insert are atomic in one
  batch, so steady-state overlap is brief, but crash-between-batches is impossible; the real gap is the guard not
  carrying a version).
- Fix (downstream frozen contract): export `activePolicy ByVersion(tenant, version)` guard —
  `... AND e.version=? AND e.revoked_at IS NULL AND valid_from<=? AND valid_until>?` — and require admission to
  (a) read latest inside its OWN batch (`SELECT ... ORDER BY version DESC LIMIT 1` as first batch statement),
  (b) enforce capabilities + ceilings against that same row version. Freeze the guard signature in the admission
  contract; add an overlapping-live-rows test asserting single-version binding. Severity HIGH because it breaks the
  "one atomic batch, one policy version" invariant the whole design rests on.

## MEDIUM-2: `putPolicy` version-MAX preflight races → 503, not logical replay; audit rollback OK

- `putPolicy` reads `SELECT COALESCE(MAX(version),0)` OUTSIDE the batch, then inserts `MAX+1` inside. Two concurrent
  puts both read N, both insert N+1; loser hits `UNIQUE(organization_id, version)` → batch throws → caller gets 503
  `policy_unavailable`. Probe: `PROBE-D preflight MAX read: {"v":0}` confirms the read-outside-batch shape; UNIQUE
  DDL guarantees the collision surfaces as an error, not a silent duplicate. Operator-only path (not user-facing
  admission), so MEDIUM, but the error code is wrong (503 implies outage; should be 409 conflict + retry) and no
  test races two puts. Audit rollback verified: candidate test drops `audit_events` → `putPolicy` rejects, no orphan
  policy row (batch atomicity holds).
- Fix: document operator retry-on-409, or serialize puts per-org (conditional `INSERT ... SELECT MAX+1 WHERE NOT
  EXISTS`); add a concurrent-double-put test asserting exactly one version N+1 + one clean retryable failure.

## MEDIUM-3: planned allowance-reservation CAS signature not present; preflight-only authority risk flagged

- No `reserveAllowance`/`consumeAllowance` function exists in the candidate (only `parse/format/addQuantities` pure
  BigInt helpers + `seedPolicy` writes). The BigInt semantics are correct and bounded (tests: `9007199254740991+1`
  throws; DDL lexical mirror verified in my prior review). But the admission owner has no frozen CAS signature to
  implement against (units: `resource/unit/resource_class` free-text ≤128 chars — readiness OK for `controlled`, but
  no unit registry; `resource_class` allowlist missing). Without a frozen `reserveCAS(tenant, allowance_id,
  expected_reserved, delta)` guard, admission may implement preflight-read + separate write (TOCTOU).
- Fix (downstream frozen export contract, no admission implementation here): freeze in the admission contract —
  `allowanceReserveGuard(tenant, allowance_id, delta)`:
  `UPDATE hosted_allowances SET reserved_quantity = <bigint-add in SQL?> ...` — but SQLite has no BigInt; quantities
  must be compared/added as canonical strings. Recommended: admission batch does
  `UPDATE ... SET reserved_quantity=? WHERE allowance_id=? AND reserved_quantity=? AND <lexical headroom check>` with
  new/expected values computed in BigInt app-side AND revalidated by DDL CHECK on write (DDL rejects overflow even if
  app errs). Export the exact predicate shape now; test concurrent double-reserve (one wins, one 409).

## LOW-4: `hostedGrantLive` mirror gap — `i.authorization_expires_at` and `i.user_id==g.user_id` not rechecked

- `hosted-authority.ts:hostedLiveGrant` rechecks `g.authorization_expires_at>?` but NOT `i.authorization_expires_at>?`
  nor `i.user_id=g.user_id`. Probes on real D1: with grant expiry far-future and installation auth expired
  (`i.authorization_expires_at=2`, CHECK-valid since 2>created_at=1),
  `PROBE-B ... {"n":1}` — the composed guard query still returns the grant as live. `PROBE-C` shows `gu!=iu`
  reachable only via direct DB mutation (app never reassigns `cli_installations.user_id`; rotation/revoke paths bump
  epoch or set revoked — both covered: candidate lifecycle test proves rotation + revocation kill grants, 401).
- Grade: LOW, not a live exploit — reachable only by out-of-band DB writes, and `hostedAuth` + `hostedPrincipalGuard`
  both use the same mirrored predicate (consistent). But defense-in-depth asks for the two conjuncts
  (`AND i.authorization_expires_at>? AND i.user_id=g.user_id`) since they cost one line and close the divergence
  between "installation auth dead" and "grant live". Evidence: probe query above (exact SQL in §6 artifact notes);
  per requirements this is actual-DB-mutation evidence, not hypothetical.
- Also note: `authorize()` issuance batch DOES check `epoch=?` + active installation at insert (good); the gap is
  read/auth-time only.

## LOW-5: operational script + projection mismatches (actual test required, not certified)

- `scripts/hosted-policy-local.mjs`: `d1Databases: ["DB"]` string form (Miniflare accepts, but cf-provisioned UUID
  binding in `cloudflare.config.ts:58-61` uses object form — script targets local `.wrangler/state` so acceptable),
  BUT default `--operator local-operator` violates `audit_events.actor_user_id REFERENCES users(user_id)` FK —
  probe `PROBE-E ... REJECTED: D1_ERROR` (FK fires on real D1). The script's success path was NOT executed here
  (requires local `.wrangler/state` + `SWARMFORGE_LOCAL_OPERATOR=1`); the candidate's `seedPolicy` helper works
  around it by selecting a real member user id. Script needs an `--operator` UUID requirement (fail fast, not FK
  error) + one real operational test (`put` then `revoke` against local state). Do not certify from docstring.
- `entitlementsRoute` JSON projection vs frozen `hostedEntitlementViewSchema` (`hosted-types.ts:78-88`:
  `{policy, allowed, denial, reserved_tasks, reserved_reservations, consumed_quantity}`): the route's local
  `entitlementViewSchema` returns `{..., policy_version, ...}` and DROPS `consumed_quantity`. The frozen schema test
  only checks DTO definitions, not the route projection — so the route diverges from the frozen contract without a
  failing test. Fix: route must return exactly the frozen shape (add `consumed_quantity`, reconcile `policy_version`
  — either amend the frozen schema via lead approval or conform the route; no silent drift).

## Grant-issuance concurrency (demonstrated, graded OK)

- Production batch uses plain `INSERT ... SELECT ... WHERE guard AND EXISTS(installation...)` with
  `UNIQUE(installation_id, session_id, idempotency_key)`; loser batch inserts 0 rows, final SELECT returns winner's
  ciphertext → logical replay, NOT 503. Executed: `Promise.all` 2× same-key → statuses `[201,200]`, same credential,
  1 row (3/3 runs); 6× race → `[201,200,200,200,200,200]`, 1 distinct credential, 1 row, zero 503/409. The lead's
  feared "plain INSERT unique may 503" does NOT materialize because the INSERT is conditional-SELECT shaped, and the
  post-batch `issuanceReplay` covers the lost-race window. Same-key replay test exists in candidate suite. No finding.

## Complexity check

- No introduced complexity beyond the task: 7 additive files, frozen files untouched, no router/index.ts changes
  (test-only router delegates to lead-owned `createWorker`), no new deps, no billing mapping, no admission/dispatch.
  `hosted-test-router.ts`/`hosted-helpers.ts` are test-only and deleted at integration by stated plan. Acceptable.

## Recommended downstream frozen export contract (for admission owner)

```ts
activePolicyByVersion(tenant, version, now): { sql, args } // version-pinned ACTIVE row
allowanceReserveGuard(tenant, allowance_id, expected_reserved, new_reserved): { sql, args } // CAS + DDL CHECK backstop
hostedPrincipalGuard(p, now): existing, PLUS i.authorization_expires_at + user-equality conjuncts
entitlementView: exact frozen hostedEntitlementViewSchema (no policy_version drift)
putPolicy conflict code: 409 (not 503) on UNIQUE(org,version) collision
```

## Sources & repro

Commits/branches via `git rev-parse/log/show/diff` (read-only; worktree clean). Primary D1 FK source from prior
review (always-on enforcement) assumed. Executed: candidate suites 9/9 (Node 24, Miniflare alpha); SQL probes
(`concur_probe.mjs`: PROBE-A same-key UNIQUE fires; PROBE-B `{"n":1}` mirror gap; PROBE-C user drift constructible
only by direct mutation; PROBE-D MAX preflight; PROBE-E `local-operator` FK rejection); HTTP race probes
(`grant_replay_probe.mjs` [201,200] ×3; `grant_race_probe.mjs` 6-way single-credential). Pinned Bun 1.4.2 re-run
outstanding (sandbox Bun 1.3.14 vs lockfileVersion-2). Scratch removed; originals
(`research.md`, `schema-review.md`, `schema-review-corrected.md`) preserved unchanged.

