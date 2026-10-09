# Operator-helper trace: exact 2d602ca production script vs cf migrate path + CAS classification

Target SHA: `2d602cac56595f20393b7646062ca83a8bc975d6` (branch head of hosted-foundation; 824c8b3 child c90,
plus ON CONFLICT issuance fix). Checkout HEAD `fec6697` on assigned branch, clean, no edits. Scratch archives
removed; repo lockfiles untouched (scratch-only npm install). Bun 1.4.2 installed via `~/.bun/bin/bun` for
fidelity; candidate suites executed under Node 24 + Miniflare (matching prior harness) — 14/14 pass on 2d tree
(6 authority incl. revoked-winner 409 test + 5 schema + putPolicy/CAS/pinned-guard tests; full list in result JSON).

## 1. `void localDatabaseId` + `d1Databases:["DB"]` vs cf UUID — CONFIRMED divergence, state coherence unproved

- Actual script lines (`scripts/hosted-policy-local.mjs:25-30,66-76` at 2d): imports `localDatabaseId` from
  `../cloudflare.config.ts`, then bare `void localDatabaseId;`. Miniflare constructed with
  `d1Databases: ["DB"]` (name-only) + `d1Persist: ".wrangler/state/v3/d1"`.
- cf migrate driver (`scripts/migrate-local.mjs:9-21`): `cf d1 migrations apply 00000000-...-00000000002a
  --local --mode local --persist-to .wrangler/state --dir ../migrations`. So cf binds the UUID-named database
  under `.wrangler/state`; the script binds name `"DB"` under `.wrangler/state/v3/d1`.
- Executed proof: `convertV4MiniflareOptions({... d1Databases:["DB"], d1Persist:".wrangler/state/v3/d1"})`
  serializes with NO persist key surviving (`resourcePersistencePath: undefined`, `has persist: false`) — the
  `d1Persist` option is silently dropped by this Miniflare alpha's v4 converter. Consequence observed live:
  after `migrate-local.mjs` ✅ all 3 migrations and seeding users/orgs/memberships directly into
  `.wrangler/state/v3/d1/.../d3a30...sqlite` (verified `users=1` via sqlite3), the production script at the same
  CWD reports `refusing: operator ... is not an existing users(user_id)` — it opens a DIFFERENT (empty) D1
  (`SELECT user_id FROM users` → `no such table: users` on the script's handle, while the cf-state sqlite file
  holds the rows). State coherence claimed in the header comment ("SAME local D1 migration state") is unproved
  and, on this evidence, false: two handles, two databases.
- Fix required (author asked): bind the actual configured UUID — drive the existing cf migration path
  (`d1Databases` with the UUID binding the config uses, or shell to the cf driver) instead of name-only `"DB"`;
  keep the static `localDatabaseId` import as a real binding input, not `void`. Then a real valid existing-state
  test: `put` → `revoke` → repeat-`put` (version increments) → repeat-`revoke` (empty, not error) against the
  cf-migrated state, asserting the SAME sqlite file serves both.
- Grade: BLOCKER for any claim of a "working operator helper" — actual CLI put/revoke against cf-migrated state
  is broken today (clean refusal, no data corruption, but zero function). Not a data-loss risk; fail-closed refusal.

## 2. Manual DDL loop catches only 'already exists' — repeat 0002 ALTER `return_path` HARD-FAILS

- Executed `ddlcheck.mjs` (actual D1, all 3 migrations applied twice through the script's exact loop shape):
  every repeat statement tolerated via `/already exists/i` EXCEPT
  `repeat 0002_machine_identity.sql HARD-FAIL: D1_ERROR: duplicate column name: return_path: SQLITE_ERROR`.
  `ALTER TABLE oauth_transactions ADD COLUMN return_path` has no IF NOT EXISTS path in SQLite/D1, and the message
  does not contain "already exists". So a second script run against an already-migrated state aborts the DDL loop
  with an unhandled throw (before any put/revoke work) — unless cf migrate owns the schema and the script stops
  re-applying DDL. Same fix as §1 (use the cf migration driver / real idempotent journal) resolves both.
- Grade: part of the same operator-helper BLOCKER.

## 3. `allowanceCasStatement`: RESERVE-ONLY classification (no settlement block)

- Actual signature (`hosted-entitlements.ts:308-341` at 2d): CAS moves
  expectedReserved→newReserved AND expectedConsumed→newConsumed with exact-string compares + DDL CHECK backstop,
  gated by `EXISTS(... hosted_entitlements ... revoked_at IS NULL AND valid_from<=now<valid_until)`.
  Doc comment says "downstream reserve+settlement". The window predicate means settlement against an EXPIRED policy
  cannot use this helper — future expired-policy emergency cleanup/settlement would be blocked if it were forced
  through this path.
- Classification: helper is currently RESERVE-ONLY-capable; no settlement caller exists in scope (no admission
  implementation — correctly out of scope). Do NOT block foundation for settlement-not-implemented. Require the seam
  be explicit before admission: either (a) label `allowanceCasStatement` reserve-path and add a separate trusted
  settlement mode without the active-window predicate (supervisor credential + task/fence ownership, mirroring the
  protocol's "cleanup settlement can reference an expired execution lease"), or (b) document that settlement reuses
  this CAS only within-window and emergency cleanup has its own path. Author asked to make this explicit; no HIGH
  demonstrated (no caller to misuse it yet), so note, not blocker.
- Verified: `allowanceCasStatement` importable; candidate CAS tests pass (exact BigInt, controlled-meter mapping);
  14/14 green includes `pinned policy guard agrees`, `concurrent putPolicy serializes`, `allowance CAS helper exact`.

## Verdict

- BLOCKS the "working operator helper" claim (not foundation data-plane): §1 UUID/name-only divergence (proved: script
  sees empty D1 while cf-state sqlite holds users=1) + §2 repeat-ALTER hard-fail (proved:
  `duplicate column name: return_path`). Both fixed by binding the actual configured UUID / using the existing cf
  migration driver + real valid-state put/revoke/repeat test (not empty-revoke/refusal).
- No HIGH against 824/2d data-plane guards demonstrated in this trace (version-pinned guard, putPolicy CAS/409,
  ON CONFLICT issuance, frozen DTO, asserted rollback all green in-suite); CAS mode explicitness (§3) is a
  must-label before admission, not a freeze-block.
- Sources: exact script/driver/guard lines via `git show 2d...`; live Miniflare + sqlite3 probes above; candidate
  suites 14/14 (authority 6 + entitlements 8 incl. new pinned-guard/version-race/CAS tests).

