# Identity and trust boundaries

## Current identities are separate authorities

| Credential | Issuer / consumer | Authority and actual exposure |
| --- | --- | --- |
| GitHub Device Flow user access token | GitHub / local repository clone/push adapter | User grants `repo`; selected repository is local policy, not a token restriction. Persisted in private CLI file; temporarily enters privileged guest during clone/push. |
| GitHub App installation access token | GitHub / repository adapter | Installation/repository permissions; `src/git-handoff.ts:installationToken` requests configured repository and Contents write. App private key remains coordinator-side; temporary installation token enters guest. |
| SSH private key | Customer / Git remote | Depends on key deployment and repository permissions. Temporarily installed in guest; known-host verification is required by current adapter. |
| Coordinator shared API bearer | Customer configuration / local HTTP | Entire instance, no individual account or tenant scope. Optional on loopback, required on accepted non-loopback hosts. Never a cloud customer identity. |
| Freestyle API key | Customer's provider / coordinator | Provider management authority; not supplied in guest config. |
| Model key | Customer's AI provider / OpenCode guest | Used in worker runtime environment; copied to each worker. Not an organization identity. |
| OpenCode worker password | Coordinator / OpenCode endpoint | Per-worker Basic auth for coordinator-to-runtime access. Not worker enrollment or cloud authorization. |
| Future SwarmForge-issued account/CLI credential | SwarmForge cloud / hosted edge only | Audience, principal, tenant membership, scopes, expiry and revocation. Does not itself grant GitHub repository access. |
| Future worker credential | SwarmForge cloud / worker ingress only | One tenant + worker + registration epoch, bounded scopes; never account/admin/repository authority. |

Evidence: `src/github-oauth.ts:deviceLogin`, `src/git-handoff.ts:installationToken`, `src/providers/freestyle.ts:withGitCredentials`, `src/providers/opencode.ts:client`, `src/http.ts:31-43`, `src/config.ts:workerEnv`. Device Flow and its credential format stay unchanged. No GitHub user token is accepted at a future cloud route as a SwarmForge bearer; a GitHub subject used by a future identity provider still needs a separate cloud session and organization membership.

## Proposed cloud authority

A **customer account** has an opaque SwarmForge subject ID. A **tenant** represents organization ownership and subscription/resource boundaries. Membership is server-owned, with initial roles owner/admin/operator/viewer; these are recommended permission categories, subject to owner product review. Worker role labels such as coder/reviewer remain task descriptions, not organization roles.

Authentication adapter output:

```ts
interface CloudPrincipal {
  subject_id: string;
  credential_id: string;
  kind: "account" | "cli" | "worker" | "supervisor";
  audience: "cloud-api" | "worker-ingress" | "supervisor-ingress";
  scopes: readonly string[];
  expires_at: number; // Unix milliseconds
}
```

This is a documentation contract, not implemented production code. Validation includes issuer/audience, expiry and revocation. Tenant route selection is never enough: resolve active membership for account/CLI principals, and resolve issued tenant/worker bindings for machine principals. Resource lookup combines tenant ID and object ID; do not fetch global resources and authorize only afterward. Use opaque IDs and 404 for inaccessible objects; memberships and entitlement state are not accepted from client claims without server verification.

The subscription belongs to a tenant, not a GitHub repository or worker. A paid state permits capabilities; it does not add membership or override repository permissions. Billing webhooks eventually update a server-owned projection, never trusting a CLI/browser's reported plan. Provider account ownership is separate again; workers cannot select another tenant's compute credential references.

## CLI-to-cloud linking

Preserve `swarmforge github login` for repository identity. Add a separate explicit `swarmforge cloud login` only in a later phase. Proposed linking exchanges a single-use secret known only to the initiating CLI, plus a human-visible verification code approved in an authenticated website session. Approval binds a server-selected account and authorized tenant; a supplied subject/tenant is never accepted without membership checks. Store cloud credentials separately from GitHub files with private permissions and audience separation.

Link codes expire in ten minutes (technical proposal), attempts are rate-limited, secrets are hashed at rest, and the browser shows the CLI session and requested scope to avoid unsolicited-link approval. Polling cannot consume a code belonging to another CLI. Tenant changes require explicit approval and issuance; logout revokes issued cloud credentials separately from GitHub grants. Details are [API contracts](cloud-api-contracts.md), not a replacement Device Flow implementation.

## Worker enrollment and assignment

1. Tenant admin obtains a short-lived one-use enrollment secret tied to a tenant and approved worker class. Verify `remote_worker_enrollment` for customer workers; managed supervisor enrollment requires `managed_compute` instead.
2. Registration atomically consumes that secret and binds worker ID, tenant ID, ownership class and registration epoch. The worker cannot choose tenant, provider credentials, plan or machine authority.
3. Worker bearer (opaque, hashed at rest, short-lived) accesses only that worker's heartbeat/assignment/result/usage-ingress scopes. Start with an outbound-only worker connection; never fetch arbitrary user-supplied callback URLs or treat a shared control-plane bearer as a worker credential.
4. Each assignment is independently bound to task/run/worker/tenant, carries a lease expiry and execution budget, and excludes account sessions, billing secrets and provider management credentials. Token rotation/revocation checks must invalidate old epochs. No automatic broad worker refresh authority is implied by this phase's contracts.
5. Revocation rejects future requests, stops task assignments and queues supervisor cancellation. A disconnected compromised worker may continue locally: short execution leases, bounded compute credentials and managed inference proxy revocation limit damage. The API cannot promise instantaneous process termination.

Managed supervisors hold narrowly scoped tenant-aware internal credentials. Worker-reported capabilities/resources/usage are untrusted hints. The server chooses eligible capacity; a worker claiming another worker ID/run cannot obtain its task or mutate its accounting.

## Repository and inference isolation

Current privileged workers are within the self-hosted operator's trust domain. A broad Device Flow token in a cloud guest would violate the intended compromised-worker boundary. Before commercial execution, use a customer-side repository broker or separately consented repository-scoped GitHub App tokens, preferably brokered operations without exposing reusable tokens. Installation tokens still grant repository permissions, not branch-only authorization; a gateway must enforce allowed ref/operation/task policies where branch restriction is required. Never expose the App private key or unrestricted user's token. Do not reuse the current temporary-file mechanism as proof of cloud isolation: a compromised process can copy a credential before cleanup.

Managed inference should use tenant/task-limited proxy credentials with server budget checks. BYOK AI keys must be encrypted outside metadata, injected only into the assigned runtime and never included in task/log/artifact/API output; customer consent and storage policy remain owner decisions. Credential references are looked up within tenant ownership. Separate workspaces, artifacts, network access and compute credentials between tenants; do not reuse dirty guest snapshots or caches carrying customer data. Egress policy and least privilege must be verified with adversarial workers before managed launch.

## Existing risks and Phase 1 handling

- Terminal event payloads could bypass redaction. Phase 1 parses/screens data and screens final console text; regression covers escaped credentials and credential-named fields.
- Metrics listener does not inherit API authentication; keep it private/disabled when exposing a coordinator. No production bind changes made.
- OAuth screening stores token copies in SQLite (`src/security.ts:96-100`, `src/store.ts:76-86`); credential-file logout does not erase them. Treat DB/backups as secrets, revoke grants at issuer after compromise, define future retention/rotation before hosted custody.
- Arbitrary echoed GitHub App tokens/SSH material are not demonstrated screened; redaction cannot serve as a permission boundary. This phase does not modify repository credential flows. Prioritize explicit registration/screening and secret-custody review before hosted use.
- Raw preserved-artifact downloads return bytes to instance-authorized operators. Future cloud download authorization must verify tenant/task ownership and retention policy separately from content screening.
- Current host/origin/shared bearer checks prevent several instance-level attacks but provide no cross-customer isolation. Do not expose them directly as cloud APIs.

Phase 2B.1 implementation: [CLI linking and worker identity API](phase-2b1-api.md), [operational procedures](../cloud/IDENTITY.md). Historical future contracts above remain proposals where the implementation document does not mark a route implemented.
