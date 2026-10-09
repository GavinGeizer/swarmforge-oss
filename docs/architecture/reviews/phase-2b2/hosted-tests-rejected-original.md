# Test report: hosted adversarial / E2E / load RED checkpoint (canonical)

Assignment: independent test-engineering turn; accepted client implementation
unchanged. Branch `swarmforge/phase2b2-hosted-20261009/worker-client-storage/w-c32682ab-d72d-4b25-8179-0fef4e95eb4e`,
checkpoint commit `7300825` on schema cherry-picks `c8a429e` (7fc) + `c6be5e0` (b61),
prior client commits `09db215`/`32b230f`, original git-base `fec6697`. Tree clean.

## Scope kept
New files only: `apps/cloud/test/hosted-adversarial.integration.ts`,
`apps/cloud/test/hosted-e2e.integration.ts`, `apps/cloud/test/hosted-load.integration.ts`.
No product/shared-helper/router/schema/config/other-test edits. No unimplemented-source
imports (tests import only `machine-helpers.ts` + node builtins).

## RED plan (bounded first checkpoint)
1. Admission envelope: POST task body per protocol → expect 404 not_found (unwired).
2. Capability denial: zero/absent policy + shell-class body → 404s, zero hosted_tasks rows.
3. Same-org concurrency: 6 simultaneous submissions vs seeded ceiling (1 worker / 2 tasks /
   2 reservations test-only rows) → all 404, zero rows.
4. Idempotency: same key replay → identical 404s, zero task/reservation/outbox rows.
5. Cross-org + cross-audience: foreign session, sfcli_ on claim route, fake sfsuper_ on
   admission → all 404.
6. Lease/fence replay on renew/settle → 404s.
7. E2E seams: tenant read 200 (wired) vs entitlements + admission 404 (unwired).
8. Load: 24-burst → {404:24}, zero partial rows; NO fabricated D1 rows_read/written meta
   (local runtime exposes none; edge CPU out of scope).

## Exact failing production responses (RED evidence, all from DEFAULT Worker)
- `POST /v1/tenants/:tenant/tasks` (account session + Idempotency-Key, controlled body)
  → `404 {"error":{"code":"not_found","message":"Resource not found","request_id":"..."}}`.
- Same for shell-class body, 6-way burst (6x + 24x), idempotency replay, cross-org session,
  fake `sfsuper_` bearer, and `/v1/supervisor/tasks/:task/{renew,settle}` probes.
- `POST /v1/supervisor/claim` with `sfcli_` bearer → 404 (unwired route; audience check
  lands with the dispatch owner).
- `GET /v1/tenants/:tenant/entitlements` → 404; `GET /v1/tenants/:tenant` → 200 (control).

## Verification (exact commands, apps/cloud)
- `node --experimental-strip-types --test test/hosted-adversarial.integration.ts`
  → 6 pass (assertions pin the 404 envelopes above; ~45s).
- `node --experimental-strip-types --test test/hosted-e2e.integration.ts
  test/hosted-load.integration.ts` → 2 pass (~20s).
- `bun run check` (apps/cloud) → clean, 38 files.
- Default `bun` on this VM resolves PATH bun; pinned Bun 1.4.2 available at
  /tmp/opencode/bun142 (used for the earlier client turn). Node 24.21.
- Simulated GitHub identities only (synthetic user100/user200); no secrets, no raw
  credential argv, no workload execution, no remote deploy.

## Gaps / next (joint E2E stage, after backend candidate integrates)
- Promote seams to protocol replies: 202 AdmissionReply, entitlement view, claim/ack/
  renew/settle LeaseReply flows, revocation/partition/cancellation duplicates.
- E2E bridge then: real Node Miniflare D1 HTTP listener + actual Bun Supervisor +
  Coordinator + Store + fixed child through real clients, reading ready client/factory
  signatures (supervisor candidate e772344 NOT integrated; seams only read, never imported).
- Load then: same burst vs wired backend, ceiling enforcement + genuine D1 meta only
  where actually available, local-vs-edge clearly distinguished.
- These tests MUST stay red until production passes; no acceptance certified this turn.

