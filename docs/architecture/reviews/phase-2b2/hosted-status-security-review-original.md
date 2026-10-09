# Hosted-status security review (READ-ONLY, no product edits)

Verdict: **APPROVED** for exact `a6294161f968a8f75604b9c4bdae4854d8e3a64f` — 4-file status packet only (`hosted-status.ts`, `hosted-status-helper.ts`, `hosted-status-router.ts`, `hosted-status.integration.ts`). Already-approved compat-789/core-2d explicitly out of scope and untouched. Inspected in detached scratch (clean; reviewer probe file is `??` untracked, product tree untouched). Own branch `32b230f` clean attached. Prior reports preserved unchanged.

## Ruling recorded (lead's final settlement-defect ruling)
Every dependent task/reservation/ledger/outbox/audit mutation must be gated by the successful in-batch election witness. Post-batch `meta.changes`/ledger checks followed by 409 do NOT roll back committed writes; compensation alone is insufficient under crashes. The fixed implementation must include the exact forced-interleaving regression (200/completed with ledger 9000/0, raw JSON in `disagreement-cas-raw.json`). This review takes that ruling as given and checks the status packet does not repeat the pattern: status is read-only (zero mutations — verified: no INSERT/UPDATE/DELETE in `hosted-status.ts`), so the ruling constrains it only via the aggregates it reports.

## What passes (evidence, pinned Bun 1.4.2 / Node 24, real workerd/D1)
- Auth: browser (cookie, no auth header) or `sfexec_` via `hostedAuth` only. Suite + probes: no creds 401; `sfcli_` 401; `sfworker_` 401; `sfsuper_`-shaped 401; malformed (`short`, wrong-length, `Basic`, empty) 401; expired grant 401; revoked session 401; revoked installation kills grant 401; cross-org 404 with no leak; other-org policy-absent read is `allowed:false`+denial (never read-denial); unknown query params/empty cursor/bad limits 400; POST/PUT/DELETE 404/405.
- Tenant qualification: EVERY aggregate/paged query binds `organization_id=?` first (17 sites grepped); supervisor join is tenant-qualified on both sides (`s.organization_id` + `w.organization_id`); credential/observed subselects re-filter org+supervisor; no global counts anywhere.
- Pagination/cursor: shared `page(ctx, tenant, "hosted-status")` scope; signed cursor binds subject+scope+purpose+expiry; forged cursor 400; cross-tenant replay 400 (suite); strict query schema (`limit` 1–50 default 20, unknown keys rejected).
- No secret leakage: full-payload scan clean (`sfexec_|sfsuper_|sfcli_|sfworker_|sfenroll_|token_hash|result_ciphertext|…|AUTH_SECRET|provider-secret|provider-token`); supervisor entry exposes only authority label + expiry + observed audit action/at + admin-chain user id; credential rows contribute expiry/revoked-count, never hashes. Suite asserts the same.
- Authority vs observed: labels are exactly `credential_authority ∈ {valid,expired,revoked,absent}` (credential-row derived) vs `last_observed_action/at` (audit derived), with header comments forbidding liveness conflation; suite asserts `valid` + `hosted.claim` observed + admin chain + worker `registered`.
- Failure handling: `scalar()` throws 503 on any DB failure (never catch-to-0); table-drop probe → 500/503 family, never 200-with-zeros; policy outage → read still served? No — `currentPolicy` throws 503 on table outage (fail-closed), while absent/expired/revoked policy yields `allowed:false` + denial with counts still measured. Correct per emergency-read contract.
- Query cost: measured `statements: 18, rows: 15, worst_ms: 28` on a seeded tenant — 18 counted statements, well under the 50-statement budget; global rate/auth overhead is outside this packet (temporary router delegates to the lead worker; NOT certified as global integration — explicitly disclaimed in code and here).

## Observations (P2, non-blocking)
- Shared-cursor fan-out: one `after` cursor advances three task pages + supervisor list together (`nextTask ?? nextSup`); a tenant with >50 supervisors but few tasks may paginate coarsely. Acceptable for operator cleanup; document if pages grow.
- `task_states` record is initialized for all 9 states then overlaid — unknown future states would add a 10th key; strict schema is `record(string→int)` so forward-compatible, but consumers should not assume exactly 9 keys.
- `outbox_attempts` sums attempts client-side over unbounded `queued/claimed` rows; a pathological outbox could widen this read. Bounded by operational reality (outbox drains via claim); consider a cap if outbox grows.
- Session-revocation isolation (my prior probe returned null without isolating why): NOT certified here per dispatch — the account SQL path contains no session predicate by design, and this packet adds no session logic. Lead will require an isolated test; no claim made.

## Commands (actual)
- `bun install --frozen-lockfile` (54 pkgs); `bun run check` (47 files pass).
- `node --experimental-strip-types --test test/hosted-status.integration.ts` → **3 pass / 0 fail**.
- Reviewer adversarial probe (auth matrix, forged/cross cursors, strict query, methods, secret scan, cost, expired grant, malformed bearers) → all expected codes, payload clean, cost 18/15/28ms.
- `git status` clean both checkouts (scratch has only the untracked probe file); no product edits/commits; lockfiles unchanged.

## Decision
**APPROVED** for `a6294161f968a8f75604b9c4bdae4854d8e3a64f`. Final integrated review (global router wiring, rate/CORS, admission/dispatch enablement) remains later and is not certified by this packet review.

