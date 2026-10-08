# Intended product editions

These are product definitions for future delivery, not claims about existing services. Current availability is [audited separately](current-state.md). “SwarmForge” below means the commercial service operator; “customer” includes their chosen infrastructure/AI providers.

| Capability / responsibility | Free: Self-hosted | BYOK All | BYOK AI | Fully Managed |
| --- | --- | --- | --- | --- |
| Orchestration/control plane | Customer-run | SwarmForge hosted | SwarmForge hosted | SwarmForge hosted |
| Worker compute ownership/payment | Customer | Customer | SwarmForge | SwarmForge |
| AI model access/payment | Customer | Customer | Customer | SwarmForge |
| Local CLI orchestration | Yes, under existing license | Available separately under existing license | Available separately under existing license | Available separately under existing license |
| CLI-first GitHub repository operations | Yes | Yes, credential placement must be designed | Yes, least-privilege credentials required | Yes, least-privilege credentials required |
| Cloud orchestration | No | Yes | Yes | Yes |
| Customer remote worker enrollment | No cloud enrollment; self-hosted adapters independent | Yes | Whether also offered is an owner decision | Whether also offered is an owner decision |
| Managed compute | No | No | Yes | Yes |
| Managed inference | No | No | No | Yes |
| SwarmForge customer account | Unnecessary | Required | Required | Required |
| Repository identity | Customer GitHub/device/App/SSH credential | Separate customer repository authority | Separate customer repository authority | Separate customer repository authority |
| Worker identity | Customer-managed runtime/provider auth | Tenant-bound SwarmForge credential | Tenant-bound SwarmForge credential | Tenant-bound SwarmForge credential |
| Subscription | None | Paid hosted subscription | Paid hosted subscription | Paid subscription; possible usage charges |
| Billing owner / surface | Customer pays external suppliers; no Stripe dependency | SwarmForge website | SwarmForge website | SwarmForge website |
| Limits | Operator configuration; no commercial verification | Hosted task/worker caps | Caps plus managed-compute allowances | Caps plus compute/inference allowances and strict accounting |
| Cost accounting | Measured usage + optional estimates | Hosted coordination service usage | Authoritative compute records; AI customer-paid | Authoritative compute and inference records |
| Mandatory hosted contact | None | For hosted actions | For hosted actions | For hosted actions |

Self-hosting must continue to operate without cloud account linking, commercial token checks, Stripe, callbacks or mandatory telemetry. A hosted subscription does not change the application license automatically. The checked-in `LICENSE:59-66` specifies qualifying organizations using both worker count and inflation-adjusted revenue conditions; do not turn “personal developer” into a new blanket legal exemption. [License guidance](../licensing/README.md) explains existing terms. Owner/legal approval is needed for any alternative license or commercial agreement, not an application entitlement check.

## Capabilities and values

Booleans distinguish hosted services from separately available local functionality. Numeric caps and metered allowance values remain unset business choices; no prices, worker sizes, seats or trial quantities are specified. Free local limits remain operator-configured and are not subscription caps. See [entitlements](entitlements.md) for types and fail-closed hosted enforcement.

## Owner decisions still required

- Price, currency, taxes, trial policy, billing interval, refunds and supported regions.
- Seat/organization pricing, subscription owner, transfer rules, member role policy and organization deletion.
- Default worker/task quotas by plan; compute sizes, allowance units, reset windows and carryover.
- Hard caps versus paid overage; inference model catalogue/rates, budget reserve margin and provider fees.
- Retained/paused VM charging, cancellation charges, artifact storage/retention and egress accounting.
- BYOK credential custody: customer-controlled broker versus encrypted hosted storage, accepted credential types and supported suppliers. BYOK AI necessarily allows the runtime to use customer inference credentials; security consequences require explicit terms.
- Whether managed tiers permit customer-owned workers, and whether plans can mix worker sources.
- Whether hosted repository operations stay entirely in a customer-side broker or use a separately consented GitHub App. Device Flow remains the self-hosted CLI workflow.
- Payment grace periods and behavior of already running tasks after delinquency. Cleanup/cancellation remains permitted even if new paid work is denied.
- Commercial support/SLA and license exceptions. Cloudflare Free is an initial constraint, not a paid-customer availability guarantee.
