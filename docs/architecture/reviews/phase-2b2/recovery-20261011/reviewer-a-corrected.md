# Independent Review A (Phase2B.2) — CORRECTED companion report

**Status: INCOMPLETE — corrections to interim review of `1830b06`; final EXACT
commit with two cloud fixes not yet received, no approval.**

Reviewed commit (exact): `1830b06fe5b17e0c3feb86c06f7717a3d8dd20bc`
(parent candidate `44156cc6ad7858059f0e45a659b63de81d258249`).
The original interim report (`review.md`) is preserved unchanged; this file
corrects six factual discrepancies in it, verified against actual source and
executable evidence on 2026-10-11. READ ONLY; no source modified; original
assigned branch untouched; both worktrees clean. All items remain provisional
until the EXACT final commit is inspected. Env-test positive evidence stands
as provisional; final architecture approval requires the final correction
plus any new substantive findings stated concretely.

## Correction 1 — Actual enrollment failing probe is `enrollment.integration.ts:37`, not `abuse.integration.ts:89`

- The interim report wrongly named `apps/cloud/test/abuse.integration.ts:89`
  (`h.register(invite)` after identity cleanup → 404) as the stale probe.
  That assertion **correctly remains 404**: it exercises
  `POST /v1/workers/register` with a well-formed-but-unknown
  enrollment credential, which production maps to `notFound()` at
  `apps/cloud/src/enrollment.ts:153-158` (`notFound()` = 404 at
  `apps/cloud/src/common.ts:50-51`). No change requested there.
- The actual failing probe, confirmed by the correct Node runner, is
  `apps/cloud/test/enrollment.integration.ts:37`: `POST
  /v1/tenants/{tenant}/tasks` with bearer(worker), body `{}`, and NO
  Idempotency-Key → production returns **400** (`taskSubmitSchema.parse`
  fails on `{}` inside `admit()` at
  `apps/cloud/src/hosted-admission.ts:151`; missing key would separately be
  400 via `machines.ts:78-83`), while the test expects **404**.
- Executable evidence (correct runner
  `node --experimental-strip-types --test`, from `apps/cloud/package.json:14`
  `"test": "node --experimental-strip-types --test test/*.integration.ts"`):
  `node --experimental-strip-types --test test/enrollment.integration.ts` →
  `actual: 400, expected: 404` at `enrollment.integration.ts:37:12`.
- Impact of my misattribution: I pointed the forthcoming fix at the wrong
  test/route. The `register(invite)` 404 semantics (unknown enrollment
  credential → 404, cross-tenant probes → 404 at `enrollment.ts:306,386`,
  409-consumed / 410-expired / 403-authorization_changed) must stay intact.

## Correction 2 — Strengthen-test is 401 wrong-audience with zero side effects, not 400

- The interim report described the pending enrollment fix as "return 400 for
  a valid-but-controlled placeholder payload with Idempotency-Key under
  worker credential, plus 401 for wrong-audience". Corrected expectation:
  a VALID controlled payload + Idempotency-Key sent using the **worker
  credential** (`sfworker_` bearer) against the account/operator task route
  must yield **401 wrong-audience** with **zero tasks, reservations, or
  outbox writes** — because `resolvePrincipal()` at
  `apps/cloud/src/hosted-admission.ts:75-99` routes any `authorization`
  header to the execution-grant path where `hostedAuth()` at
  `apps/cloud/src/hosted-authority.ts:118-123` accepts ONLY `sfexec_` and
  returns 401 for `sfworker_`/`sfcli_`/`sfsuper_`/global bearers, before any
  mutation. The 400 in Correction 1 is the malformed/no-key probe outcome,
  not the strengthen-test outcome.
- Invariants: no production-auth or quota change; no weakened assertions;
  the 404-for-unknown-enrollment (Correction 1, second half) stays.

## Correction 3 — Meter contract adjudication: documented contract is 403 exhaustion; production must change 409 → 403

- The interim report inverted the contract: it treated production's 409 as
  canonical and the test/docs 403 as stale. The adjudicated contract is the
  reverse — `docs/architecture/cloud-api-contracts.md:130` explicitly lists
  `403 capability_denied/allowance_exhausted/repository_denied`, matching
  the original design
  (`docs/architecture/reviews/phase-2b2/design-admission-original.md:147`:
  `403 capability_denied|allowance_exhausted|repository_denied`), and the
  existing workerd integration test asserts `403` + code
  `allowance_exhausted` (`apps/cloud/test/hosted-admission.integration.ts:505
  title, :544 status, :545-548 code`).
- Required production change (final bundle): BOTH exhausted branches
  `409 → 403` — preflight fast-fail at
  `apps/cloud/src/hosted-admission.ts:310-315` (`remaining < runtime` →
  `allowance_exhausted`) and diagnostic classifier at `:635-637`
  (`allowance_exhausted|allowance_unavailable`). Other 409s remain:
  `allowance_unavailable` period-mismatch preflight (`:305-309`),
  `limit_exceeded` (`:591,601,611`), ledger CAS-miss / concurrency
  `admission_conflict` fallback (`:656-662`), idempotency conflicts.
- Executable evidence (correct Node runner):
  `node --experimental-strip-types --test test/hosted-admission.integration.ts
  -t "exhausted allowance"` → `AssertionError: 409 !== 403` at
  `hosted-admission.integration.ts:544:12` — i.e. the TEST asserts the
  documented 403 contract and PRODUCTION currently returns 409. Full
  integration run: **124 tests, 122 pass, 2 fail** (the two genuine
  assertion failures: enrollment 400-vs-404 and allowance 409-vs-403),
  zero startup errors.

## Correction 4 — Canonical-int64 second admission test gets 403 + `allowance_exhausted`, ledger assertions preserved

- The interim report cited
  `apps/cloud/test/hosted-admission-regressions.test.ts:51-59,341,353,518`
  as "correct-behavior reference (409-for-exhaustion)" and proposed using it
  to rewrite the 403 contract. Corrected: the canonical-int64 second
  admission at `hosted-admission-regressions.test.ts:353`
  (`expect((await admit(h, a, w2.worker_id)).status).toBe(409)`, in test
  "SQL int64 meter arithmetic reaches the canonical boundary exactly and
  refuses overflow", `:325-370`) is a Bun-SQL local-fixture test
  (`import { expect, test } from "bun:test"`, NOT runnable under the Node
  runner — correctly executed via `bun run test:sql` →
  `apps/cloud: 87 pass / 0 fail`), and after the production 409→403 change
  it must assert **403 + `allowance_exhausted`** while preserving ALL ledger
  assertions (`reserved_quantity "1000"`, `total "9007199254740991"`,
  DDL overflow refusal). It must NOT be used to rewrite the documented 403
  contract. Same applies to the other local 409 exhaustion spot
  (`:59` zero-allowance); genuine non-exhaustion 409s (CAS miss `:518`,
  concurrency `:456`, replay `:768`, etc.) stay 409.

## Correction 5 — Correct runner is Node `--experimental-strip-types`; Bun-running Node integration is unsupported

- The interim report ran `bun test ./test/*.integration.ts`, which fails
  with `Cannot find package 'esbuild'` and, for the 403 probe, with
  miniflare `ENOTFOUND api.example.invalid`. That runner is unsupported for
  these files: `apps/cloud/test/hosted-admission-regressions.test.ts:1`
  imports `bun:test`, while `*.integration.ts` files import `node:test` and
  the package script (`apps/cloud/package.json:14-15`) prescribes
  `node --experimental-strip-types --test test/*.integration.ts` then
  `bun run test:sql` (`bun --no-env-file --config=/dev/null test
  test/*.test.ts`).
- Retried correctly after the (non-)fix state: full
  `node --experimental-strip-types --test test/*.integration.ts` →
  **124 tests, 122 pass, 2 genuine assertion fails** (Corrections 1 and 3),
  zero startup errors — matching the lead's actual-workerd result shape
  (19-file workerd run cited as 17 pass / 2 genuine assertions). SQL suite
  via `bun run test:sql` → **87 pass / 0 fail**. My prior "env-blocked"
  caveat for the 403 probe is withdrawn; the Bun-runner output is not
  evidence.

## Correction 6 — stdio `pipe` transport is socket-backed fd 0, not an anonymous OS pipe

- The interim report stated "anonymous stdio pipes, not a socket" for
  `src/hosted-runtime.ts:242-271` (`stdio: ["pipe","pipe","pipe"]`). That
  terminology is wrong for this VM: production Bun/Node-spawn with
  `stdin:"pipe"` gives the child an fd 0 target of `socket:[...]` (repo's
  own probe: `subprocess-stdin-socket-restriction.log:1`
  `{"subprocessStdinTarget":"socket:[2366989]"}`, report at
  `docs/architecture/reviews/phase-2b2/child-watchdog/anonymous-pipe-parser-report.md:5`;
  the 31s renewable provider flow works in this VM and for the lead).
  Corrected: the provider/child channel is a **socket-backed fd 0 created
  by Bun/Node spawn `stdio:"pipe"`**, over which the supervisor writes
  `"<lease> <absolute>\n"` renewals (`src/hosted-runtime.ts:361-368`)
  and the child parses them fail-closed (`src/hosted-child.ts:115-143`).
  Shell-created anonymous OS pipes were supplemental parser-harness
  channels only, not the production transport. No architecture change is
  requested; child-side independent deadline enforcement
  (`src/hosted-child.ts:79-105`), parent late-renewal refusal
  (`src/hosted-runtime.ts:343-373`), and secret-isolation findings are
  unaffected.

## Preserved positives + remaining provisional items

- Env-test evidence stands (provisional): target allowlist test 1 pass;
  full `tests/hosted-supervisor.test.ts` 60 pass / 0 fail;
  `hosted-child-lease + hosted-cli + cli` 20 pass / 0 fail (Bun 1.4.2).
- Architecture items (CLI selection, local/free without cloud creds, schema
  strictness, child env exact allowlist, argv credential rejection) stand
  with Correction 6's transport terminology fix.
- Still outstanding: final EXACT commit with the two cloud fixes (enrollment
  401 wrong-audience strengthen-test with zero side effects; allowance
  409→403 in BOTH exhausted branches + advisory/doc alignment preserving
  other 409s). No approval, certification, or rejection expressed here.
- Verdict for this file: **INCOMPLETE** — final architecture approval must
  inspect the final correction and state any new substantive findings
  concretely (severity, path:line, repro, tests, invariants).
