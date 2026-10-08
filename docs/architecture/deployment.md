# Initial commercial deployment design

Proposed architecture, verified against official Cloudflare documentation on 2026-10-08. No deployment, billing configuration, secret rotation or infrastructure provisioning is performed in Phase 1. Free refers to the Cloudflare plan, not free worker compute/inference or a commercial SLA.

## Placement

| Component | Initial location | Work performed |
| --- | --- | --- |
| Public website | Cloudflare static hosting (Pages or Workers Static Assets) | Marketing/docs, account and subscription website UI; static delivery without model credentials. |
| Hosted API | Small Cloudflare Worker | Authentication verification, tenant-qualified metadata reads/writes, enrollment/linking, entitlement admission, subscription projection, usage-report acceptance. |
| Metadata | D1 binding | Accounts/memberships, tenant-owned references, hashed credentials/enrollment secrets, normalized subscriptions, entitlement versions, reservations, dedupe/outbox and compact usage summaries. No broad repository/model secrets as plaintext. |
| Execution supervisor | External durable Bun process | VM lifecycle, coordinator/store recovery, polling and dispatch, trusted usage collection/reconciliation, lease/stop enforcement, Git/artifact safety. |
| Agent execution | Customer or managed external infrastructure | OpenCode/other runtimes, repositories, model calls, Git processes, long-running tasks. |
| Artifact data plane | External private storage/service initially | Heavy files/snapshots, checksum streaming; tenant-authorized delivery. R2 can be evaluated separately, not assumed free or required now. |
| Billing | Website + future Stripe server adapter | Website checkout/customer portal and verified webhook projection. No CLI payment entry point or Stripe in engine. Not implemented in this phase. |

Repository operations remain CLI-first. Future cloud operation needs a scoped repository broker/App decision; neither website login nor payment grants GitHub permission. Long-running execution never runs inside a Cloudflare Worker, even if network waits themselves do not consume CPU. The existing server relies on Bun HTTP, local WAL SQLite, filesystem artifacts, process locks and polling timers. Keep it external; D1 is metadata authority, not a drop-in local Store.

## Verified Free limits and implications

| Service | Verified constraints | Design implication |
| --- | --- | --- |
| Workers | 100,000 requests/day, 10 ms CPU/HTTP request, 128 MB memory, six simultaneous outgoing connections; published Free subrequest table lists 50/invocation. | Bounded lightweight handlers. Measure auth/crypto/serialization CPU; avoid bundling heavy coordinator code. |
| D1 | 10 databases/account, 500 MB/database, 5 GB total storage, 50 queries/invocation, seven-day Time Travel recovery. | One metadata DB initially with tenant-qualified indexed access; do not assume a DB per paid tenant at Free scale. |
| D1 daily quotas | Five million rows read, 100,000 rows written; indexes can add writes. Exhausted daily limits return database errors until reset. | Measure actual scans/writes, batch/dedupe carefully; do not store token polling or full logs on every loop. |
| Pages (if selected) | 500 builds/month, one concurrent build, 20-minute build timeout, 20,000 files/site and 25 MiB/asset. Functions consume Workers quota. | Static site and external binary release links. Keep binary releases outside site assets. |
| Workers Static Assets (alternative) | 20,000 files/version and 25 MiB/file on Free. | Existing site asset option; choose one deployment path explicitly. |

Primary references: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [D1 pricing and quota behavior](https://developers.cloudflare.com/d1/platform/pricing/), [Pages limits](https://developers.cloudflare.com/pages/platform/limits/). Recheck before launch; resource limits and policies can change. These numbers constrain initial deployment, not a capacity guarantee.

**Capacity inference:** 50 continuously online workers with one heartbeat/minute generate `50 × 1,440 = 72,000` requests/day before user requests, linking, task traffic and usage reports. At 70 workers the same pattern reaches 100,800 requests/day. Thus Free is suitable for a bounded pilot, not the existing default “50 workers” plus unbudgeted traffic at arbitrary tenant count. A proposed 60-second heartbeat is a contract default subject to capacity testing; aggregate trusted-supervisor reporting or a paid plan is needed as deployment grows. An outbound customer worker still uses edge requests; polling every two seconds would make Free unsuitable quickly.

D1's primary database serializes work; use conditional reservations and transactional/batched mechanisms supported by D1, validated for races in Phase 2. Existing Bun `db.transaction()` semantics must not be copied into Worker code blindly. No schema migration is added now. Projected metadata entities in this document are design dependencies, not an executable schema.

## Reliability and authority

The edge persists admission/reservation and an outbox record before acknowledging acceptance. External supervisor receives tenant-scoped assignment by authenticated bounded polling or another durable protocol, claims stable assignment IDs, and acknowledges effects idempotently. If edge crashes after commit, retries return the accepted task; if external delivery stalls, work remains queued and reconciled. Do not use an unawaited promise or a Worker request lifetime as the only durability mechanism. A lease/reaper policy must reconcile crashed supervisors and reservations without premature resource release.

Configure auth routes to fail closed when quota/CPU is exhausted; no unauthenticated origin bypass. New paid work fails closed on unavailable policy/D1, returns safe 503 or platform failure, and does not allocate external compute. Cancellation/stop has a durable external authority and finite execution leases so resources do not run forever during an edge outage. Usage reconciliation must retain external evidence until edge ingestion succeeds. Budget headroom and upgrade criteria are required operational decisions before taking paid workloads.

Keep high-frequency telemetry, full logs, task output and per-token observations external. D1 stores compact reconciled summaries and policy state; where event/reservation volume is significant, retention/archival and write amplification must be measured. Protect indexes for every tenant query. Backup/restore, revoked-credential epochs, credential re-encryption and webhook replay must be tested; restoring old subscription data must not resurrect privileges automatically.

## Secrets and deployment assumptions

Use Worker environment secret bindings for identity signing/verification material and future Stripe API/webhook secrets. D1 API binding credentials remain platform-side. Never put secrets into static assets, public environment variables, checked-in Wrangler files, logs, responses, query strings or browser storage. Keep dev/preview/production identities, DBs, signing keys and webhook endpoints separate. Opaque credential/enrollment secrets are hashed; encrypted bounded response replay needs separate encryption keys. Hosted BYOK custody requires a dedicated encrypted secret store/broker and rotation plan, not plaintext D1 metadata.

External compute/model credentials belong to supervisor/runtime identities with tenant/task restrictions; Freestyle management keys never enter guests. Use TLS for edge/supervisor/worker communication, explicit audience/scopes and revocation; network access policy must not trust user-provided endpoints. Public API token redaction does not protect the unauthenticated current metrics listener: keep that listener private or disable it in externally exposed deployments, then implement explicit operational protection before managed launch.

Build/deploy from reviewed commits with separate preview environments and least-privilege CI tokens. Do not provision production D1 or alter Cloudflare routing in this phase. The current application CI/releases remain separate from future cloud deployment and the static site repo.

## Existing website evidence and unresolved selection

Application `docs/WEBSITE-DEPLOYMENT.md` describes a separate Astro site at `/home/overlord/swarmforge-site` and Cloudflare Pages. The inspected site `package.json:15-16` and `wrangler.jsonc:3-10` also support Workers Static Assets and preview uploads. Its `PLAN.md:45-48,68` records remaining domain/public-release/installer steps and dry-run-only validation. These are local configuration/documentation facts, not verification of current live hosting. Decide which static path is canonical and update both repos during an authorized deployment phase. Nothing requires site changes to preserve free CLI workflows.
