# API research — 2026-09-16

The repository had no source files or commits. Current official documentation was retrieved before implementation; installed declaration files are the final API contract.

| Dependency | Verified API and decision |
| --- | --- |
| [Freestyle quickstart](https://www.freestyle.sh/docs/quickstart) and [VM API](https://www.freestyle.sh/docs/vms) | `freestyle@0.2.13`, `Freestyle({apiKey, baseUrl})`, `vms.create/get/list/ref`, persistent snapshots, unique slugs and metadata. Current REST routes are `/v5`. Do not use the old `freestyle-sandboxes` API. |
| [VM lifecycle](https://www.freestyle.sh/docs/vms/lifecycle) | `pause()` freezes memory; `start()` resumes; deletion is permanent. Auto-delete disabled where account policy permits. Account-imposed retention can still reclaim paused VMs. |
| [Files](https://www.freestyle.sh/docs/vms/files) | `vm.fs.readFile({offset,length})`, stat, directory listing, atomic writes. Reads work on paused/stopped VMs. |
| [TLS routing](https://www.freestyle.sh/docs/vms/domains) | Create-time `tls.rules` publishes a unique `style.dev` hostname, with rules tied to VM lifetime. OpenCode is protected with a per-worker random Basic-auth password. Outbound Internet is explicit; optional existing VPC supports private inference/tree endpoints. |
| [`@freestyle-sh/with-opencode`](https://www.npmjs.com/package/@freestyle-sh/with-opencode) | Published 0.0.14 depends on `freestyle ^0.1.46`; package code uses the older `VmSpec` and `domains.mappings` APIs, starts both web/server services, and interpolates environment values into shell strings. Inspected registry metadata and published source. Use current SDK directly with a prepared external snapshot instead. |
| [OpenCode SDK](https://opencode.ai/docs/sdk/) and [server](https://opencode.ai/docs/server/) | `@opencode-ai/sdk@1.18.31`, `/v2` export. `session.create/list/get`, `promptAsync({sessionID,messageID})`, status/messages/abort. Although JSON Schema output formatting is supported by the API schema, OpenCode 1.18.31 rejects its stored format during session-message retrieval; SwarmForge requests JSON text and parses it, while still accepting `AssistantMessage.structured` when available. |
| [OpenCode providers](https://opencode.ai/docs/providers/#custom-provider) | Custom provider uses `npm:'@ai-sdk/openai-compatible'`, `options.baseURL` and environment interpolation `apiKey:'{env:SWARMFORGE_MODEL_API_KEY}'`. Model is `swarmforge/<configured-name>`. External endpoint must support chat completions and tool calls. |
| [MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/) | Current stable `@modelcontextprotocol/sdk@1.30.0`. Web-standard Streamable HTTP transport for Bun. Tools return structuredContent; artifacts use resource_link and bounded explicit resources/read chunks. v2 documentation exists separately; stable installed v1 API chosen. |
| [Prometheus naming](https://prometheus.io/docs/practices/naming/) | Namespace prefix, counters end `_total`, durations use seconds, no worker/task/prompt labels. Explicit team allowlist bounds arbitrary team cardinality. `prom-client` formats exposition. |

Context7's Freestyle index still returned the older dev-server APIs. Those results were rejected in favor of current official VM documentation and published package types. Research cache is ignored under `.firecrawl/`.
