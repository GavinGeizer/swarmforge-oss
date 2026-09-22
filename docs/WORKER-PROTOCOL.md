# Worker protocol

The external snapshot supplies the OS, OpenCode, Git, Python 3, Bash, systemd, repository access and task tools. SwarmForge creates metadata directories, a root-only launcher/configuration under `/opt/swarmforge`, and an OpenCode systemd service. A unique password protects the provider TLS endpoint.

The bootstrap identifies the worker/task/run and starting workspace. Unless `SWARMFORGE_GIT_TREE` is prefixed with `none`, SwarmForge clones it to `$SWARMFORGE_WORKSPACE/repo` before OpenCode starts and the bootstrap points there. With the `none` prefix the value is passed through as an opaque mount/prepared tree and workers may clone or use mounts themselves. The lead's prompt remains the task.

The model is configured as `swarmforge/<SWARMFORGE_MODEL_NAME>` using OpenCode's `@ai-sdk/openai-compatible` provider. The service passes `SWARMFORGE_MODEL_API_KEY` to OpenCode via environment interpolation. Provider credentials, MCP access tokens and other workers' secrets are not supplied. Snapshot contents must uphold this same boundary.

OpenCode is asked to return exactly one JSON object matching the result schema in its system prompt. SwarmForge parses the completed assistant text and also accepts `AssistantMessage.structured` when available. It avoids OpenCode's JSON Schema output-format field because OpenCode 1.18.31 rejects that field when serializing session history, even after successful generation. Workers must also atomically write `/workspace/.swarmforge/result.json` (or the configured workspace equivalent):

```json
{
  "worker_id": "w-...",
  "task_id": "auth-code",
  "run_id": "run UUID from bootstrap",
  "status": "completed",
  "summary": "Implemented and tested authentication.",
  "files_changed": ["src/auth.ts"],
  "tests": {"ran": true, "passed": true, "command": "bun test", "summary": "42 passed"},
  "git": {"workspace": "/workspace/repo", "branch": "auth", "commit": "abc123", "dirty": false, "persisted": true},
  "warnings": [],
  "needs_followup": false,
  "followup_reason": null
}
```

Only `status` (`completed` or `failed`) and a nonempty `summary` are intrinsically required; filesystem fallback additionally requires the current `run_id`, rejecting stale results from earlier turns. Optional Git fields do not apply to all work. Tests and persistence claims must reflect actual actions. Schema bounds limit details, file lists and warnings; the validated result is capped at 60 KiB. Put larger reports in artifacts. Do not include credentials in any output.

Place reports, benchmarks, screenshots and profiles under `.swarmforge/artifacts/`; task log files may use `.swarmforge/logs/`. Service logs are collected through journald. Structured results persist in SQLite; source persistence belongs to the external Git location. Commit and push/save according to that external workflow before reporting durable completion. A local commit alone is insufficient if the VM is the only copy.

Follow-ups retain the same OpenCode session. Pausing freezes the VM, cancellation stops work while retaining disk evidence, and destruction is explicit. Worker-to-worker collaboration is directed by the lead through the external Git tree and ordinary follow-up instructions.
