# Artifacts

Worker output is durable. A worker VM is the only copy of a worker's non-source output until
the coordinator copies it into private storage, so artifact preservation is a first-class
lifecycle stage: an artifact that was never preserved dies with the VM, and a task result
survives destruction but its reports, logs and profiles do not.

```text
worker workspace file
   │  (1) trusted guest helper: descriptor-relative O_NOFOLLOW open, bounded regular file
   │  (2) binary filesystem transport, byte stream with SHA-256, no exec output, no base64
   ▼
private coordinator storage  ──► ArtifactRecord (SQLite)  ──► list/metadata/read_artifact
   │                                        │
   │                                        └──► authenticated GET /artifacts/<id>/download
   ▼
finalization record: pending → collecting → preserved | failed | abandoned
```

No model participates. Preservation does not ask the worker to copy, summarize or encode
anything, works while OpenCode is dead, and never passes file bytes through command output.

## States, errors and retention

A worker has one **finalization record**, independent of its task outcome, so `completed`,
`failed` and `cancelled` keep meaning what they mean to existing clients:

| Stage | Meaning |
| --- | --- |
| `pending` | Preservation must still run for this worker. |
| `collecting` | Bytes are moving from the VM into storage. |
| `preserved` | Every required artifact is stored and checksum-verified. |
| `failed` | Collection failed or its automatic attempts were exhausted. The VM is retained. |
| `abandoned` | An operator explicitly discarded preservation, normally through forced destruction. |

Each **artifact record** carries `state` (`preserving`, `preserved`, `failed`), `attempts`,
`error`, `size`, `sha256`, `original_path`, `run_id` and `kind`. A partial transfer is never
visible as `preserved`: bytes land in a private staging file and the record is only marked
preserved after the transferred length and SHA-256 both match what the helper reported.
Repeating the same worker, run, path and content is idempotent, so a retry or a restart does
not create duplicates.

Every attempt is its own record, so a **recapture that changes content** publishes a new record
and marks the previous one superseded. Exactly one record per source is the published copy;
superseded records are history. `list_artifacts` lists published copies only, `get_artifact_metadata`
and `read_artifact` still resolve a superseded record by identifier while its bytes exist, and
the cumulative metrics in [OBSERVABILITY.md](OBSERVABILITY.md) count every attempt and every
verified copy because they are rebuilt from the append-only artifact event log.

Every attempt and outcome is also appended to a durable artifact event log, which is what the
cumulative counters in [OBSERVABILITY.md](OBSERVABILITY.md) are built from: a `_total` only grows,
while the stored-copy gauges describe the current state, because a recapture supersedes the copy
it replaces.

Failure reasons are recorded as short operator-facing text: a missing worker VM, a refused
path, a size, entry or depth limit, a checksum mismatch, a provider or transport error, or a
cancelled caller. Artifact contents, storage locations and credentials never appear in an
error, in metadata, in events or in metrics.

Every attempt and every settled collection also persists a durable event, because the record's
`attempts` field describes one collection cycle and cannot carry history:
`finalization.attempted` per claimed attempt, persisted before any effect so a restart re-entering
an interrupted attempt still leaves exactly one, and exactly one of `finalization.preserved`,
`finalization.failed` or `finalization.abandoned` per settled collection. Creating the record
announces nothing and a scheduled retry is not an outcome. Those events are the source of the
cumulative metrics in [OBSERVABILITY.md](OBSERVABILITY.md).

No automatic VM deletion policy is added. Completion and failure still retain the VM, and
destruction stays explicit. Normal destruction requires preservation to have settled
successfully; if it has not, destruction reports `recovery_required` instead of deleting
evidence. `force=true` is the explicit, acknowledged way to destroy anyway, and it records
the preservation as abandoned rather than leaving a half-finished stage behind.

Automatic retries use a persisted attempt count and an exponential backoff
(`SWARMFORGE_FINALIZATION_RETRY_MS` doubling per attempt). Once the attempts are exhausted
the worker stays retained and the lead can drive collection again with
`retry_worker_finalization`, or inspect the retained workspace with `list_worker_files` before
deciding. A deliberate retry supersedes any scheduled automatic one, resets the
attempt budget and runs exactly one attempt, so it never blocks on a backoff. It is a no-op once
a collection has succeeded (the records it produced are the answer and are not duplicated) and is
refused for a destroyed worker, a worker with no preservation record, an explicitly abandoned
record, an unavailable VM, and a collection that is already running. Forcing destruction records
an abandonment instead. A collection that cannot settle blocks normal destruction, so the worker
and its workspace are retained for inspection rather than deleted. Cancellation and forced destruction abort in-flight transfers before the
provider is asked to delete anything.

## Defaults and limits

| Setting | Default | Meaning |
| --- | --- | --- |
| `SWARMFORGE_ARTIFACT_DIR` | `artifacts` beside the database | Private storage root, set as an absolute path. A memory database uses temporary private storage. |
| `SWARMFORGE_ARTIFACT_MAX_BYTES` | `1073741824` | Maximum bytes for one captured file or archive. |
| `SWARMFORGE_ARTIFACT_MAX_ENTRIES` | `10000` | Maximum entries in one directory or snapshot. |
| `SWARMFORGE_ARTIFACT_MAX_DEPTH` | `32` | Maximum directory depth. |
| `SWARMFORGE_ARTIFACT_TIMEOUT_MS` | `120000` | Deadline for one capture. |
| `SWARMFORGE_FINALIZATION_MAX_ATTEMPTS` | `3` | Automatic collection attempts per worker. |
| `SWARMFORGE_FINALIZATION_RETRY_MS` | `2000` | Backoff between attempts. |
| `SWARMFORGE_ARTIFACT_CONCURRENCY` | `4` | Concurrent transfers and finalizations, including direct API calls. |

Manager-surface limits: `read_artifact` returns at most 32 KiB per call, list calls return at
most 100 records, and a single download response streams at most 8 MiB.

A capture that collects many records returns a page bounded by serialized bytes, not by a
record count, because records with 1024-byte paths are far larger than short ones. The response
carries `total` and `truncated`, plus `next: "list_artifacts"` when anything was cut; the cut
records are in storage and are retrieved with `list_artifacts`. A capture therefore never fails
with a response-too-large error after the bytes have already been captured. The budget is half
of the tool response ceiling because an MCP result carries its payload twice. `list_artifacts`
filters `state` on the returned page only: it does not change the repository's paging, so a
filtered page can be shorter than the requested limit and `next_offset` still refers to the
repository.

## Paths and allowed roots

Every path a lead or a task supplies is **workspace relative** and resolved against
`SWARMFORGE_WORKSPACE` only. A path is refused when it is empty, absolute, longer than 1024
bytes, deeper than 32 components, contains `..`, a backslash, a NUL or another control
character, or resolves to a symlink or a non-regular file. Task declarations accept direct
files and directories; a trailing `/**` means that directory, and any other wildcard is
rejected. A path that itself contains a configured credential is refused before any lookup.

The default collections are `.swarmforge/artifacts/**`, `.swarmforge/logs/**`,
`.swarmforge/result.json`, `.swarmforge/task.json` and `.swarmforge/metadata.json`, followed by
the guest's journal and Git-state diagnostics. All of them are optional: a worker that produced
none of them still settles preserved, while a declared `required` path that is absent fails the
collection. Full-workspace snapshots are never automatic for a successful task: they are explicit
through `snapshot_worker`, configured per task with `snapshot_on_failure`, or taken by an
operator.

## Faithful raw bytes versus safe excerpts

Stored bytes are faithful and private: capture copies the file as it is, including binary
content, and verifies it. What a model is shown is a deliberately smaller thing.

| Surface | What it returns | Bound |
| --- | --- | --- |
| `list_artifacts`, `get_artifact_metadata` | Metadata only: identifiers, path, filename, kind, size, SHA-256, state, attempts, error, timestamps. The listing returns published copies, not superseded history | 100 records per page (the repository itself allows up to 200) |
| `read_artifact` | Screened text excerpt of a byte range, or size, checksum and a download handle when the range is not text | 32 KiB per call |
| `preserve_artifact`, `snapshot_worker` | Captured records, with `total` and `truncated` | 100 records and 48 KiB of serialized metadata |
| `GET /artifacts/<artifact_id>/download` | Raw bytes, as an attachment | 8 MiB per response |
| `list_worker_files` | Live directory entries of a retained workspace, no contents, with `truncated` and `total` when the directory exceeds the configured entry bound | 100 entries per page |

Inline reads are credential screened: a range is refused when the bytes contain a configured
secret in any known encoded variant (including URL and base64 forms), and the window is widened
on both sides so a credential split across a chunk boundary is still detected. Only printable UTF-8 is inlined, and terminal
escapes are removed as whole sequences first, so a coloured terminal log reads as text with no
inert `[31m` fragment left behind and invisible or bidirectional code points are dropped. A
range is treated as binary only when it is mostly non-printable, and then reported as metadata
plus `download_path`, never as bytes or base64 in a tool response. Snapshots and other large
payloads are always fetched through the download route.

## Snapshots

`snapshot_worker` asks the guest helper for a bounded, regular-file-only `tar.gz` of the
workspace (or of the listed paths). Collecting a directory preserves each regular file in it and
archives any nested directory as its own snapshot artifact rather than dropping or flattening
it; a directory that would exceed the entry budget is **refused as incomplete** rather than
returned partially. `.git` and `node_modules` are excluded, source and output byte limits, entry
limits and depth limits all apply, symlinks and special files are skipped, and SwarmForge never
extracts an archive. The archive is one artifact: it is
listed and verified like any other, so a retained workspace can be recovered wholesale before
the VM is destroyed.

## Security

- Only authenticated, same-origin callers reach artifact bytes. The download shares the
  server's host, allowed-host, bearer-token and origin checks; without a token only loopback
  is served, as configured.
- Responses are `Content-Type: application/octet-stream`,
  `Content-Disposition: attachment`, `Cache-Control: no-store` and `X-Content-Type-Options:
  nosniff`, with a sanitized filename. A browser never renders artifact content inline and a
  shared cache never keeps it.
- Ranges are validated: exactly one range per response, integers only, no reversed or
  unsatisfiable span and no multi-range request. The advertised range is exactly what the
  response carries: the end is clipped to the last stored byte and to the per-response window,
  so `Content-Range` and `Content-Length` never promise bytes that do not exist. Unsatisfiable
  requests get `416` with `Content-Range: bytes */<size>`.
- A cancelled caller receives nothing; the caller signal is passed into the service so an
  abandoned request stops its transfer instead of holding one open.
- Artifact storage locations are never returned to a lead. Tool metadata is an explicit
  projection, so a future internal field cannot leak by accident.
- Storage, staging and the artifact database are private to the coordinator process; their
  backup and retention are operator responsibilities.

## End-to-end example

```json
{"name":"spawn_worker","arguments":{"team_id":"backend","task_id":"auth-code","prompt":"Implement authentication, write a report to .swarmforge/artifacts/report.md and persist the source change.","artifacts":[{"path":".swarmforge/artifacts/report.md","required":true}]}}
```

```json
{"name":"retry_worker_finalization","arguments":{"worker_id":"w-…"}}
{"finalization":{"state":"preserved","attempts":1},"artifacts":[{"artifact_id":"a-…","original_path":".swarmforge/artifacts/report.md","size":20481,"sha256":"…","state":"preserved"}]}
```

```json
{"name":"read_artifact","arguments":{"artifact_id":"a-…","offset":0,"length":4096}}
{"size":20481,"sha256":"…","binary":false,"returned_bytes":4096,"next_offset":4096,"truncated":true,"download_path":"/artifacts/a-…/download"}
```

```sh
# Raw bytes, same bearer token as /mcp, written straight to disk.
curl -fsS -H "Authorization: Bearer $SWARMFORGE_API_TOKEN" \
  -o report.md "http://127.0.0.1:8787/artifacts/a-…/download"
sha256sum report.md   # equals the recorded sha256
```

After that the worker may be destroyed normally; `list_artifacts` and the download route keep
working from storage.

`bun scripts/artifact-salvage-smoke.ts` exercises exactly this flow with the production guest
helper: a temporary guest directory whose every capture runs `src/providers/artifact-helper.py`
as a subprocess over the real raw byte streaming transport, a dead OpenCode service, a SQLite
database, normal destruction of the workspace and a checksum comparison. The run refuses to
report success unless it can see helper commands executed, guest staging left empty and the
checksum matching after destruction, and it prints which capture implementation it used. `bun scripts/artifact-salvage-smoke.ts --freestyle <vm-id>` performs the same
read-and-verify pass against one retained Freestyle VM without a worker model. It never destroys
the VM: it reads the live database through a consistent read-only snapshot taken with SQLite's
`VACUUM INTO`, redirects its own database path and `SWARMFORGE_ARTIFACT_DIR` into a private
temporary root, streams and hashes every download in bounded chunks, and prints only metadata and
a small text preview. Destroying a retained VM stays an explicit operator action, exercised
separately. A local filesystem run proves the coordinator and manager surfaces, not the
guest helper: the descriptor-relative capture itself is proven by the provider tests and by the
`--freestyle` mode.
