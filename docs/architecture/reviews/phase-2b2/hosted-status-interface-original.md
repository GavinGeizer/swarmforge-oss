# hosted-status interface (for lead integration)

Worker w-6e744671-a513-4c66-af22-4b21c79a05e0 · run 8c81d0fb-5070-44ab-8c01-09dd3be5fb4c.
PRIVATE hosted operational visibility only. No router/lifecycle edits in this
packet: the lead wires the route into the global router after prerequisites.

## Exact exports (new file `apps/cloud/src/hosted-status.ts`)

- `hostedStatusRoute(ctx: Context) => Promise<Response | null>` — handles
  `GET /v1/tenants/:tenant/hosted-status`, returns `null` for any other
  path/method (same nullable-handler convention as `hostedAuthorityRoute` /
  `entitlementsRoute`). Lead wiring:
  `for (const handler of [hostedAuthorityRoute, entitlementsRoute, hostedStatusRoute])`.
- `hostedStatusSchema` (frozen zod response schema, `.strict()`) and
  `HostedStatus` (inferred type).

## Request contract

- Path tenant must be UUID (`idSchema`); strict query `{ limit: 1..50
  default 20, cursor? max 2048 }`. Non-UUID tenant or `limit=999` → 400.
- Auth mirrors the entitlements route: bearer `sfexec_` via `hostedAuth`
  (exact scope match + same tenant) else current browser-session membership
  (`authentication` + `membership`). `sfcli_`/`sfworker_`/`sfsuper_`/global
  bearers → 401; cross-org → 404 (never leaks). No auth → 401. No CSRF
  requirement (read-only GET, same as entitlements route).
- Pagination uses the existing `page(ctx, tenant, "hosted-status")` /
  `cursor(...)` pattern: one shared tenant-bound cursor scope, stable
  `task_id`/`supervisor_id` ordering, `<=50` items per page. Cursor replay
  under another tenant → 400. No arbitrary SQL: all predicates are fixed
  strings with bound args.

## Response contract (`hostedStatusSchema`)

- Identity: `tenant_id`.
- Policy snapshot: `policy_version` (null when absent), `policy_allowed`,
  `policy_denial` (`policy_absent`/`policy_revoked`/`policy_expired`/
  `capability_denied`/null), quota ceilings `max_concurrent_workers`,
  `max_active_tasks`, `max_task_runtime`, `maximum_resource_reservations`
  (each nullable). Emergency-read semantics: missing policy yields
  `allowed=false` + denial, never a read denial. No entitlement cap is
  required to read; session revocation + current CLI epoch enforced by auth.
- Ledger: `consumed_quantity` / `reserved_quantity` — canonical bounded
  integer strings over the CONTROLLED meter triple only
  (`compute_ms`/`millisecond`/`controlled`, exact-parsed via `parseQuantity`),
  null when undefined. No product quota/price semantics, no commercial bypass.
- Counts (all SQL tenant-qualified; DB failure throws 503, never
  catch-error-to-0): `active_reservations`, `quarantined_reservations`,
  `task_states` (all 9 states keyed, zero-filled), `held_tasks`,
  `stop_requested_tasks`, `expired_leases` (open states with
  `lease_expires_at<=now`), `unclaimed_outbox` (`state='queued'`),
  `outbox_attempts` (sum over queued/claimed), `failure_audits`
  (`hosted.task_failed`), `cleanup_audits` (`hosted.cleanup`), `stop_audits`
  (`hosted.stop_requested`).
- Dispatch activity: `last_dispatch_action` / `last_dispatch_at` — newest
  `hosted.*` audit row for the tenant, nulls when none observed.
- Operator pages (safe reference columns only: `task_id`, `state`,
  `worker_id`, `fence`, `lease_id`, `lease_expires_at`): `stop_duty`,
  `held_page`, `lease_page`. No raw tokens/hashes/ciphertext/prompts/env/stacks.
- `supervisors[]`: `supervisor_id`, `worker_id`, `name`, authority `status`
  (registered/revoked), `credential_authority` (valid/expired/revoked/absent —
  AUTHORITY, not liveness), `credential_expires_at`,
  `last_observed_action`/`last_observed_at` (newest attributed audit row —
  OBSERVED availability, labeled separately), `worker_status`,
  `worker_epoch`, `admin_chain_user_id` (authorizing user of the bound worker).
  A registered credential is NEVER asserted as "online".
- `next_cursor`: signed tenant-bound cursor or null when all pages exhausted.
- `query_cost`: `{ statements, rows, worst_ms }` — counted statements, rows
  touched, wall time. Measured full-suite worst is single-digit ms per route
  call, far under the Free-tier 50ms statement ceiling + global rate overhead.

## DDL note

No DDL changes needed. `last_observed_*` is inferred from `audit_events`
(`resource LIKE 'supervisor:<id>%'`) and clearly labeled as observed audit
activity; no `last_seen` column is assumed on hosted tables. If the schema
later gains an observed-activity column, the inference can be swapped without
changing the response shape.

## Test surface (new files, existing fixtures untouched)

- `apps/cloud/test/hosted-status-router.ts` — TEMPORARY status router
  (production authority + entitlements + NEW status handlers, then the real
  lead-owned worker). Deleted at lead integration.
- `apps/cloud/test/hosted-status-helper.ts` — uniquely-named
  `hostedStatusFixture` + `statusDefaultPolicy` (real workerd D1, actual
  production handler fixtures, all-3-migrations via `applyMigrations`).
- `apps/cloud/test/hosted-status.integration.ts` — 3 tests on real D1/workerd:
  mixed-state counts incl. cross-org isolation + missing-policy read;
  auth matrix (401/404/400), pagination bound + cursor tenant binding,
  wrong audiences, DB-outage fail-closed; supervisor authority-vs-observed,
  max-bound ledger quantities, revoked/expired auth fail-closed.

