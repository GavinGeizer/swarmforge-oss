# Artifact quickstart

A short runbook for handing work to a SwarmForge worker **in another repository** and getting the
worker's output back as files instead of prose. Read this before trusting a worker's report.

> **Integration status on this branch: not verified yet.** The manager surface is merged
> (`src/mcp.ts`, `src/http.ts`, `src/metrics.ts`, the artifact tests, the smoke script, this page) but
> the capture data plane and the finalization lifecycle are **not**. Absent here:
> `src/artifacts.ts`, `src/artifact-store.ts`, `src/providers/artifact-helper.py`,
> `src/finalization.ts`, `tests/local-artifact-provider.ts`, `Coordinator.artifacts`,
> `Worker.finalization`, the `SWARMFORGE_ARTIFACT_*` / `SWARMFORGE_FINALIZATION_*` settings, and
> `spawnSchema.artifacts` / `spawnSchema.snapshot_on_failure`.
>
> Three consequences worth knowing before you send anything:
>
> - `spawnSchema` is a Zod object, which **strips unknown keys**. A spawn that sends `artifacts` today
>   is accepted and its declarations are silently **discarded**, not refused. Verified: parsing
>   `examples/artifact-task.json` with the current `src/domain.ts` yields `team_id, task_id, role,
>   prompt, timeout_seconds` and nothing else.
> - `bun run check` does not pass — 71 type errors, all consequences of the missing surfaces — and
>   `tests/artifact-*.test.ts` and `scripts/artifact-salvage-smoke.ts` cannot even be loaded.
> - Nothing here has been run against a live worker VM.
>
> Every command below is **expected behaviour once those branches merge**, not a claim about this
> branch. Do not advertise it as "task ready" until [Verify](#verify-before-you-trust-this) passes.
> [README.md](../README.md) documents what this branch does run.

## The one thing to understand

The worker VM is the only copy of a worker's non-source output. When the VM is destroyed, files
that were not preserved are gone — only the worker's structured result survives. Preservation is a
lifecycle stage that runs **without a model**: it does not ask the worker to copy, summarise or
encode anything, it works while OpenCode is dead, and file bytes never pass through command output
or base64.

**[ARTIFACTS.md](ARTIFACTS.md) is the reference**: it owns the full contract — states, every bound
and limit, path and credential rules, raw-bytes-versus-excerpt split, snapshots, security and the
retention/abandonment rules. This page is the operator path through it and deliberately does not
repeat it.

## 1. Configure the coordinator once

**There is no separate setup.** You already have a `.env` for the coordinator; artifacts need no new
credentials, no cloud account and no paid infrastructure. In fact the repository is the only value
you have to change — everything else already has a working default:

| Variable | Meaning | Required? |
| --- | --- | --- |
| `SWARMFORGE_GIT_TREE` | Repository to clone into each worker workspace, ≤2048 bytes. This is the one value that must name *your* repo. | **Required** |
| `SWARMFORGE_ARTIFACT_DIR` | Private artifact storage root, absolute. Set it on a different volume than the database if the salvage copy must outlive a lost database. Backup and retention are yours. | Optional — defaults to `artifacts` beside the database |
| `SWARMFORGE_WORKSPACE` | Absolute workspace root inside the worker VM. The provider clones to `<SWARMFORGE_WORKSPACE>/repo` and creates `<SWARMFORGE_WORKSPACE>/.swarmforge/artifacts` and `.../logs`. Also the boundary every artifact path resolves against. | Optional — defaults to `/workspace` |
| `SWARMFORGE_DB_PATH` | Private SQLite database. Must not be inside a shared directory. | Optional — defaults to `./data/swarmforge.sqlite` |

The remaining artifact and finalization knobs (`SWARMFORGE_ARTIFACT_MAX_BYTES`,
`SWARMFORGE_ARTIFACT_MAX_ENTRIES`, `SWARMFORGE_ARTIFACT_MAX_DEPTH`,
`SWARMFORGE_ARTIFACT_TIMEOUT_MS`, `SWARMFORGE_ARTIFACT_CONCURRENCY`,
`SWARMFORGE_FINALIZATION_MAX_ATTEMPTS`, `SWARMFORGE_FINALIZATION_RETRY_MS`) are already listed,
with their defaults, in `.env.example` and in [ENVIRONMENT.md](ENVIRONMENT.md). Leave them alone
for a first run. Freestyle, the OpenAI-compatible endpoint and push mode are unchanged.

## 2. Declare the task and where its files are

`examples/artifact-task.json` is a complete `spawn_worker` call. It is **schema-valid against the
lifecycle branch's `spawnSchema`** (verified by parsing it with that branch's `src/domain.ts`); on
this branch the `artifacts` and `snapshot_on_failure` keys are stripped, as the status note says. It
declares `findings.json` `required` and `.swarmforge/artifacts/**` optional, with
`snapshot_on_failure: true`.

**Paths are workspace relative.** The repository is cloned to `workspace/repo` inside the VM, so a
source file the worker writes in the repository is declared `repo/<name>`. The workspace root itself
is `workspace/`, which is why a plain `findings.json` is a legal declaration.

**Keep generated output out of the repository.** The shipped example asks for `findings.json` at the
workspace root — one level *above* `repo/` — precisely so that "commit nothing and push nothing"
leaves zero untracked repository dirt. A generated file written inside `repo/` is exactly the untracked
dirt an operator then has to clean up, and it contradicts the task's own instruction. Anything longer
than a summary belongs under `.swarmforge/artifacts/`, which is where the worker's own system prompt
already directs non-source output.

Every spawn also collects these defaults, all **optional**, so a worker that produced none of them
still preserves successfully:

```text
.swarmforge/artifacts/**   .swarmforge/logs/**
.swarmforge/result.json    .swarmforge/task.json    .swarmforge/metadata.json
```

A full-workspace snapshot is never automatic for a successful task: it is opt-in through
`snapshot_worker`, `snapshot_on_failure`, or an operator.

`required: true` means the collection cannot succeed while that file is missing, refused or
over-limit; `required: false` means an absent file is skipped and the collection still settles as
`preserved`. Declare `findings.json` required only if the task genuinely cannot be salvaged without
it — a required file the worker never wrote turns a usable partial result into `finalization.failed`.

## 3. Read the output back — no model in the loop

Retrieval is model-independent: the same routes work for a person with `curl`.
[ARTIFACTS.md](ARTIFACTS.md#faithful-raw-bytes-versus-safe-excerpts) owns the per-tool table, every
bound and every refusal; this is the whole operator loop.

```json
{"name":"list_artifacts","arguments":{"worker_id":"w-…","limit":100}}
{"name":"read_artifact","arguments":{"artifact_id":"a-…","offset":0,"length":4096}}
{"size":20481,"sha256":"…","binary":false,"returned_bytes":4096,"next_offset":4096,"truncated":true,"download_path":"/artifacts/a-…/download"}
```

```sh
# Raw bytes, same bearer token as /mcp, written straight to disk.
curl -fsS -H "Authorization: Bearer $SWARMFORGE_API_TOKEN" \
  -o findings.json "http://127.0.0.1:8787/artifacts/a-…/download"
sha256sum findings.json   # equals the recorded sha256
```

`read_artifact` gives a screened text excerpt; the download route gives the exact bytes as an
uncached, non-sniffable attachment, and that is the only place binary content is served.

## 4. Destroy the worker without losing the files

There is no automatic VM deletion policy: completion and failure both **retain** the VM.

- Normal `destroy_worker` requires preservation to have settled. If it has not, destruction reports
  `recovery_required` instead of deleting evidence.
- `destroy_worker` with `force: true` is the explicit, acknowledged way to destroy anyway. It records
  preservation as `abandoned` rather than leaving a half-finished stage behind.
- After `preserved`, destroy normally. `list_artifacts` and the download route keep working from
  storage; they never needed the VM.
- When the automatic attempts are exhausted the worker **stays retained**, and one more deliberate
  collection can be driven by hand:

```json
{"name":"list_worker_files","arguments":{"worker_id":"w-…","path":"repo"}}
{"name":"retry_worker_finalization","arguments":{"worker_id":"w-…"}}
```

The retry supersedes any scheduled one and runs exactly one attempt, so it never blocks on a backoff.
Full semantics, and every case it is refused for, are in
[ARTIFACTS.md](ARTIFACTS.md#states-errors-and-retention).

## 5. End-to-end: from another repo to a verifiable file

1. Point `SWARMFORGE_GIT_TREE` at your repository, fill the six values in
   [ENVIRONMENT.md](ENVIRONMENT.md), and start the coordinator. No new program, no preflight step.
2. Send `examples/artifact-task.json` as `spawn_worker`. It returns immediately with `worker_id`,
   `task_id`, `team_id`, `state` — and no handle for the bytes. The worker's *report* is not the
   deliverable.
3. Wait for the run to settle, then `get_worker_result` **and** `list_artifacts`. Treat the result
   JSON as a claim and the artifact as the evidence.
4. `sha256sum` the download and compare it with `get_artifact_metadata`.
5. `destroy_worker` normally. The checksum still matches and `read_artifact` still answers.

If the handoff itself is unavailable — no push server, provider unreachable, `preserve_artifact`
refused — the salvage path still applies: nothing asks a model to recover the file. Collection runs
through the guest helper over the raw byte transport, so it works with a dead OpenCode service.

## Initial checklist

- [ ] `SWARMFORGE_GIT_TREE` names your repository; push mode and its companions are complete. Every
      other value in `.env` is the one the coordinator already runs with.
- [ ] `SWARMFORGE_ARTIFACT_DIR` set if the salvage copy must outlive a lost database; otherwise the
      default directory beside the database is fine.
- [ ] Declared paths are workspace-relative and **outside the repository** unless the file really is
      source; no `directory` key; `required` chosen per file.
- [ ] `snapshot_on_failure` set only where a failed workspace is worth keeping.
- [ ] After the run: `get_worker_result` **and** `list_artifacts`, then `sha256sum` on the download.

## Verify before you trust this

These are the checks to run once the feature is integrated; they are **not** a claim that they have
been run on this branch.

```sh
# The declared example is accepted by the real schema, not by eye.
bun -e 'const {spawnSchema}=await import("./src/domain");const e=await Bun.file("examples/artifact-task.json").json();const p=spawnSchema.parse(e.arguments);console.log(p.artifacts,p.snapshot_on_failure)'

# Contracts exist and typecheck.
test -f src/artifacts.ts && test -f src/finalization.ts && echo both-planes-present
test -f tests/local-artifact-provider.ts && echo guest-fixture-present
bun run check          # tsc --noEmit + biome
bun test               # includes tests/artifact-api.test.ts, tests/artifact-download.test.ts,
                      # tests/artifact-metrics.test.ts, tests/artifacts.test.ts,
                      # tests/finalization.test.ts once those land

# Artifact preservation over the real guest helper, end to end.
bun scripts/artifact-salvage-smoke.ts
bun scripts/artifact-salvage-smoke.ts --freestyle <vm-id>   # one retained VM, never destroys it
```

A local filesystem run proves the coordinator and manager surfaces, not the guest helper: the
descriptor-relative capture is proven by the provider tests and by the `--freestyle` mode.

Boundaries this document deliberately does not cross: no cloud account, no paid infrastructure, no
new setup automation, and no model-generated shell recovery. If a capture fails, a person reads
`list_worker_files` and retries — a model is never asked to reconstruct a file.
