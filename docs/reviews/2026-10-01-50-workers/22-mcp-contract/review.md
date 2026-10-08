# SwarmForge review — MCP tool registration / input & output schemas / error handling / API contract consistency

- Exact target: `d428e0f730ed5649485732e95d39c32f5d6a8895` (`git rev-parse HEAD` verified in the disposable checkout)
- Reviewed branch state: `feature/binary-config-serve-20260930`
- Assigned baseline in `/workspace/repo`: `5672ead2a526e07fea9ed11e58b3725e42013527` (untouched, clean)
- Reviewer clone (disposable, outside the source checkout): `/tmp/rv` (bun 1.4.2 at `/tmp/bun14/bun-linux-x64/bun`)
- Scope reviewed: `src/mcp.ts`, `src/domain.ts` (schemas), `src/files.ts` (tool output shapes),
  `src/security.ts` (`publicWorker`, `Redactor` as applied to tool output), `src/coordinator.ts`
  (tool actions, `waitForStateChange`), `src/store.ts` (result/task/event payloads), `src/http.ts`
  (transport contract), `src/cli/client.ts` (first-party client of the contract), `docs/MCP-API.md`
- Delta note: `src/mcp.ts` and `docs/MCP-API.md` are unchanged between baseline and target, so the
  findings below are pre-existing code at the target, not regressions from the reviewed branch.
- Verdict: **FINDINGS** (1 MEDIUM, 3 LOW). No CRITICAL/HIGH issue reproduced in this scope.

## Finding 1 — MEDIUM: a documented idempotent `spawn_worker` retry is rejected as "different arguments"

- File/line (target): `src/coordinator.ts:185-190` (injects the config default before hashing) and
  `src/store.ts:71-74` (fingerprint over the merged object); surfaced to the client at
  `src/mcp.ts:57-63`; contract in `docs/MCP-API.md:29` and the tool description at `src/mcp.ts:73`.
- Trigger: a lead calls `spawn_worker` with `request_id` and **no** `timeout_seconds`; the reply is
  lost (client crash, timeout, 5xx). Before the lead retries, an operator changes
  `limits.default_timeout_seconds` (`SWARMFORGE_DEFAULT_TIMEOUT_SECONDS`, `src/config.ts:85`,
  `src/settings/load.ts:324-327`) and the process restarts against the same database. The retry sends
  byte-identical arguments.
- Consequence: the tool returns `isError: true` with `request_id already used with different
  arguments`, even though the arguments are identical. The idempotency key is permanently poisoned
  for the original arguments: the client can neither recover the original `worker_id` nor create a
  replacement under that key, and the rejection message is actively misleading (it implies a client
  bug). A lead that follows the documented retry rule is stuck, and the "safe retries" property
  advertised in the tool description (`src/mcp.ts:73`) and in `docs/MCP-API.md:29` does not hold.
- Reproduction (reproduced, exit 0, `tests/lifecycle.test.ts` untouched): two `Coordinator`s over one
  `Store(":memory:")` with `SWARMFORGE_DEFAULT_TIMEOUT_SECONDS` 600 then 1200, driven through a real
  MCP client/server pair. Same probe also reproduced the end-to-end tool error:
  `SPAWN2_RETRY isError=true [{"type":"text","text":"request_id already used with different arguments"}]`.
- Code trace: `coordinator.spawn` parses with `spawnSchema` (`src/domain.ts:29-36`, `timeout_seconds`
  optional), then builds `{...parsed, timeout_seconds: parsed.timeout_seconds ?? config default}`
  (`src/coordinator.ts:185-190`) and hands it to `Store.create`, which hashes
  `JSON.stringify(input)` including the server-chosen `timeout_seconds` (`src/store.ts:72-74`).
  A value the caller never supplied therefore participates in the request identity.
- Why existing guards/tests do not prevent it: the guard itself is what misfires. Every existing
  test retries with an unchanged config — `tests/lifecycle.test.ts:6-19` ("creation retries retain
  idempotency") and `tests/core.test.ts:87-114` both use a fixed `timeout_seconds`/config, so the
  only tested difference is a genuinely different `task_id`/`prompt`.
- Recommendation: compute and persist the fingerprint from the caller-supplied `Spawn` (i.e. before
  the config default is applied), or store the client arguments alongside `request_fingerprint` and
  compare those. Keep `timeout_seconds` as an effective value only.

## Finding 2 — LOW: `spawn_worker` returns the current state on a retry, not the documented "initial queued state"

- File/line (target): `src/mcp.ts:71-84` (`state: w.state` from the stored worker);
  contract text `docs/MCP-API.md:7` ("Worker ID, ownership, initial queued state").
- Trigger: retry a `spawn_worker` call with a live `request_id` after the coordinator has already
  advanced the worker.
- Consequence: the documented "initial queued state" is not what a retry returns. A client that
  treats `state !== "queued"` as a spawn failure (a natural reading of the documented contract) will
  report a spurious error on a legitimate, successful, idempotent retry.
- Reproduction (reproduced): same-args retry after one tick returned
  `{"worker_id":"w-6eac249b-...","task_id":"task","team_id":"team","state":"booting"}` while the
  first call returned `"state":"queued"`.
- Code trace: `Store.create` returns the pre-existing worker on a fingerprint match
  (`src/store.ts:79-84`), and the tool echoes `w.state` verbatim.
- Why existing guards/tests do not prevent it: `tests/lifecycle.test.ts:6-19` asserts only
  `worker_id` equality on a retry and never inspects the returned `state`.
- Recommendation: document that a retry returns the current state (and/or add an explicit
  `created: true|false` / `duplicate: true` field so a client can distinguish a fresh creation from
  a replay without inferring it from `state`).

## Finding 3 — LOW: schema violations are JSON-RPC `-32602`, not `isError`; the in-handler ZodError branch is unreachable and unredacted

- File/line (target): `src/mcp.ts:38-68` (handler, `z.ZodError -> "Invalid tool arguments"` at
  `src/mcp.ts:57-58`); contract text `docs/MCP-API.md:25` ("Tool failures set `isError`").
- Trigger: any call that violates a declared `inputSchema`, e.g. `get_worker` with no `worker_id`,
  `list_workers` with `limit: 0`, `spawn_worker` with `timeout_seconds: 604801`.
- Consequence: the documented error contract is wrong for the most common client error, and the
  only validation path clients actually reach bypasses `Redactor`. Observed messages are
  `MCP error -32602: Input validation error: Invalid arguments for tool get_worker: ...`. The
  first-party client `src/cli/client.ts:31-50` only inspects `isError`, so a client written against
  the documented contract gets an exception instead of a tool result.
- Reproduction (reproduced): 18 invalid-argument cases across 8 tools; every one returned
  `isError: true` in the *SDK* wrapper text but as a thrown JSON-RPC `-32602` error, and none
  reached the `"Invalid tool arguments"` branch.
- Why existing guards/tests do not prevent it: the MCP SDK validates `inputSchema` before the
  callback (`node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js`, `if (!tool.outputSchema)`
  at ~line 186 short-circuits only output validation; input validation happens earlier), so the
  hand-written branch can never fire. No test asserts the error surface of an invalid call.
- Security note (currently benign, verified): in 6 targeted cases the SDK/zod message did **not**
  echo the offending value, so no secret escaped. The gap is structural — the one path that
  validates untrusted client input is the one path that does not pass through
  `redactor.text(...)`.
- Recommendation: correct `docs/MCP-API.md:25` to state that schema violations surface as JSON-RPC
  `-32602` invalid params, remove the unreachable ZodError branch, and (defensively) either register
  a server-level error hook that redacts outgoing error text or keep input validation inside the
  handler for any rule that must be redacted.

## Finding 4 — LOW: `get_worker_artifact` collapses every failure into one message, and it is the only tool whose output skips redaction and the size cap

- File/line (target): `src/mcp.ts:194-223`, bare `catch {}` at `src/mcp.ts:215-221`; distinct
  underlying errors at `src/files.ts:5-10` ("Worker files unavailable"), `src/files.ts:11-22`
  ("Invalid relative artifact path"), `src/files.ts:32-40` ("Symlink artifact paths are not
  allowed"), `src/files.ts:70-71` ("Artifact path contains credentials");
  contract text `docs/MCP-API.md:31`.
- Trigger: any failed `get_worker_artifact` call — unknown `worker_id`, destroyed or VM-less worker,
  path traversal, symlink, a path that matches a configured secret, or a provider timeout.
- Consequence: the caller always receives `Artifact unavailable or invalid path`, so the three
  documented behaviours (traversal/symlink rejection, credential blocking, worker unavailable) are
  indistinguishable, and a transient provider failure is reported as a permanent-looking refusal.
  Reproduced: `{worker_id:"w-does-not-exist", path:"a.txt"}` and
  `{worker_id:"w-does-not-exist", path:"../escape"}` both returned the identical string.
- Code trace: `register(...)` in `src/mcp.ts:20-70` performs `redactor.value(...)` and the
  128 KiB response cap; `get_worker_artifact` is registered directly with `server.registerTool`
  (`src/mcp.ts:181-224`) and therefore has neither. No leak was observed — `files.artifact` already
  refuses a credential-shaped path (`src/files.ts:70-71`) and the handle only echoes the path, size
  and URI — so this is a hardening/contract gap, not a live disclosure.
- Why existing guards/tests do not prevent it: the `catch {}` has no discrimination at all;
  `tests/api.test.ts:101-127` asserts the *library* rejections via `files.artifact`/`files.readArtifact`
  directly and never asserts the tool's error text, and `tests/api.test.ts:185-192` likewise tests
  `WorkerFiles.artifacts` rather than the tool.
- Recommendation: map the known `WorkerFiles` messages to stable machine-readable codes (or pass the
  redacted message through, keeping one generic string only for traversal/symlink), and route this
  tool through the same `register()` helper so its output is redacted and size-capped like every
  other tool.

## Checked and found sound (no finding)

- 17 tools registered; names, required fields, defaults and bounds match `docs/MCP-API.md:5-23`
  (verified by dumping `listTools()` at the target).
- Bounded ranges: `resources/read` query parameters are untrusted (no schema) but `WorkerFiles.readArtifact`
  re-validates `Number.isSafeInteger`/range (`src/files.ts:83-91`). Reproduced: `offset=-1`,
  `offset=abc`, `offset` beyond 2^53, `length=0`, `length=99999999` all rejected
  ("Invalid artifact byte range"); duplicated query params fail closed at the template match.
- Nested artifact paths round-trip correctly through the resource template (percent-encoded
  `%2F` decoded once in `src/mcp.ts:329-336`).
- `wait_for_state_change` over the real HTTP transport returns on a durable event in ~150 ms and
  honours `timeout_ms=0` as a single check; cursor semantics (`next_cursor`) match the docs.
- Secrets are not exposed: `publicWorker` omits `server_password`/prompt/`endpoint`; tool output is
  redacted recursively; `get_worker_result` still returns the persisted result after
  `destroy_worker` (matches `docs/MCP-API.md:15`); `get_worker_logs` keeps audit events readable
  during provider outages.
- SSE `/events` ids and `wait_for_state_change` cursors share the same `events.id` sequence, so a
  cursor taken from one surface stays valid on the other (`docs/MCP-API.md:34`).

## Tests / probes actually run (no real cloud, model or infrastructure calls)

All commands ran in `/tmp/rv` with official Bun 1.4.2 (`/tmp/bun14/bun-linux-x64/bun`); the
repository `bun.lock` was not rewritten and no build was performed.

| Command | Exit | Result |
| --- | --- | --- |
| `bun test tests/api.test.ts tests/lifecycle.test.ts tests/wait.test.ts` | 0 | 53 pass, 0 fail, 209 assertions |
| `bun test review-probe/contract.probe.test.ts` (reviewer probe, 7 tests) | 0 | 7 pass, 0 fail |
| `bun test review-probe/contract2.probe.test.ts` (reviewer probe, 3 tests) | 0 | 3 pass, 0 fail |

Probe files live only in the disposable clone (`/tmp/rv/review-probe/`), use the repository's own
fake provider/agent from `tests/helpers.ts` and a `Bun.serve` listener on `127.0.0.1:0`; they were
not copied into `/workspace/repo` and are not part of any commit. Logs: `/workspace/.swarmforge/logs/`.

## Limitations

- Full suite was not run (reserved for the whole-suite reviewer); no packaging/build scope covered.
- The real Freestyle/OpenCode providers were not exercised (no credentials, no infra); tool outputs
  were validated against the fake provider only. Paths that depend on the real provider's
  `listFiles` entry shape were therefore not confirmed.
- Bun 1.4.2 had to be fetched into `/tmp` because the snapshot's Bun 1.3.14 cannot read this
  lockfile; no lockfile was modified.
- `git.workspace` remains `/workspace/repo` at the assigned baseline and is clean; this review made
  no source changes, no commits and no pushes.
