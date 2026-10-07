# Artifact CLI and plaintext agent retrieval

Validated locally on 2026-10-07 with Bun 1.4.2.

- `bun run check`: TypeScript and Biome pass.
- `bun --no-env-file --config=/dev/null test`: **580 passed, 2 skipped, 0 failed**, 582 tests across 40 files. Skips remain the absent-package sentinel and optional live infrastructure smoke.
- Tests use local files, the real guest capture helper, disposable provider fixtures, and isolated loopback MCP servers. No configured model or SwarmForge endpoint is used.

New regressions cover command parsing/pagination, authenticated CLI access after guest destruction, exact binary and empty-file downloads, private file permissions, overwrite refusal, corrupt/truncated/oversized responses, redirect refusal, cancellation cleanup, and the dashboard save action.

Agent-facing tests verify the server initialization instructions, direct live plaintext, binary metadata without inline payloads, credential refusal, and read-size bounds. UTF-8 screening trims only incomplete valid trailing code points, rather than treating arbitrary invalid binary suffixes as text.

The reference-skill baseline directed agents to resource reads for all three scenarios (live text, a large report, and a binary deliverable) without a concrete local-save command. A read-only native-agent check of the updated guidance selects plaintext readers for inspection and verified CLI downloads for complete files. No SwarmForge delegation was used. Existing user skill restructuring and reference files remain local; only the artifact workflow correction is published in the tracked baseline skill.

Downloads use same-origin HTTP, reject redirects, stream to a private sibling file, verify size and SHA-256, and publish with a hard link that refuses existing destinations. Interrupted transfers remove temporary files. Requests have a two-minute timeout. Preserved files remain downloadable after VM destruction; the raw route remains private and faithful, while model-facing readers are bounded and credential-screened.

Restart the server and reconnect MCP clients to discover `read_worker_artifact` and the updated server instructions. Reopen `swarmforge status` for the artifact browser, or use `swarmforge artifacts list` / `swarmforge artifacts download ID --output PATH`.
