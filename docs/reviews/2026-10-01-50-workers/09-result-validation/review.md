# Review: result parsing / schema bounds / fallback identity / stale rejection

**Target (exact):** `d428e0f730ed5649485732e95d39c32f5d6a8895` (branch `feature/binary-config-serve-20260930`, repo `GavinGeizer/swarmforge-oss`)
**Reviewer checkout:** disposable detached clone at `/tmp/sfrev/repo` (`git rev-parse HEAD` = `d428e0f730ed5649485732e95d39c32f5d6a8895`)
**Assigned workspace:** `/workspace/repo` left untouched at baseline `5672ead2a526e07fea9ed11e58b3725e42013527`, branch `swarmforge/repo-review-50-20260930/09-result-validation/...`, `git status --porcelain` empty.
**Toolchain:** official Bun 1.4.2 unpacked under `/tmp/bun142` (the preinstalled 1.3.14 cannot read `lockfileVersion` 2). Lockfile untouched; `bun install --frozen-lockfile` in the /tmp clone only.
**Verdict: FINDINGS** (1 MEDIUM reproduced, 1 LOW reproduced, 1 LOW partial-confidence).

## Scope reviewed

`src/domain.ts` (`resultSchema`, `identify`-related identity fields), `src/coordinator.ts` (`monitor`, `identify`, `fallback`, `complete`, `step` catch/retry), `src/store.ts` (`finish`, `result`, `dispatches`, `enqueue`), `src/mcp.ts` (`get_worker_result`), `src/providers/opencode.ts` (`structured ?? parseJsonText`, `bootstrap` schema emission), `src/security.ts` (`Redactor`), `src/safety.ts` (`inspectPersistence` use of `result.git.workspace`), `docs/WORKER-PROTOCOL.md` result contract. Existing tests read: `tests/lifecycle.test.ts`, `tests/core.test.ts`, `tests/session-status.test.ts`, `tests/helpers.ts`.

---

## F1 — MEDIUM — A schema-valid result is discarded at completion when Git push adds metadata, and the push is then retried in a tight loop

**Location:** `src/coordinator.ts:703` (git metadata merged into the result) and `src/coordinator.ts:707` (`r = resultSchema.parse(redactorFor(this).value(r));`), with the bound at `src/domain.ts:71-73`; amplifying retry at `src/coordinator.ts:510-525`.

**Trigger:** `SWARMFORGE_GIT_PUSH_MODE` is `github-app` or `ssh` (the default is `none`) **and** the worker's structured result serializes to between ~61,259 and 61,440 bytes — i.e. within ~181 bytes of the documented 60 KiB cap. The worker prompt (`src/providers/opencode.ts:47-52`) never states the cap (see F2), so a worker that fills the advertised per-field bounds lands here.

**Root cause:** the 60 KiB `.refine` is applied to two *different* values. Ingest validates the agent payload (`src/coordinator.ts:589` `safeParse`, or `src/coordinator.ts:684` in `fallback`). `complete()` then re-validates **after** merging `branch`/`commit`/`base_commit`/`review_url`/`persisted`/`dirty` into `git` (line 703) and **after** redaction, which can also grow strings (a short-userinfo URL such as `https://<redacted>@host` becomes `https://[REDACTED]@host`, +7 bytes, `src/security.ts:8-31`). The re-parse then throws `"Structured result exceeds 60 KiB; place large reports in artifacts"`, so `store.finish()` (line 708) and the guest mirror (lines 710-718) never run.

**Consequence (reproduced):**
1. The run is never recorded. `store.result()` stays `null`; the guest `result.json` mirror is never written; the operator gets a *failed* worker with the misleading error `Worker task timed out` (last patch: `Provider or OpenCode operation failed; retrying within deadline`, line 516). The real cause never reaches the worker record, the result API, or the events feed (`worker.requested,…,worker.running,worker.failed` — no `result.received`).
2. `complete()` throws a `ZodError`, not a `GitHandoffError`, so the explicit re-push guard at line 518 does not fire; the catch block re-enters `fallback()` → `complete()` on **every poll tick**. Measured: **1,343 `pushBranch` calls in 1.6 s** of ticking with a `1 s` deadline. Against a real remote this is an unthrottled write amplification (the same class of failure the `GitHandoffError` guard exists to prevent).

**Reproduction** (bounded, local fakes; probe at `/tmp/sfrev/probe/probe2.test.ts`, `probe5.test.ts`):
```
push=github-app size=61239 state=running err=[{ "message": "Structured result exceeds 60 KiB; place large reports in artifacts" }]
push=none       size=61239 state=completed err=none
git field adds 181 bytes
agent result serialized bytes = 61178 ; ticks = 100033 ; pushBranch calls = 1343
final state = failed | error = Worker task timed out | stored result = null
```
The 61,178-byte payload passes `resultSchema.safeParse` (verified `success = true`), and the identical payload completes normally with `SWARMFORGE_GIT_PUSH_MODE=none` — confirming the push-mode re-validation, not the payload, is the trigger.

**Why existing guards/tests do not prevent it:** the only size test, `tests/core.test.ts:145-153`, asserts rejection of a ~200,657-byte payload — three times over the cap — so the accepted band is untested. `tests/lifecycle.test.ts:69-113` exercises the fallback/stale paths with tiny one-line results ("done", "fallback"), orders of magnitude below the cap. No test covers a result whose size changes between ingest and completion, and the `GitHandoffError` early-return at line 518 has no counterpart for post-push re-validation.

**Recommendation:** validate the merged+redacted result *before* it is treated as fatal, and re-derive the bound from the post-merge size. Minimal, behavior-preserving fix: in `complete()`, replace the fatal `resultSchema.parse` (line 707) with a size-tolerant normalization that (a) applies field clamping/`files_changed`/warnings trimming if the *total* exceeds 61440, or (b) stores the parsed object and records a distinct warning. Alternatively enforce the cap once, at ingest, on the value that will be stored, and drop `git` metadata from the size accounting by validating `r` before line 703 and merging after. Also add a `GitHandoffError`-style early return (or a one-shot attempt latch) for any post-push failure so the catch block cannot re-push every tick.

---

## F2 — LOW — The 60 KiB cap is enforced but never disclosed to the producer, and rejection is unattributable

**Location:** `src/domain.ts:71-73`; emitted prompt at `src/providers/opencode.ts:51`; generic failure at `src/coordinator.ts:597-600`.

**Trigger:** a worker fills the bounds it *is* given. `resultSchema.toJSONSchema()` (1,462 bytes, probed) contains `maxLength` for every field but **no** trace of the refinement — `mentions 60 KiB: false` — and refinements are not representable in JSON Schema. The advertised bounds sum to ~330 KB (`summary` 4,000 + `details` 16,000 + `files_changed` 200×1,024 + `warnings` 50×2,000 + `followup_reason` 4,000).

**Consequence (reproduced):** a 200,657-byte but per-field-valid result is rejected at ingest and the worker is failed with `Missing or malformed structured result` — no size hint reaches the model, the worker record, or the operator, so the producer cannot self-correct and the operator cannot triage. `docs/WORKER-PROTOCOL.md:27` states "the validated result is capped at 60 KiB", but the mechanism and the schema handed to the worker do not convey it.

**Reproduction:** `/tmp/sfrev/probe/probe6.test.ts` (first test) — `bytes = 200657`, `schema ok = false`, `state = failed | error = Missing or malformed structured result`; `/tmp/sfrev/probe/probe4.test.ts` (first test) — emitted-schema inspection.

**Why existing guards/tests do not prevent it:** no test asserts that the bootstrap prompt describes the cap, and no test asserts that a size rejection produces a diagnosable error. `tests/core.test.ts:145` only asserts `success === false`.

**Recommendation:** state the cap in the `bootstrap()` text next to the schema (and/or add `"description": "…total serialized result must stay under 60 KiB; put large reports in .swarmforge/artifacts"` to the emitted schema), and surface the `resultSchema` issue path in the failure text when a result is rejected for size.

---

## F3 — LOW (partial confidence) — An assistant message carrying both an error and a parseable structured payload completes the run and drops the error

**Location:** `src/coordinator.ts:588-600` (`replies` selection, then `resultSchema.safeParse(reply.result)` before any `reply.error` check).

**Trigger:** an OpenCode assistant message with `info.error` set *and* `info.structured` (or text that parses as JSON) present. The SDK type declares `structured?: unknown` on the assistant message independently of `error` (`node_modules/@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts:243`), so the combination is representable.

**Consequence (reproduced at the coordinator boundary):** with `error = "ProviderOverloadedError"` and a valid `structured` payload on the same message, the run is stored as `status: completed` with that payload and `error = null`; the provider/session error is discarded and never enters the worker record or events.

**Reproduction:** `/tmp/sfrev/probe/probe6.test.ts` (second test) — `state = completed | error = null`, result summary `reported as finished`.

**Confidence / limits:** the coordinator logic is confirmed; whether OpenCode 1.18.31 actually populates `structured` on an errored assistant message was **not** verified — that needs a live OpenCode server, which is out of bounds for this review. So the code path is reachable-by-construction but the trigger is unverified.

**Why existing guards/tests do not prevent it:** no test constructs a message with both fields; `tests/lifecycle.test.ts` always supplies one or the other.

**Recommendation:** when `reply.error` is set, prefer the failure path (`fail(w, 'OpenCode session failed (…)')`) unless the result came from the current-run `result.json` fallback, or explicitly log both the error and the adopted result.

---

## Checked and found sound (no defect)

- **Stale file rejection:** `src/coordinator.ts:685` requires `r.run_id === d.run_id`; a missing `run_id` is rejected (`undefined !== d.run_id`), and a `worker_id` mismatch is rejected. A previous run's `result.json` therefore cannot complete a follow-up. `tests/lifecycle.test.ts:93-113` covers `undefined`, malformed, and `run_id: "old"`.
- **Authoritative identity:** `identify()` (`src/coordinator.ts:665-671`) overwrites `worker_id`/`task_id`/`run_id` from the store, so a model cannot mislabel a result. Probed: a payload carrying `worker_id: "someone-else"`, `task_id: "other-task"`, `run_id: 0000…` is stored under the real identities. This matches `docs/WORKER-PROTOCOL.md:27` ("filesystem fallback additionally requires the current run_id"), i.e. the direct path deliberately relies on coordinator authority — not a finding.
- **Result API staleness:** `store.result(id, run)` (`src/store.ts:300-306`) returns `null` for a non-matching `run_id`; `send_worker_message` returns the new `run_id` (`src/coordinator.ts:246-251`), so the documented "match run_id" procedure is satisfiable. `get_worker_result` (`src/mcp.ts:150-160`) passes the optional `run_id` straight through.
- **Duplicate completion:** `store.finish` (`src/store.ts:277-296`) re-reads the dispatch and no-ops when it is already `completed`/`cancelled`, and is wrapped in a transaction.
- **Fallback read bound:** `readFile(..., 0, 65537)` with `bytes.length > 65536 → null` is consistent with the 61,440-byte schema cap; pretty-printing inflates a near-cap result by only ~130-330 bytes (probed at 20-60 KB), so the 64 KiB window is not practically reachable — the initial hypothesis here was refuted.
- **Non-object / extra keys:** the schema is non-strict, so unknown keys are stripped before storage; `JSON.stringify` inside the `.refine` cannot see a cycle or a `BigInt` because the parsed output contains only strings/numbers/booleans/null.
- **Untrusted `result.git.workspace` into the persistence script:** `src/safety.ts:13-20` double-`JSON.stringify`s the roots before embedding them in the Python source. Probed with an injection-shaped `workspace` value: no escape, no side effect (`PWNED file created: false`).

## Tests / probes run (all outside the source checkout)

- `bun test tests/lifecycle.test.ts tests/core.test.ts tests/session-status.test.ts` (in `/tmp/sfrev/repo`, Bun 1.4.2): **56 pass, 0 fail**, exit 0.
- `bun install --frozen-lockfile` in the /tmp clone: 125 packages, exit 0, no lockfile rewrite.
- Reviewer probes `/tmp/sfrev/probe/probe{1..6}.test.ts`: probe1 3 pass/1 fail (the 1 fail is my own incorrect boundary arithmetic in the probe, corrected in probe2), probe2 3 pass, probe3 3 pass, probe4 3 pass, probe5 1 pass, probe6 2 pass. No production provider, network, cloud or real-VM call was made; `FakeProvider`/`FakeAgent` and in-memory SQLite only.

## Limitations

- Read-only review; no source file was modified, committed, or pushed, and no test was added to the repository. All experiments live in `/tmp/sfrev` and are disposable.
- Not run: the full suite, packaging/compile, and any real OpenCode/Freestyle interaction (out of scope for this reviewer).
- F3's runtime trigger depends on live OpenCode behavior and is unverified; F1/F2 are fully reproduced with local fakes.
- Not assessed (other reviewers' scopes): provider pagination/`limit: 100` in `inspect`, git-handoff/push verification internals, CLI/TUI rendering, HTTP auth, config validation, packaging.
- No credentials appear in this report; credential-shaped examples from the probes were reduced to `https://<redacted>@host` form.
