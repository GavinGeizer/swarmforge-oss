# Phase 2B.2 implementation plan

Goal: working organization-owned entitlements, atomic hosted admission, fenced
durable dispatch and a Bun supervisor/client implementation with safe stop recovery.
Spec: [design brief](phase-2b2-design.md) and the user's full Phase 2B.2 request.
Execution method: SwarmForge engineering workers, with lead-owned integration and
final verification. The user's autonomous execution directive supersedes optional
design/plan confirmation steps in general workflow skills.

## Global constraints

- Start at fec66971536cb117b36c85faabd98883d6491cb2; do not merge master.
- Keep Bun >=1.4.2 and the existing standalone Workers/D1 package/toolchain.
- Preserve GitHub Device Flow/App/SSH, local CLI/provider/SQLite and existing cloud identity.
- No Stripe, managed inference, production provisioning, remote deployment or untrusted execution.
- No product prices/default commercial grants; default absent/expired/revoked policy denies admission.
- Every worker uses an isolated assigned branch and explicit file ownership.
- Test production paths, report real results, keep assertions and failure evidence.

## Review focus

- Revoked or replaced principals cannot replay idempotency caches or revive leases.
- Expiration/partition/cancellation cannot release capacity for uncertain execution.
- Same tenant simultaneous submissions never exceed worker/task/reservation limits.
- Crash between local mapping, runtime start, acknowledgement and completion cannot duplicate execution.
- Credential storage, requests, task payloads, logs, artifacts and snapshots retain audience/secret boundaries.

## Dependency and ownership plan

| Task | Owner/area | Dependencies | Acceptance |
| --- | --- | --- | --- |
| Investigations | Three read-only SwarmForge workers | Exact baseline | Source-backed admission, recovery and isolation recommendations |
| Worker client/storage | Dedicated coder: new worker client, shared private credential-file helper, worker/client tests; narrow existing CLI storage extraction only | Existing 2B.1 routes | Real registration/identity/rotation/revocation/expiry/retry tests; no audience sharing |
| Hosted foundation | Dedicated coder: additive D1 schema, policies, explicit execution authorization, atomic admission/reservations and tests | Investigations and stable schema/protocol | Concurrent/retry/rollback/multi-tenant correctness; default deny |
| Cloud dispatch | Dedicated coder: supervisor credentials, outbox claims, leases/fencing, stop/settlement/recovery and tests | Reviewed foundation schema | Crash/partition/cancel/stale authority and duplicate-delivery adversarial checks |
| Bun supervisor | Dedicated coder: safe client, durable local mapping, Coordinator adapter/watchdog, runtime-stop and root tests | Stable dispatch contract; shared private storage helper | Actual inert execution/cancellation with restart recovery; no broad credential injection |
| Adversarial integration | Independent test coder: new hosted end-to-end/hostile/load test files | Working cloud/Bun candidates | Invoke production D1/workerd/Bun paths; exercise all acceptance criteria |
| Integration/operations | Lead: routers, fixtures, CI, deployment/operations docs, load evidence | Accepted worker candidates | Clean/upgrade migrations, complete checks/build/package, original reports |
| Final reviews | Three independent SwarmForge reviewers A/B/C | Exact integrated implementation commit | Architecture/compatibility; concurrency/recovery; auth/security with concrete findings |

Each code task writes failing behavioral tests first, records the red result,
implements its owned changes, runs the relevant production tests/static checks,
commits the exact candidate on its assigned branch, and returns a report/current-run
structured result. SwarmForge performs automatic verified Git handoff. The lead
validates actual files, ancestry, tests and reviewer evidence before integration.

Shared schema and endpoint request/reply names will be appended after investigators'
recommendations are adjudicated; cloud dispatch starts only when those are stable.
Independent worker-client work consumes only existing 2B.1 APIs.

## Quality and delivery gates

- [x] Read requested architecture and actual cloud/coordinator/provider/storage interfaces.
- [x] Run fresh root/cloud baseline before product changes.
- [x] Discover SwarmForge tools/capacity/model and start scoped independent investigations.
- [ ] Finalize shared schema, protocol, technical defaults and file ownership from evidence.
- [ ] Implement/review worker client and hosted foundation.
- [ ] Implement/review dispatch and Bun supervisor; integrate accepted commits.
- [ ] Add independent hostile concurrency/recovery tests and reproducible resource observations.
- [ ] Apply all migrations to clean and existing 2B.1 databases; verify repeatability.
- [ ] Run full root/cloud tests, both checks, Worker types/build, root build/package/verify.
- [ ] Obtain three exact-commit reviews; resolve critical/high findings and re-review.
- [ ] Preserve original reports/results/logs, verify source durability and scoped VM cleanup.
- [ ] Write phase-2b2-summary.md with live/edge/isolation gaps and Stripe/pilot prerequisites.
- [ ] Commit finished implementation and verify clean working tree; no master merge/deployment.
