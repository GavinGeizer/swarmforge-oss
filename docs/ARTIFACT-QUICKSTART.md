# Artifact quickstart

A one-page runbook for handing work to a SwarmForge worker in **another repository** and getting
the worker's output back as files instead of prose. Read this before trusting a worker's report.

> **Status: not yet integrated.** The behaviour below is implemented across three published
> branches — data plane `c5cfff6`, lifecycle `3244def`, manager API `2fdf813` — and none of them
> contains all three files (`2fdf813` and `3244def` have no `src/artifacts.ts`; `c5cfff6` has no
> `src/finalization.ts`; `c5cfff6` and `2fdf813` have no `artifacts`/`snapshot_on_failure` in
> `spawnSchema`). The integration branch does not yet contain any of them. Every command in this
> document is therefore **expected behaviour after the feature is integrated**, not a claim about
> `master` today. Do not advertise this runbook as "task ready" until
> [Verification](#verification-before-you-trust-this) passes.

## The one thing to understand

The worker VM is the only copy of a worker's non-source output. When the VM is destroyed, files
that were not preserved are gone — only the worker's structured result survives. Preservation is a
lifecycle stage that runs **without a model**: it does not ask the worker to copy, summarise or
encode anything, it works while OpenCode is dead, and file bytes never pass through command output
or base64.

```text
workspace/repo/findings.json          (inside the worker VM)
   │  guest helper: descriptor-relative O_NOFOLLOW open, bounded regular file
   │  binary transport: byte stream with SHA-256, no exec output, no base64
   ▼
private coordinator storage  ──► ArtifactRecord (SQLite)
   │                                 ├──► list_artifacts / get_artifact_metadata / read_artifact
   │                                 └──► authenticated GET /artifacts/<artifact_id>/download
   ▼
finalization record: pending → collecting → preserved | failed | abandoned
```

## 1. Configure the coordinator once

Required. There is no cloud account, no paid infrastructure and no separate setup program: the
coordinator clones a Git tree into a local workspace and preserves into local private storage.

| Variable | Meaning | Default |
| --- | --- | --- |
| `SWARMFORGE_GIT_TREE` | Repository to clone into each worker workspace. Required, ≤2048 bytes. | — |
| `SWARMFORGE_GIT_PUSH_MODE` | Repository access: `none`, `ssh` or `github-app`. With `ssh`: `SWARMFORGE_GIT_PUSH_URL`, `SWARMFORGE_GIT_SSH_KEY_PATH`, `SWARMFORGE_GIT_SSH_KNOWN_HOSTS_PATH` are required. With `github-app`: `SWARMFORGE_GITHUB_APP_ID`, `SWARMFORGE_GITHUB_INSTALLATION_ID`, `SWARMFORGE_GITHUB_PRIVATE_KEY_PATH`, `SWARMFORGE_GITHUB_REPOSITORY` are required and `SWARMFORGE_GIT_TREE` must be that repository's `https://github.com/<repo>[.git]`. | — |
| `SWARMFORGE_WORKSPACE` | Absolute workspace root inside the worker VM. The provider clones the Git tree to `<SWARMFORGE_WORKSPACE>/repo` and creates `<SWARMFORGE_WORKSPACE>/.swarmforge/artifacts` and `.../logs`. It is also the boundary every artifact path is resolved against. | — |
| `SWARMFORGE_DB_PATH` | Private SQLite database. Must not be inside a shared directory. | `./data/swarmforge.sqlite` |
| `SWARMFORGE_ARTIFACT_DIR` | Private artifact storage root, absolute. The database, staging files and artifact bytes are private to the coordinator process; their backup and retention are yours. | `artifacts` beside the database |

Set `SWARMFORGE_ARTIFACT_DIR` to a different volume than `SWARMFORGE_DB_PATH` if you want the
salvage copy to outlive a lost database. Nothing else is required for a first run.

Bounds you rarely need to change, with their defaults: `SWARMFORGE_ARTIFACT_MAX_BYTES` `1073741824`
(1 GiB per file or archive), `SWARMFORGE_ARTIFACT_MAX_ENTRIES` `10000`,
`SWARMFORGE_ARTIFACT_MAX_DEPTH` `32`, `SWARMFORGE_ARTIFACT_TIMEOUT_MS` `120000` (deadline for one
capture), `SWARMFORGE_ARTIFACT_CONCURRENCY` `4`,
`SWARMFORGE_FINALIZATION_MAX_ATTEMPTS` `3`, `SWARMFORGE_FINALIZATION_RETRY_MS` `2000` (doubling
per attempt, capped at one hour).

## 2. Declare the task and where its files are

`examples/artifact-task.json` is a complete, schema-valid `spawn_worker` call. Copy it, change
`task_id` and the paths.

- `team_id` (default `default`), `task_id` (required), `role` (default `coder`), `prompt`
  (required, ≤32000 bytes), `timeout_seconds` (optional), `request_id` (optional, for safe retries).
- `artifacts` — optional array, at most 100 entries, default `[]`. Each entry is
  `{ "path": "<workspace-relative path>", "required": <bool, default false> }`. Do **not** send
  `directory`; it is derived from a trailing `/**`.
- `snapshot_on_failure` — boolean, default `false`. Set it when a failed run's workspace is worth
  keeping whole.

**Paths are workspace-relative.** The repository is cloned to `workspace/repo` inside the VM, so a
file the worker writes inside the repository is declared `repo/findings.json`. The worker's own
output directory is `workspace/.swarmforge/artifacts`, which is where a lead's prompt should tell the
worker to write long reports. Both are workspace-relative in the declaration, which is why an
absolute path or `..` is refused.

Every spawn collects these defaults, all **optional**, so a worker that produced none of them still
preserves successfully:

```text
.swarmforge/artifacts/**   .swarmforge/logs/**
.swarmforge/result.json    .swarmforge/task.json    .swarmforge/metadata.json
```

A full-workspace snapshot is never automatic for a successful task. It is opt-in:
`snapshot_worker`, `snapshot_on_failure`, or an operator.

### required vs optional

`required: true` means the collection cannot succeed while that file is missing, refused or
over-limit. `required: false` means an absent file is skipped and the collection still settles as
`preserved`. Declare `repo/findings.json` required only if the task genuinely cannot be salvaged
without it — a required file the worker never wrote turns a usable partial result into
`finalization.failed`.

## 3. Read the output back — no model in the loop

Retrieval is model-independent: the same routes work for a person with `curl`.

| Tool / route | Returns | Bound |
| --- | --- | --- |
| `list_artifacts` | Metadata only. `worker_id`, `task_id`, `state` filters; `offset`/`limit`. `state` filters the returned page without changing repository paging, so a filtered page can be shorter than `limit` while `next_offset` still refers to the repository. | 100 records |
| `get_artifact_metadata` | One record: size, SHA-256, state, attempts, error, `original_path`, `run_id`. | — |
| `preserve_artifact` | Capture one file or directory on demand (`worker_id`, `path`, `kind`, `run_id`). | 100 records, 48 KiB metadata |
| `read_artifact` | Credential-screened text excerpt of a byte range, or metadata plus `download_path` when the range is binary. | 32 KiB per call |
| `snapshot_worker` | Bounded regular-file-only `tar.gz` of the workspace, `.git` and `node_modules` excluded. | as above |
| `list_worker_files` | Live directory entries of a **retained** workspace. No contents. `truncated`/`total` past the entry bound. | 100 entries |
| `retry_worker_finalization` | One deliberate re-collection attempt for a retained worker. | — |
| `GET /artifacts/<artifact_id>/download` | Raw bytes as an attachment. | 8 MiB per response |

```json
{"name":"list_artifacts","arguments":{"worker_id":"w-…","limit":100}}
```

```json
{"name":"read_artifact","arguments":{"artifact_id":"a-…","offset":0,"length":4096}}
{"size":20481,"sha256":"…","binary":false,"returned_bytes":4096,"next_offset":4096,"truncated":true,"download_path":"/artifacts/a-…/download"}
```

```sh
# Raw bytes, same bearer token as /mcp, written straight to disk.
curl -fsS -H "Authorization: Bearer $SWARMFORGE_API_TOKEN" \
  -o findings.json "http://127.0.0.1:8787/artifacts/a-…/download"
sha256sum findings.json   # equals the recorded sha256
```

Faithful raw bytes versus safe excerpts is a deliberate split. Stored bytes are exact, including
binary content, and are served only from the authenticated download route: `application/octet-stream`,
`Content-Disposition: attachment`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`. A
browser never renders artifact content inline. An inline `read_artifact` range is refused when the
bytes contain a configured secret in any known encoded variant (plain, URL-encoded, base64), and the
screening window is widened on both sides so a credential split across a chunk boundary is still
detected. Only printable UTF-8 is inlined; terminal escapes are removed as whole sequences and
invisible or bidirectional code points are dropped. Binary ranges come back as metadata plus
`download_path` — never as bytes or base64 in a tool response. Storage locations are never returned
to a lead, and contents, locations and credentials never appear in an error, event or metric.

Path safety is enforced twice, on declaration and on open: a path is refused when it is empty,
absolute, longer than 1024 bytes, deeper than 32 components, contains `..`, a backslash, a NUL or
another control character, or resolves to a symlink or a non-regular file. Task declarations accept
direct files and directories; a trailing `/**` means that directory, and any other wildcard is
rejected. A path containing a configured credential is refused before any lookup. The capture root
comes from configuration, never from a request, and the whole VM filesystem is never a valid root.

## 4. Destroy the worker without losing the files

There is no automatic VM deletion policy. Completion and failure both **retain** the VM.

- Normal `destroy_worker` requires preservation to have settled. If it has not, destruction reports
  `recovery_required` instead of deleting evidence.
- `destroy_worker` with `force: true` is the explicit, acknowledged way to destroy anyway. It records
  preservation as `abandoned` rather than leaving a half-finished stage behind.
- After `preserved`, destroy normally. `list_artifacts` and the download route keep working from
  storage; they do not need the VM.

Finalization states: `pending` → `collecting` → `preserved` | `failed` | `abandoned`.
Artifact record states: `preserving`, `preserved`, `failed`.

When automatic attempts are exhausted (`SWARMFORGE_FINALIZATION_MAX_ATTEMPTS`, default 3, with
`SWARMFORGE_FINALIZATION_RETRY_MS` doubling per attempt) the worker **stays retained** and you can
still act:

```json
{"name":"list_worker_files","arguments":{"worker_id":"w-…","path":"repo"}}
{"name":"retry_worker_finalization","arguments":{"worker_id":"w-…"}}
```

A deliberate retry supersedes any scheduled automatic one, resets the attempt budget and runs
exactly one attempt, so it never blocks on a backoff. It is a no-op once collection has succeeded,
and is refused for a destroyed worker, a worker with no preservation record, an explicitly abandoned
record, an unavailable VM, or a collection already running.

A partial transfer is never visible as `preserved`: bytes land in a private staging file and the
record is marked preserved only after both the transferred length and the SHA-256 match what the
helper reported. Repeating the same worker, run, path and content is idempotent. A capture that
collects many records pages by serialized bytes rather than record count and returns `total`,
`truncated` and `next: "list_artifacts"` rather than failing after the bytes are already captured.

## 5. End-to-end: from another repo to a verifiable file

1. Configure section 1 and start the coordinator. No new program, no preflight step.
2. Send `examples/artifact-task.json` as `spawn_worker`. It declares `repo/findings.json`
   `required`, optional `.swarmforge/artifacts/**`, and `snapshot_on_failure: true`.
3. `spawn_worker` returns immediately with `worker_id`, `task_id`, `team_id`, `state` — and no
   request handle for the bytes. The worker's *report* is not the deliverable.
4. Wait for the run to settle, then `get_worker_result` **and** `list_artifacts`. Treat the result
   JSON as a claim and the artifact as the evidence.
5. If handoff is unavailable (no handoff server, provider unreachable, `preserve_artifact` refused),
   the salvage path still applies: nothing asks a model to recover the file. Collection runs through
   the guest helper over the raw byte transport, so it works with a dead OpenCode service, and a lost
   run is recorded as a preservation failure with `error: "VM disappeared; local workspace is lost"`
   rather than a silently absent workspace.
6. `read_artifact` on the `findings.json` record returns a screened text excerpt. For the whole file
   use the download route above and compare `sha256sum` with `get_artifact_metadata`.
7. `destroy_worker` normally. The checksum still matches and `read_artifact` still answers, because
   both read private storage and never needed the VM.

## Initial checklist

- [ ] `SWARMFORGE_GIT_TREE`, `SWARMFORGE_WORKSPACE`, `SWARMFORGE_DB_PATH` set; push mode and its
      companions complete.
- [ ] `SWARMFORGE_ARTIFACT_DIR` absolute, private, and not shared.
- [ ] Declared paths are workspace-relative (`repo/…` for repository files,
      `.swarmforge/artifacts/…` for worker output); no `directory` key; `required` chosen per file.
- [ ] `snapshot_on_failure` set only where a failed workspace is worth keeping.
- [ ] After the run: `get_worker_result` **and** `list_artifacts`, then `sha256sum` on the download.

## Verification before you trust this

These are the checks to run once the feature is integrated; they are not a claim that they have been
run. Nothing in this document has been executed end to end against a live worker VM.

```sh
# Contracts exist and typecheck.
git merge-base --is-ancestor c5cfff6 HEAD && echo data-plane-present
git merge-base --is-ancestor 3244def HEAD && echo lifecycle-present
git merge-base --is-ancestor 2fdf813 HEAD && echo manager-api-present
test -f src/artifacts.ts && test -f src/finalization.ts && echo both-planes-present
bun run check          # tsc --noEmit + biome
bun test               # includes tests/artifacts.test.ts, tests/finalization.test.ts,
                      # tests/artifact-api.test.ts when those land on the integration branch

# The declared example is accepted by the real schema, not by eye.
bun -e 'const {spawnSchema}=await import("./src/domain");const e=await Bun.file("examples/artifact-task.json").json();const p=spawnSchema.parse(e.arguments);console.log(p.artifacts,p.snapshot_on_failure)'

# Artifact preservation over the real guest helper, end to end.
bun scripts/artifact-salvage-smoke.ts
bun scripts/artifact-salvage-smoke.ts --freestyle <vm-id>   # one retained VM, never destroys it
```

The smoke run refuses to report success unless it can see helper commands executed, guest staging
left empty and the checksum matching after destruction, and it prints which capture implementation
it used. A local filesystem run proves the coordinator and manager surfaces, not the guest helper:
the descriptor-relative capture is proven by the provider tests and by the `--freestyle` mode.

Boundaries this document deliberately does not cross: no cloud account, no paid infrastructure, no
new setup automation, and no model-generated shell recovery. If a capture fails, a person reads
`list_worker_files` and retries — a model is never asked to reconstruct a file.