# A. Grant-race adjudication (corrects foundation-architecture-review.md §"Grant-issuance concurrency")

Prior inference (WITHDRAWN as a universality claim): "loser batch inserts 0 rows, final SELECT returns winner's
ciphertext → logical replay, NOT 503." Status: the concurrent-HTTP evidence ([201,200] ×3 runs, 6-way single
credential, zero 503/409) is VALID executive evidence of the common path and is retained. The universality inference
("does NOT materialize") is WITHDRAWN: it assumed `INSERT...SELECT...WHERE` guards degrade to 0-row inserts on
UNIQUE clash. They do not — a UNIQUE violation aborts the whole D1 batch, and the loser's audit + final SELECT never
execute.

Lead's proof (accepted): EXACT c90 production `hostedAuthorityRoute`, Bun 1.4.2, real SQLite (explicitly NOT D1),
all 3 migrations + `foreign_keys=ON`, instrumented `first()` timing barrier forcing TWO empty `issuanceReplay`
reads before both batches → outcomes `201 + rejected-UNIQUE`, 1 grant row, no quota overshoot, generic index error
would 503. Lead-only probe `/tmp/phase2b2-grant-race-probe/probe.ts` not reproduced verbatim (lead-only path).

Independent reproduction on real workerd D1 (this review, fault-timing analogue, no fake quota algorithms):
replicated the EXACT production batch shape (`INSERT INTO hosted_execution_grants SELECT ... WHERE browserGuard +
EXISTS(installation epoch)` + conditional audit + final SELECT) twice with the SAME idempotency key and DIFFERENT
grant_ids (production randomizes per attempt), both replay pre-reads forced empty first (barrier analogue), against
actual D1 via `getD1Database` handle. Result: `batch1 ok rows=1`; `batch2 REJECTED [UNIQUE constraint failed]`;
`grant rows: 1`. The loser's final SELECT never runs (batch atomicity), so no logical replay occurs on this
interleaving — the caller would receive the generic UNIQUE failure (503 envelope in production mapping), not a 200
replay. Matches the lead's SQLite outcome on D1 semantics. (Note: profile-local D1 listeners hit EPERM in this
sandbox, so no claim is made about the lead's SQLite probe running as D1; the D1-side reproduction above is the
workerd-handle evidence. Prior `bun:sqlite` display-rounded CAST language from the earlier review is not repeated —
quantity findings there rest on TEXT typeof/quote probes.)

Author tasking (endorsed): proper `ON CONFLICT`/reselect conditional handling if reproduced — now reproduced on both
engines. Recommended: `INSERT ... ON CONFLICT(installation_id,session_id,idempotency_key) DO NOTHING` + final SELECT
returns winner (0-row insert, no abort), or catch-UNIQUE → reselect-and-replay; map residual conflict to 409, never
generic 503. No quota overshoot in any outcome (1 row both paths).

# B. Adversarial test review: `bbad371` vs `7300825` (worker-client-storage branch) — scoped, READ-ONLY

Target archive: `bbad371bc6113314d8191d02b24e45a58b77f479`
("test: assert desired hosted admission protocol so unwired routes fail RED", parent `7300825...`),
on `origin/swarmforge/phase2b2-hosted-20261009/worker-client-storage/w-c32682ab-d72d-4b25-8179-0fef4e95eb4e`.
3 files, +454/−242: `test/hosted-adversarial.integration.ts` (323→~560 lines, 9 tests),
`test/hosted-e2e.integration.ts` (55→~100, 1 test), `test/hosted-load.integration.ts` (70→~175, 1 test).
Prior green-404 scaffolds REJECTED per dispatch (preserved as `test-report-rejected-7300825.md` + tag); the corrected
candidate asserts desired 202/409/403/400/401 (+1 legitimate 404 cross-org containment) and is genuinely RED 10/11
against the unwired DEFAULT production Worker. Executed in isolated scratch (removed; Node 24 Miniflare, repo
untouched): **10 fail / 1 pass** — the single pass is the cross-org 404 containment test, which is behaviorally
correct both before and after wiring (membership convention) and is NOT a green-404 scaffold repeat.

Per-test validation (all read `POST /v1/tenants/{t}/tasks` on the DEFAULT worker via `machine-helpers.fixture()`):
1. valid admit → expects 202 + `admissionReplySchema.parse` + 1 task/reservation(active)/outbox(queued); RED (404).
   Strict DTO parse on the winner path; `reservation_id === task.reservation_id` binding asserted. Reachable: yes,
   mirrors frozen `taskSubmitSchema` body. No hidden asserts.
2. idempotent replay/conflict → same-key same-body identical 202 + same deep-equal reply, 1 row each; same-key
   changed-body 409 + zero new rows. RED (404). Correct winner/conflict semantics; `deepEqual` on full reply is
   appropriately strict (catches nondeterministic re-issue).
3. one-worker six-racer → EXACTLY 1×202 + 5×409, 1 row each, winners DTO-parsed. RED (six 404s). Exact-winner
   assertion is the right concurrency shape for worker-exclusive DDL (partial unique now frozen).
4. three-worker two-ceiling six-racer → EXACTLY 2×202 + 4×409, distinct task_ids, 2 rows each. RED. Correct
   quota-ceiling shape; distinct-`task_id` set assertion prevents double-counting one task twice.
5. absent/expired/revoked → 403 + `{error.code: string}` envelope each, 0 rows. RED (404). Statuses only (exact
   backend code deliberately unpinned — correct, codes belong to backend contract).
6. malformed (shell class, duration>runtime, runtime>1h, extra field, bad UUID) → 400 each, 0 rows. RED (404).
   Matches frozen Zod bounds including `maxTaskRuntimeMs`; `extra:1` pins strict mode.
7. audience (none/worker-CLI/sfcli_) → 401 each, 0 rows. RED (404). Correct per prior scope-separation review.
8. cross-org → 404 + 0 rows. GREEN (passes unwired AND must pass wired) — legitimate containment invariant, keep.
9. supervisor claim/renew/settle without supervisor cred → 401 each. RED (404). Correct audience separation.
10. E2E: tenant 200 (wired, stays green) + entitlements 200 + admission 202 + DTO parse. RED at entitlements (404).
11. Load: 6-burst vs 2-ceiling → 2×202 + 4×409, zero partials, REAL count queries (prior `catch=>0` swallow removed;
    missing table now FAILS). RED. Burst sized to ceiling (not 24-firehose); no fabricated rows_read/meta. Correct.

Fixture note: `machine-helpers.fixture()` applies 0001+0002 only; each file manually applies 0003 in `setup`
(`statements("../migrations/0003_hosted_execution.sql")`). Annotate: once the backend integrates, a compat fixture
defaulting 003 (or a shared `hostedFixture`) is needed — until then the manual apply is correct for RED-against-
unwired semantics (proves the 404s come from missing routes, not missing tables). `count()` helper fails on missing
table (no swallow) — verified by grep (only `try` occurrences are per-test `finally` disposals + the documented
comment). No `catch=>0`, no fabricated D1 meta, no secrets printed (synthetic GitHub provider only).

Verdict on tests: **APPROVE test assertions as the RED acceptance contract (10 RED + 1 containment-green is the
desired state); tests remain RED pending backend — this is NOT acceptance-green.** The reviewer may approve the
assertions while the suite stays red. No weakening permitted: a future implementation must produce the codes/bodies/
row counts, not edit the expectations. E2E/load scaffolds correctly defer the Bun-supervisor bridge to the joint
stage.

Sources: `git rev-parse/log/show/diff` for both commits (read-only); test text via `git show bbad371:...`;
executed 11 tests in scratch (10 fail/1 pass with `actual:404 vs expected:202/403/400/401` assertion diffs);
forced-interleave D1 repro (`forced2.mjs`: batch2 `UNIQUE constraint failed`, 1 row). Scratch removed; checkout HEAD
`fec6697` on assigned branch, clean. Originals (`research.md`, `schema-review.md`, `schema-review-corrected.md`,
`foundation-architecture-review.md`) preserved unchanged. No product edits. No full unrelated suite repetition.

