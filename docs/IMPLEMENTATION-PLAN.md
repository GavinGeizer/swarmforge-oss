# SwarmForge implementation plan

Implement the user-supplied control-plane specification in this empty repository using Bun, TypeScript, SQLite, official Freestyle/OpenCode SDKs, MCP Streamable HTTP, and prom-client. One server process owns a database; many trusted leads share its MCP endpoint.

1. Configuration and persistent domain: validate environment variables; store teams, tasks, workers, dispatches, results, transitions and message-level token usage. Tests cover validation, atomic transitions and deduplication.
2. Provider adapters: current `freestyle` VM API behind WorkerProvider; OpenCode v2 generated client behind CodingAgent. Use deterministic VM slugs and session titles for restart discovery. Configure only worker-scoped credentials, a protected OpenCode server and an externally supplied snapshot/workspace.
3. Coordinator: durable creation queue; bounded provisioning; per-worker serialization; persist intent before side effects; reconcile VM/session/dispatch state after restart. Test controls, result fallback, timeouts, capacity, provider failures and crash windows.
4. MCP and observability: 16 coherent tools; cursor/limit bounded lists and logs; artifact links plus bounded resource chunks; authenticated HTTP, metrics with bounded labels, durable token accounting. Exercise actual MCP client/server round trips.
5. Documentation and operational validation: environment example, architecture/API/worker/metrics documentation, optional credential-gated real smoke flow; run tests and type/lint checks; architecture review and fix material issues.

No Git hosting, inference deployment, custom scheduler, lead reasoning or external database. Git tree is opaque and passed unchanged to workers. Retain failed/completed VMs; destruction requires a clean workspace and no obvious local-only commits, or explicit force.

Research sources and exact integration choices are recorded in RESEARCH.md. Tests use injected provider and OpenCode doubles; production adapters compile against installed package declarations.

Implementation status: all five steps implemented. Review findings and fixes are recorded in ARCHITECTURE-REVIEW.md. The credential-gated live smoke test is available but remains a deployment validation step.
