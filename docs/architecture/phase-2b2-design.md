# Phase 2B.2 design brief

The user's Phase 2B.2 specification governs this work and authorizes autonomous
implementation, local validation, feature commits, SwarmForge delegation and
team-scoped preservation/cleanup. No master merge or remote deployment is authorized.

## Outcome and constraints

Cloudflare Workers/D1 owns identity, organization authority, server-owned
entitlements, atomic capacity reservation, finite task leases and durable dispatch.
The existing Bun Coordinator owns orchestration and verified runtime stop. Its
SQLite store remains the local lifecycle authority; it is not the hosted quota
authority. Free self-hosting continues without any hosted verification.

Deliver a working controlled organization path from admission through authenticated
supervisor claim/renewal/completion/cancellation and reservation reconciliation.
Prove concurrency, idempotency, fencing, crash/partition recovery and tenant isolation
against production handlers in local D1/workerd and actual Bun clients. Admission is
logically once per operation; network delivery is at least once. Uncertain execution
must never be retried as a new runtime or counted as stopped.

Keep hostile/untrusted customer workload execution disabled. A controlled, inert
runtime may prove the protocol, but accepts no arbitrary shell, repository credentials,
model credentials or provider secrets. Broad GitHub/model handoff in the self-hosted
provider is not a hosted security boundary. No Stripe, managed inference, VM
provisioning service, pricing or owner-unapproved quotas.

Starting source: `fec66971536cb117b36c85faabd98883d6491cb2`, clean on
`phase2b1-cloud-linking`; implementation uses `phase2b2-hosted-dispatch`.
Fresh root baseline: 610 pass, 2 skip, 0 fail (3,771 assertions, 216.29s).
Fresh cloud baseline: 52 pass, 0 fail (39.47s). Baseline logs are retained locally.
The prior paused root run is incomplete and is not counted as baseline evidence.

## Decisions requiring independent evidence

1. Count indexed, unreleased reservations inside serialized D1 admission batches,
   rather than use process counters or an advisory evaluate-then-insert check.
   Reserve task and worker capacity together with durable task/outbox/audit creation.
2. Persist server policy versions, validity windows and revocation. Default is no
   execution grant. Policy mutation is trusted operator authority, never tenant
   self-service elevation or client-supplied plan state. Renewals recheck policy;
   emergency cleanup does not require a currently valid commercial entitlement.
3. Existing CLI `identity:read`/`devices:self` credentials remain insufficient for
   execution. Execution authority requires explicit browser approval and separate
   narrow scopes. Supervisor credentials use a separate hashed-token audience and
   never consume worker/browser/GitHub/global instance credentials.
4. Expiration/cancellation/revocation removes execution authority and creates stop
   duty. Capacity for possibly started work remains quarantined until trusted stop
   evidence. Unclaimed work can be safely cancelled and released atomically.
5. Claims receive monotonically increasing fencing tokens. A supervisor cannot
   extend an expired lease or revive authority using stale reports. Ownership
   transfer requires old stop reconciliation before another execution attempt.
6. A durable local task-to-worker mapping precedes any runtime start. A lost
   response retries the same task/lease/fence. A watchdog stops execution before
   authority expires; a process crash does not turn network uncertainty into stop
   proof. Coordinator `cancelled` by itself is not proof: its fallback can be paused.
7. Linux x64 glibc is the current supported release. POSIX protected storage is
   reused for worker/supervisor credentials. Windows storage remains explicitly
   unsupported; no weaker fallback is introduced.

## Engineering approach

Use SwarmForge dependency stages plus parallel implementation. Three independent
investigators evaluate admission SQL, leases/recovery, and secret isolation against
the exact baseline. Finalize interfaces from evidence, then assign one owner per
schema/module/client/test area. Require read-only independent review of implementation
branches before accepting them and three complementary reviews of the final code.
Preserve original reports and corrections, verify actual commits/remote durability,
and destroy only this phase's workers after preservation. Investigations and review
do not constitute live provider, deployment, quota or isolation verification.
