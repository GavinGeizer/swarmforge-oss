# Artifact quickstart

Hand work to a SwarmForge worker **in your own repository** and get the worker's output back as files instead of prose. Read this before trusting a worker's report.

> **[ARTIFACTS.md](ARTIFACTS.md) is the reference.** It owns the whole contract — states, every bound and limit, path and credential rules, raw-bytes-versus-excerpt split, snapshots, security, retention. This page is the operator path through it and does not repeat it.

**The one thing to understand:** the worker VM is the only copy of a worker's non-source output, so when the VM is destroyed, unpreserved files are gone and only the structured result survives. Preservation is a lifecycle stage that runs **without a model** — it never asks the worker to copy, summarise or encode anything, it works while OpenCode is dead, and file bytes never pass through command output or base64.

## 1. Configure the coordinator once

**No separate setup, no second configuration file.** Artifacts reuse the `.env` the coordinator already runs with: no new credentials and no additional service — storage is a private directory beside the database. The workers themselves still consume the Freestyle account and model endpoint you already hold, and those remain billable infrastructure. **Already have a working `.env`? Leave it alone:** `cp .env.example .env` is only for a first-time install with no `.env` yet, and copying it over a configured one overwrites credentials that already work.

| Variable | Meaning | Required? |
| --- | --- | --- |
| `SWARMFORGE_GIT_TREE` | Repository cloned into each worker workspace, ≤2048 bytes. The one value that must name *your* repo. | **Required** |
| `SWARMFORGE_ARTIFACT_DIR` | Private storage root, absolute. Use another volume than the database if the salvage copy must outlive a lost database. Backup and retention are yours. | Optional — defaults to `artifacts` beside the database |
| `SWARMFORGE_WORKSPACE` | Absolute workspace root in the VM. The provider clones to `<SWARMFORGE_WORKSPACE>/repo` and creates `.../.swarmforge/artifacts` and `.../logs`; also the boundary every artifact path resolves against. | Optional — defaults to `/workspace` |
| `SWARMFORGE_DB_PATH` | Private SQLite database. Must not be in a shared directory. | Optional — defaults to `./data/swarmforge.sqlite` |

The remaining `SWARMFORGE_ARTIFACT_*` and `SWARMFORGE_FINALIZATION_*` bounds are already listed with their defaults in `.env.example` and [ENVIRONMENT.md](ENVIRONMENT.md); leave them alone for a first run. Freestyle, the OpenAI-compatible endpoint and push mode are unchanged.

Retargeting an install that already runs? The repository is global configuration, not a per-worker parameter, so finish and destroy the old repository's workers, stop the server, change only the repository fields, and restart — see [Move the workers to another repository](../README.md#move-the-workers-to-another-repository).

## 2. Declare the task and where its files are

[`examples/artifact-task.json`](../examples/artifact-task.json) is a complete `spawn_worker` call, schema-valid against the shipped `spawnSchema` (verified by parsing its `arguments` with `src/domain.ts`): it declares `findings.json` `required`, `.swarmforge/artifacts/**` optional, and `snapshot_on_failure: true`.

**Paths are workspace relative.** The repository is cloned to `workspace/repo` in the VM, so a source file written *in* the repository is declared `repo/<name>`. The workspace root itself is `workspace/`, which is why a plain `findings.json` is a legal declaration.

**Keep generated output out of the repository.** The example asks for `findings.json` at the workspace root — one level *above* `repo/`, outside the Git checkout — precisely so "commit nothing and push nothing" leaves zero untracked dirt. A generated file inside `repo/` is exactly the dirt an operator then has to clean up, and it contradicts the task's own instruction. Anything longer than a summary belongs under `.swarmforge/artifacts/`, where the worker's own system prompt already points.

Every spawn also collects `.swarmforge/artifacts/**`, `.swarmforge/logs/**`, `.swarmforge/result.json`, `.swarmforge/task.json` and `.swarmforge/metadata.json`, all **optional** — a worker that produced none still preserves successfully. A full-workspace snapshot is never automatic for a successful task: it is opt-in via `snapshot_worker`, `snapshot_on_failure`, or an operator. `required: true` means the collection cannot succeed while that file is missing, refused or over-limit; `required: false` means an absent file is skipped and the collection still settles as `preserved`. Declare `findings.json` required only if the task genuinely cannot be salvaged without it — a required file the worker never wrote turns a usable partial result into `finalization.failed`.

## 3. Read the output back — no model in the loop

Retrieval is model-independent: the same routes work for a person with `curl`. [ARTIFACTS.md](ARTIFACTS.md#faithful-raw-bytes-versus-safe-excerpts) owns the per-tool table, every bound and every refusal.

```json
{"name":"list_artifacts","arguments":{"worker_id":"w-…","limit":100}}
{"size":20481,"sha256":"…","binary":false,"returned_bytes":4096,"next_offset":4096,"truncated":true,"download_path":"/artifacts/a-…/download"}
```

```sh
# Raw bytes, same bearer token as /mcp, written straight to disk.
curl -fsS -H "Authorization: Bearer $SWARMFORGE_API_TOKEN" \
  -o findings.json "http://127.0.0.1:8787/artifacts/a-…/download"
sha256sum findings.json   # equals the recorded sha256
```

`read_artifact` gives a screened text excerpt; the download route gives the exact bytes as an uncached, non-sniffable attachment, and is the only place binary content is served.

## 4. Destroy without losing the files

There is no automatic VM deletion policy — completion and failure both **retain** the VM. Normal `destroy_worker` requires preservation to have settled and otherwise reports `recovery_required` instead of deleting evidence; `force: true` is the acknowledged way to destroy anyway and records preservation as `abandoned`. After `preserved`, destroy normally: `list_artifacts` and the download route keep working from storage, because they never needed the VM. When the automatic attempts are exhausted the worker **stays retained**, and one deliberate collection can be driven by hand with `list_worker_files` and `retry_worker_finalization`; that retry supersedes any scheduled one and runs exactly one attempt, so it never blocks on a backoff. Full semantics and every refusal are in [ARTIFACTS.md](ARTIFACTS.md#states-errors-and-retention).

## 5. End to end

Send `examples/artifact-task.json`: it returns immediately with `worker_id`, `task_id`, `team_id`, `state` and **no handle for the bytes** — the worker's *report* is not the deliverable. When it settles, take `get_worker_result` **and** `list_artifacts`, treating the result JSON as a claim and the artifact as the evidence; `sha256sum` the download against `get_artifact_metadata`; then destroy normally and re-read. If the Git handoff itself is unavailable — no push server, provider unreachable, `preserve_artifact` refused — the salvage path still applies: collection runs through the guest helper over the raw byte transport, so it works with a dead OpenCode service and nothing asks a model to recover a file.

## Check the wiring

```sh
# The declared example is accepted by the real schema, not by eye.
bun -e 'const {spawnSchema}=await import("./src/domain.ts");const e=await Bun.file("examples/artifact-task.json").json();const p=spawnSchema.parse(e.arguments);console.log(p.artifacts,p.snapshot_on_failure)'

# Contracts exist and typecheck.
test -f src/artifacts.ts && test -f src/finalization.ts && echo both-planes-present
bun run check          # tsc --noEmit + biome
bun test tests/artifact-api.test.ts tests/artifact-download.test.ts tests/artifact-metrics.test.ts

# Artifact preservation end to end, locally or against one retained VM.
bun scripts/artifact-salvage-smoke.ts
bun scripts/artifact-salvage-smoke.ts --freestyle <vm-id>   # never destroys the VM
```

A local filesystem run proves the coordinator and manager surfaces, not the guest helper: the descriptor-relative capture is proven by the provider tests and by `--freestyle`. Final real-VM release verification is still pending. No new setup automation and no model-generated shell recovery: if a capture fails, a person reads `list_worker_files` and retries — a model is never asked to reconstruct a file.
