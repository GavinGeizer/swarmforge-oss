# Phase 1 implementation plan

Date: 2026-10-08. User brief is the governing specification: audit before modification; preserve self-hosted behavior and GitHub Device Flow; no Stripe, new OAuth, managed provisioning or unnecessary abstractions. Technical decisions are delegated to the implementer; business decisions are documented for owner approval.

1. Audit actual CLI/config, coordinator/store, providers/runtime, Git/auth, APIs, tests/CI and deployment with independent read-only investigations. Cite source locations and distinguish existing behavior from proposed capabilities.
2. Write current-state, product-tiers, architecture-boundaries, identity-and-trust, entitlements, cloud-api-contracts, deployment and phase-1-summary documents. Verify Cloudflare limits against primary documentation. No production deployment or migrations.
3. Pin the observed terminal event credential leak with a real Store/Coordinator/logger regression. Redact before rendering and after parsing can reconstruct escaped strings; keep durable file redaction and cursors intact.
4. Add optional `WorkerProvider.stopWorkerRuntime(worker): Promise<void>` at the existing quiescence integration point. Resolution proves no more runtime execution; rejection is uncertainty. Freestyle supplies the current verified systemd stop. Old providers keep existing exec fallback. Test successful custom runtimes, uncertain stops and the adapter's nonzero/null command results; keep VM pause/missing fallbacks.
5. Run full existing tests, TypeScript/Biome and binary/package checks. Verify GitHub-flow source unchanged, no commercial imports in core, no mandatory hosted contact. Obtain an independent SwarmForge review using a bounded patch against the audited baseline; preserve its report and clean up only this task's worker.
6. Record exact checks, failures/skips, risks and Phase 2 dependency order. Commit Phase 1 changes separately from the user-requested snapshot of pre-existing changes. Do not push or publish.

Review focus: JSON-escaped secrets; adapters without the optional hook; ambiguous stop outcomes; tenant spoofing through team labels; worker misuse of broad repository credentials. Last two are architecture acceptance criteria for future implementation, not claims about existing server enforcement.
