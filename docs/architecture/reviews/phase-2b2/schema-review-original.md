# Schema review: candidate `7fc8c53` vs base `64518ae` — INDEPENDENT, READ-ONLY

Verdict: **CHANGES_REQUESTED** (1 HIGH, 3 MEDIUM, 1 LOW). No freeze. No dispatcher build on this checkpoint.

## Addendum (lead primary-source clarification — FK behavior CORRECTED with executable proof)

Lead-supplied primary source [D1 foreign keys](https://developers.cloudflare.com/d1/sql-api/foreign-keys/) (fetched
2026-10-09, "Last updated Apr 21, 2026"): "By default, D1 enforces that foreign key constraints are valid within all
queries and migrations. This is identical to ... `PRAGMA foreign_keys = on` ... for every transaction" and "user
queries cannot change this during a query or migration" (implicit transaction); only `PRAGMA defer_foreign_keys`
temporarily defers. Prior draft LOW-5 is superseded by this correction: the candidate author's "D1/Miniflare does not
enforce FKs" comment is factually wrong for real D1, and the weakened declaration-only test must be restored to a
rejection assertion.

Executable proof on the candidate tree (isolated scratch copy at `/workspace/.swarmforge/scratch`, since removed;
repo untouched — `git status` clean, HEAD `fec6697`, install via `npm install` into scratch only because sandbox Bun
1.3.14 cannot parse the pinned lockfileVersion-2 `bun.lock`; no repo lockfile touched):
- `node --experimental-strip-types --test test/hosted-schema.integration.ts` → **3 pass / 0 fail** (all candidate tests green in Miniflare alpha).
- Dual-handle FK probes against real workerd/Miniflare D1 (`getD1Database` handle, same as fixture): orphan
  `hosted_tasks` INSERT (direct `.run()` AND `.batch()`) → **REJECTED** `D1_ERROR: FOREIGN KEY constraint failed:
  SQLITE_CONSTRAINT_FOREIGNKEY`; `SELECT * FROM pragma_foreign_keys` → `{"foreign_keys":1}`. Same rejection through
  the bundled-worker path shape. Orphan CANNOT exist on this handle — no helper gap found on the direct-helper path.
- Isolated CHECK probe (valid task FK, quantity `12x`): **ACCEPTED** on workerd D1 — confirms HIGH-1 is a live DDL bug,
  not a fixture artifact (the FK rejection in the mixed probe had masked it; isolating the predicates separates them).
  The candidate's own `"1.5"`-rejection assertion passes only because its reservation rows also carry random
  (nonexistent) `task_id`s → FK fires first. A `12x`/`1.5` quantity on a valid task passes both layers.
- Lifecycle insufficiency (lead direction) stands as MEDIUM-4 and should be added via author before freeze:
  `hosted_reservations` needs `worker_id` + consumed-quantity/runtime landing + allowance binding; `hosted_tasks`
  needs authorizer refs (`authorizing_user_id`/`execution_grant_id`) so dispatch/claim/settle can recheck authority
  in SQL like `enrollment.ts:199`. Unchanged by this addendum, still required.

## Provenance (verified, attached HEAD, repo untouched)

- Review checkout: `/workspace/repo` HEAD `fec66971536cb117b36c85faabd98883d6491cb2`, branch
  `swarmforge/phase2b2-hosted-20261009/architecture-atomic-admission/w-452f4e44-e8fb-4036-a854-2e66b4ce3dd8`, `git status` clean before and after. No repo edits; no lockfile changes.
- Base `64518ae` ("docs: define hosted authority and durable dispatch interfaces", parent `cd3f5b9`):
  `docs/architecture/phase-2b2-protocol.md` + 2 review docs. No SQL. Normative contract: exact `sfexec_`/`sfsuper_` audiences/scopes, `controlled`-only tasks, conditional admission batch, fenced CAS claim, lease/settlement/stop semantics, no loose GLOB/counters/plan-names.
- Candidate `7fc8c53` ("feat(cloud): add Phase 2B.2 hosted execution schema checkpoint", parent = `64518ae`,
  merge-base confirms direct child): adds `apps/cloud/migrations/0003_hosted_execution.sql` (217 lines, 10 tables),
  `apps/cloud/src/hosted-types.ts` (379 lines, frozen DTOs), `apps/cloud/test/hosted-schema.integration.ts` (505 lines).
  No router wiring (author-stated). Found on `origin/swarmforge/phase2b2-hosted-20261009/hosted-foundation/w-f1ddeedb-2c4a-4ccd-a81a-c04f9f147c3b`
  and `origin/swarmforge/phase2b2-contract-20261009`.
- Prior research preserved: `/workspace/.swarmforge/artifacts/research.md` + `report.md` unmodified by this review.

## Executable evidence (real queries, not schema reading)

Primary source for FK semantics: [D1 foreign keys](https://developers.cloudflare.com/d1/sql-api/foreign-keys/) — D1
enforces FKs on every query/migration (≡ `PRAGMA foreign_keys=ON`); user queries cannot toggle it inside the implicit
transaction. See Addendum above for the workerd-executed proof (orphan REJECTED on both direct and batch handles;
`pragma_foreign_keys` = 1). The old "fixture pragma-off" hypothesis is withdrawn — Miniflare alpha here enforces FKs,
and any `getD1Database`-helper path that allowed orphans would be a helper gap, not D1 behavior; none was found.

Environment note: repo Bun is 1.3.14 while `apps/cloud` pins `packageManager bun@1.4.2` and its `bun.lock` is
lockfileVersion 2 → `bun install --frozen-lockfile` refuses in the sandbox (`Unknown lockfile version`; would need a
toolchain change, out of scope for a read-only review). Full Miniflare/D1 workerd suite therefore NOT run here — and
is not claimed. Instead, every load-bearing SQL predicate was executed with real SQLite semantics via `bun:sqlite`
(`PRAGMA foreign_keys=ON`), which is the same engine family Miniflare's D1 emulates locally. Scripts kept outside repo
(`/tmp/glob_probe.ts`, `/tmp/dup_probe.ts`, `/tmp/authz_probe.ts`); repo clean.

### HIGH-1 (lead concern CONFIRMED): quantity CHECK is loose — `GLOB '[0-9]*'` accepts `12x`, `1.5`

Executed `SELECT ? GLOB '[0-9]*'` over 10 inputs. Results: `"12"→1, "12x"→1, "1.5"→1, "01"→1, "19×9"→1, "20×9"→1`
(`*` = any tail, so any leading-digit string matches). Full migration predicate
`q GLOB '[0-9]*' AND length BETWEEN 1 AND 19 AND (q='0' OR substr(q,1,1)!='0')` executed as a real CHECK:
**ACCEPT: `"0","12","12x","1.5","9999999999999999999"`; REJECT: `"01","20×9",""`**.
So `12x`/`1.5` enter `hosted_allowances.allowed_quantity` / `hosted_reservations.quantity` at the DDL layer today.
The candidate's own test only tries `"", "-1", "01", "1.5", "x", "9"×20` — wait, it DOES include `"1.5"` and expects
rejection (`assert.rejects`). Under real SQLite `GLOB '[0-9]*'`, `"1.5"` MATCHES (verified above: `1.5→1`), so that
assertion would FAIL against a real engine unless the fixture's D1 path behaves differently — meaning either the test
never ran green against real D1, or something else rejects it. Either way the DDL predicate is wrong; the Zod layer
(`hostedQuantitySchema` `/^(0|[1-9][0-9]{0,18})$/`) is correct and must be mirrored in SQL.
Fix: `CHECK(quantity GLOB '[0-9]*' AND quantity NOT GLOB '*[^0-9]*' AND ...)` (or `GLOB '[0-9]'`-per-char formulation).
Severity HIGH because quantities feed allowance arithmetic; `12x` reaching `CAST(... AS INTEGER)` is silent truncation
risk (SQLite CAST stops at first non-digit).

### MEDIUM-2 (lead concern CONFIRMED): ≤19-digit quantities exceed safe-int / SQLite casts

Executed: JS `9999999999999999999` is already `10000000000000000000` (unsafe, `Number.isSafeInteger→false`);
SQLite `CAST('9999999999999999999' AS INTEGER)` → `9223372036854776000` (clamped/rounded, **not** the input value);
`CAST('9007199254740993')` (2^53+1) → `9007199254740992` (off-by-one). So any app code doing `Number(q)` or SQL-side
`CAST`/sums on 19-digit strings silently corrupts accounting. Zod `z.number().int()` for `runtime_ms`/`consumed_runtime_ms`
is separately fine (JSON safe-int), but the TEXT-quantity path has no exact-arithmetic enforcement.
Fix: cap quantities at 15–16 digits (`{0,15}` → max `999999999999999`) OR mandate string-only exact arithmetic
(BigInt/decimal lib) with a test asserting `2^53+1` round-trips exactly; add CHECK length ≤16 as interim.
Also `consumed_runtime_ms: z.number().int().min(0)` (settlement) should be `.max(Number.MAX_SAFE_INTEGER)` or bounded by
`runtime_ms`.

### MEDIUM-3 (lead concern CONFIRMED): nullable `max_task_runtime` permits unbounded runtime

DDL: `max_task_runtime INTEGER CHECK(... NULL OR ... > 0)` — NULL allowed. Protocol (`phase-2b2-protocol.md`) demands
"bounded integer runtime_ms" and "deadline absolute, never extends"; DTO `taskSubmitSchema` requires positive
`runtime_ms`, but nothing binds it to a finite policy ceiling when the policy row is NULL. A NULL policy + large
`runtime_ms` = unbounded hosted execution admitted. Fix: either `NOT NULL` with a fixed technical default
(e.g. 60000, documented as safety ceiling not quota), or admission-SQL `COALESCE(max_task_runtime, <fixed>)` clamp
plus `CHECK(deadline_at - created_at <= COALESCE(...))`. Lead's "finite runtime required" stands.

### MEDIUM-4 (lead concerns CONFIRMED): reservation/task rows cannot recheck authority, settlement, or exclusivity

Executed FK/structural probes:
- `hosted_reservations` has NO `worker_id`, NO consumed-runtime column, NO allowance pointer
  (`kind` is fixed `'task_execution'`; only `quantity TEXT`). Settlement (`consumed_runtime_ms` in DTO) has nowhere
  to land; allowance `consumed/reserved_quantity` columns exist but no FK/pointer from reservation→allowance, so the
  "settle together" protocol step cannot be expressed as conditional SQL on these tables.
- `hosted_tasks.principal_id TEXT NOT NULL` is free text with no FK (not users/sessions/installations/grants).
  Unlike `worker_enrollments` (`authorizing_user_id` + `session_id` + `enrollment.ts:199` authority subselect),
  dispatch/claim/renew/settle SQL cannot JOIN from the task row back to a live authorizer — authority recheck must
  trust app-supplied IDs. Fix: add `authorizing_user_id`, `authorizing_grant_id` (or installation/session refs) +
  `execution_grant_id FK`, mirroring the enrollment pattern the codebase already proves.
- Worker exclusivity: two `queued` tasks on the same `worker_id` INSERT cleanly (executed probe: ALLOWED — no DDL
  guard). Cross-tenant `organization_id='orgB'` + `worker_id` of orgA also INSERTs cleanly (FK only checks the worker
  row exists, not its org). Tenant-FKs are single-ID existence checks, exactly as the lead feared. Conditional
  admission SQL can compensate, but claim/settle paths have no `worker_id`-equality guard between task/supervisor
  (`task.supervisor_id` has no worker-equality link to `supervisor.worker_id` — probe confirms).
  Fix: composite guard pattern already used in-repo — `WHERE EXISTS(SELECT 1 FROM cloud_workers w WHERE
  w.worker_id=<task> AND w.organization_id=<tenant> AND ...)` on every mutating statement, plus a unique partial
  index or conditional single-active-task-per-worker check if exclusivity is intended (protocol is ambiguous here —
  clarify: is `max_concurrent_workers` about enrolled workers or single-task affinity?).

### LOW-5: FK "not enforced" author claim is refuted by primary source + workerd execution — restore rejection assertions

Candidate test comment: "D1/Miniflare does not enforce FKs at INSERT time (same as 0001/0002)". Refuted twice:
(1) primary source above — real D1 enforces FKs on every query/migration, ≡ pragma ON, not toggleable by user queries;
(2) executed workerd/Miniflare probes — orphan INSERT rejected on direct AND batch handles, `pragma_foreign_keys`=1.
The declaration-only test ("assert FK declared + tenant reads never cross") is a weakened test that would certify fake
FK verification: it passes even if enforcement regresses. `0001/0002` migrations contain zero PRAGMA — consistent with
relying on D1's always-on enforcement, not with enforcement being absent.
Fix: replace the declaration-only block with rejection assertions (orphan task INSERT, reservation with bad `task_id`,
both direct and batch), keep conditional batch org-match guards as defense-in-depth (FKs can't express org-match),
and delete the false platform claim. If any helper path ever allows orphans, file it as a helper/fixture gap against
the D1 source — never as D1 behavior.

### LOW-6: schema freeze readiness — close, but not freezable

Supporting full protocol (scopes/claim/stop/settlement) needs: (a) fixed quantity predicate (H1); (b) authorizer refs
on tasks (M4); (c) reservation→allowance linkage + consumed-runtime landing (M4); (d) finite runtime default/clamp
(M3); (e) safe-int quantity bound (M2); (f) FK-pragma-correct tests (L5). Positive notes: dedicated `sfexec_`/`sfsuper_`
tables (no widening of `machine_credentials` CHECK — upgrade test asserts rejection, correct); `UNIQUE(task_id)` /
`UNIQUE(reservation_id)` one-to-one intent; conditional-audit pattern available; clean-install + 2B.1-upgrade tests
exist in shape. Defaults: no quota/grant seeds in migration (good — none found); `consumed/reserved DEFAULT '0'` is
a zero state, not a grant. `hosted_operations` idempotency scope (`organization_id, principal_key, operation, key`)
is the right shape but `principal_key` free-text inherits M4's concern.

## Adversarial repro summary (all executed, assertions above)

| Probe | Query | Result |
|---|---|---|
| GLOB looseness | `SELECT '12x' GLOB '[0-9]*'` | 1 (match — BUG) |
| Full CHECK | INSERT `12x`/`1.5` into CHECK'd table | ACCEPT (BUG) |
| Overflow | `CAST('9999999999999999999' AS INTEGER)` | `9223372036854776000` (corrupt) |
| 2^53+1 | `CAST('9007199254740993' AS INTEGER)` | `9007199254740992` (off-by-one) |
| FK pragma ON | INSERT child w/ bad parent | REJECT (enforced — contradicts author claim) |
| Duplicate worker lifecycle | two queued tasks same `worker_id` | ALLOWED (no exclusivity) |
| Cross-tenant worker | task(orgB, worker-of-orgA) | ACCEPT (FK blind to org match) |

## Minimal fixes before dispatcher (ordered)

1. Tighten quantity CHECKs (allowances + reservations): add `AND col NOT GLOB '*[^0-9]*'`; add regression inserts for
   `12x`/`1.5`/`01`/20-digit expecting rejection. (HIGH)
2. Bound quantities to ≤16 digits (or prove BigInt-only path + 2^53+1 round-trip test); cap `consumed_runtime_ms`.
   (MEDIUM)
3. Make `max_task_runtime` effectively finite: `NOT NULL` + fixed safety default, or admission clamp + deadline CHECK.
   (MEDIUM)
4. Add `hosted_tasks(authorizing_user_id, execution_grant_id FK, ...)`; add reservation→allowance pointer +
   consumed-runtime column; add org-match `EXISTS` guards to every claim/ack/renew/settle statement; clarify
   worker-affinity vs concurrency semantics. (MEDIUM)
5. Replace the FK declaration-only test with orphan-rejection assertions (direct + batch); delete the false
   non-enforcement claim; cite the D1 FK source. (LOW — correctness of verification, severity lowered since workerd
   already enforces; the test as written would certify fake verification)
6. Re-run full Miniflare suite at pinned Bun 1.4.2 and report counts (this review could not: sandbox Bun 1.3.14 vs
   lockfileVersion 2). No full-root claim. (process)

## Sources

Commits/branches verified via `git rev-parse/log/merge-base/branch --contains/show` (all read-only, worktree untouched).
SQL text via `git show 7fc8c53:...`; protocol via `git show 64518ae:docs/architecture/phase-2b2-protocol.md`.
Predicates executed in `bun:sqlite` (`:memory:`, pragma ON where noted). Prior design context from
`.swarmforge/artifacts/research.md` §§1–6A (CLI scope separation, dedicated `hosted-cli` audience, enrollment
identity-only + `remote_worker_enrollment` at admission) — candidate's `sfexec_`/`sfsuper_` separation is consistent
with that direction and is endorsed; the findings above are additional, not contradictory.
