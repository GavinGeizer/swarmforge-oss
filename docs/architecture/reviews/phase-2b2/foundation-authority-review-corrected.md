# Corrected re-review: hosted foundation policy + execution-grant authority

Verdict: **APPROVED** for exact inspected SHA `2d602cac56595f20393b7646062ca83a8bc975d6` (latest descendant; fixes forced issuance via ON CONFLICT replay). Both prior blocking findings are resolved with evidence. No product code authored by reviewer; no source edits/commits/lockfile changes.

- Scope: `c90fba0` → `824c8b3` (A/C review fixes) → `2d602ca` (issuance race-loser fix). Inspected `2d602ca` in detached scratch worktree (clean). "3338" from dispatch does not resolve to any object (`fatal: ambiguous argument`) — no such commit exists locally or on the fetched branch; `2d602ca` is the current latest descendant and is recorded as the exact inspected SHA.
- Reviewer checkout: clean baseline `fec6697` on attached assigned branch. Remote HEAD of the assigned branch is `32b230f` (prior portability recheck); per dispatch ("do not force-rewind published branch") the local checkout was NOT moved to `32b230f` — it stays at the `fec` base marker, which is the recorded ACTUAL base. The `32b230f`-vs-`fec` divergence is the accepted client-commit checkout and does not remove independence (reviewer authored no product code in any run).
- Prior `c5af` report (`foundation-authority-review.md`, CHANGES_REQUESTED on `c90fba0`) preserved unchanged.
- Tooling: pinned Bun 1.4.2, Node 24.21.0; manifests pin `bun@1.4.2`. Cloud frozen install (54 pkgs), `bun run check` 41 files pass.

## P0 (prior) → RESOLVED: frozen entitlement DTO
- Route now parses and returns the frozen `hostedEntitlementViewSchema` directly (`hosted-entitlements.ts`: import swapped, local divergent schema deleted, `consumed_quantity` populated from new `controlledConsumption()` over the fixed `compute_ms/millisecond/controlled` meter, no `policy_version` key).
- Evidence: live route output parsed with the frozen schema → `frozen-DTO-parse: OK`; keys exactly `{allowed,consumed_quantity,denial,policy,reserved_reservations,reserved_tasks}`. Candidate test asserts `consumed_quantity: null` (no allowance) and `"0"` (seeded allowance). Contract match verified, not inferred.

## P1 (prior) → RESOLVED: newest-version guard/decision agreement
- `activePolicyGuard(tenant, expected)` is now pinned: `version=?` + required-capability predicates + in-window + unrevoked + `version=(SELECT MAX(version)…)` (`hosted-entitlements.ts`). An EXISTS-ANY-live guard is explicitly rejected in comments. `putPolicy` revocation predicate narrowed to unrevoked in-window rows + bounded CAS retry with clean 409 on concurrent version conflict (no 503).
- Evidence: candidate test "pinned policy guard agrees with decision" asserts stale-v1 fails, missing-capability fails, revoke-between-decision-and-mutation fails, decision reports `policy_revoked`. Reviewer probe: revoked-newest → `allowed:false policy_revoked`. Guard and decision agree on every denial path.

## Bounded D1 security scope (new probes, all passing)
- Underlying installation window: `hostedLiveGrant` now pins `g.user_id=i.user_id` AND `g.authorization_expires_at=i.authorization_expires_at` (live equality, not just expiry); issuance batch rechecks `authorization_expires_at` inside the mutation. Probe: mutating the installation window → grant use goes 200→401. Grant/principal guards bind `user_id`+`installation_id`.
- Exact-grant retry revocation: same-key replay returns identical credential (200); issuance carries ON CONFLICT DO NOTHING on the grant key so a racing loser replays the winner instead of 500/503; revoked winners are re-authorized to a clean 409 with one row and no phantom audit (candidate test fails RED on old code per message, passes GREEN here). Probe: replay-same-key 200.
- Owner/separation: mixed cookie+bearer on the authorize path → 401 (`authentication()` rejects Authorization headers); wrong-org grant read → 404; `sfcli_`/`sfworker_` on hosted paths → 401 (candidate tests).
- Rollback, no swallowed rows: audit-drop → `putPolicy` throws; candidate version-race/concurrent-put tests assert version serialization + audit counts; reviewer probe confirmed throw (count query shape preserved, no silent success).
- Local operator practical execution: usage gate ok; non-UUID refused; missing `SWARMFORGE_LOCAL_OPERATOR=1` refused; `--preview` refused (local-D1-only preserved); unknown operator fails fast with clear message (FK-safe); `--operator` now required (existing-user UUID); `convertV4MiniflareOptions` wrap + local D1 state path + shared `localDatabaseId` import (config-honest seam). Prior P2 (script unrunnable) fixed.
- Full candidate slice: **14 pass / 0 fail** on real workerd/D1 (6 authority + 8 entitlements, incl. concurrent same-key issuance, revoked-winner race, guard agreement, concurrent putPolicy, allowance CAS/meter mapping).
- Test-router remains a temporary fixture wrapper (delegates to lead-owned worker); no public CORS/rate/index certification claimed or given.

## Residual P2 (non-blocking)
- `controlledConsumption` returns null when no controlled-meter allowance exists (concurrency caps govern) — semantics are documented; admission must treat null as "no meter," never zero-allowance.
- `issuanceReplay` fingerprint column still write-only (noted previously); replay identity is (tenant, installation, session, key) + live-grant re-auth — acceptable, column could be compared or dropped later.
- Three final integrated reviews are still required before any admission/dispatch enablement; this covers the authority/policy slice only.

