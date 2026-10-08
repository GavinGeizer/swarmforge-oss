# Usage notes (from live use)

Hands-on notes from driving SwarmForge through its MCP. Architecture lives in [ARCHITECTURE.md](ARCHITECTURE.md); this file is what was surprising in practice.

## What it is

A worker control plane: `spawn_worker` → Freestyle VM → OpenCode session → structured result in SQLite. Source durability is the external Git tree (`SWARMFORGE_GIT_TREE`). SwarmForge does not host Git, PRs, or inference.

## Connecting OpenCode

`bun start` serves Streamable HTTP at `http://127.0.0.1:8787/mcp` (bearer token required off loopback). In `opencode.json`:

```json
"mcp": {
  "swarmforge": {
    "type": "remote",
    "url": "http://127.0.0.1:8787/mcp",
    "headers": { "Authorization": "Bearer {env:SWARMFORGE_API_TOKEN}" }
  }
}
```

16 tools: lifecycle (`spawn_worker`, `get_worker`, `list_workers`, `send_worker_message`, `pause/resume/cancel/destroy_worker`), results/logs (`get_worker_result`, `get_worker_logs`), files (`list_worker_artifacts`, `get_worker_artifact`), aggregate (`get_task`, `list_tasks`, `get_team_status`, `get_swarm_status`).

## Observed lifecycle (one worker)

| Step | What happened |
| --- | --- |
| `spawn_worker` | Returns immediately with `state=queued` and a `worker_id`. No VM yet. |
| queued → provisioning → booting | Coordinator poll (2s). VM create + `prepare()` (mkdir, clone, write OpenCode config/service, systemd enable). |
| booting → ready | ~40s wall (includes `git clone` of `SWARMFORGE_GIT_TREE` into `/workspace/repo`). |
| ready → running → completed | Dispatch delivered to the OpenCode session; structured JSON result parsed and stored. |
| `send_worker_message` on a completed worker | Reopens `completed → ready`, same OpenCode session, new `run_id`. Not a new VM. |

## Gotchas

1. **`list_worker_artifacts.directory` is relative to `$SWARMFORGE_WORKSPACE/.swarmforge/artifacts`**, not the workspace. `directory=""` lists the artifacts root. Passing `.swarmforge/artifacts` looks for `.../artifacts/.swarmforge/artifacts` and 404s. Worker-written paths in `files_changed` are workspace-relative (`.swarmforge/artifacts/hello.txt`); MCP paths are artifacts-root-relative (`hello.txt`).

2. **`get_worker_artifact` returns a resource link, not bytes.** You get `uri: swarmforge://workers/<id>/artifacts/<path>?offset&length` plus size/next_offset. Call MCP `resources/read` for the base64 chunk (≤32 KiB). Use `next_offset` for large files.

3. **Nothing is destroyed automatically.** A completed worker keeps its billable VM until `destroy_worker`. Easy to leak VMs. `force=false` runs a Git safety check (dirty tree / local-only commits block cleanup); `force=true` overrides.

4. **`request_id` is spawn idempotency**, scoped per `team_id`. Same id + same args returns the original worker; same id + different args errors. Use it for retries.

5. **Follow-ups queue; they do not interrupt.** `send_worker_message` during a run waits for the current turn. Max 100 pending turns per worker.

6. **Results outlive VMs.** `get_worker_result` works after `destroy_worker`. Artifacts do not — collect them first.

7. **Config is not hot-reloaded.** Changes to `.env` / `src` need a server restart. `prepare()` is retried on each poll until ready; guest setup must be idempotent (clone is: skip if `repo/.git` exists).

8. **Teams are labels, not tenancy.** All leads share one bearer token. Prometheus `SWARMFORGE_METRICS_TEAMS` allowlists team labels; anything else is `other` (e.g. `exploration` did not appear as its own series).

9. **Artifact retrieval refuses credentials.** Paths and chunks are scanned; known secrets and `token=`/`password=` URL patterns block reads. Keep secrets out of artifacts.

10. **`SWARMFORGE_GIT_TREE`**: a clonable Git URL/path is cloned to `$SWARMFORGE_WORKSPACE/repo`. Prefix `none:` (or set `none`) to skip cloning and pass the value through as an opaque mount/prepared tree.

11. **Guest env boundary**: workers get `SWARMFORGE_GIT_TREE` (with `none:` stripped), workspace, model API key, OpenCode port. Never Freestyle tokens or the MCP bearer token.

## Typical loop

```
spawn_worker(task_id, prompt, request_id?)
  → poll get_worker / get_worker_logs until completed|failed
  → get_worker_result
  → list_worker_artifacts + get_worker_artifact + resources/read
  → optional send_worker_message (same session)
  → destroy_worker   # required to release the VM
```

Check `get_swarm_status` for leftover non-destroyed workers with VMs before walking away.
