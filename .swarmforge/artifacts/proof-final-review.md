# Independent review — proof / scale runner

- **Reviewed head:** `1960ad97426b96da32b15d6f25fd1938420f1826`
- **Branch:** `swarmforge/artifact-salvage-20261001/fix-proof-and-scale/w-041679b4-9bb1-4215-8a44-da8fe41bda89`
- **Base:** `14adb43fb36945eb1c0b41d91a221a92605f5680` (commits under review: `6ffd1d5`, `1960ad9`)
- **Files:** `scripts/artifact-salvage-real-proof.ts`, `scripts/artifact-salvage-scale.ts`, `tests/proof-runner.test.ts`
- **Composed deps (disposable checkout only):** data `6a5d740ec840248db321b1a2fc57b1afd75379c3`, lifecycle/finalization `ef056c671c85b133b9ee82ba1cdacad5c3d718d3`, API `c3923f69f0f27f151ffd0f89a093c0e89c7f5c32` — merged cleanly over `1960ad9` in `/tmp` (merge-base of all four is `5672ead`). No stubs, no reimplementation.
- **Fixed target (NOT touched, as instructed):** DATA owner `vm-debbc6d8e4cf4705ba96574c8f1ac519` / `w-c6875611-3237-4c55-aa4b-8e5c047e6efb`. No credentialed `--execute`, no real guest access, no deployment was performed. Reviewer used Bun 1.3.14 (local); `bun.lock` is `lockfileVersion: 2` and 1.3.14 refuses it, so deps were installed with `bun install --no-save` into the disposable checkout. Bun 1.4.2 + `--frozen-lockfile` was **not** needed and **not** used — the lockfile itself was not validated by any tool here (see R4).
- **Production code was not edited.** `/workspace/repo` is clean at `5672ead`.

## Verdict: CHANGES_REQUESTED

Two prior HIGH findings are genuinely fixed and verified. Three new issues are blocking: two in the destroy gate, one CI gate. Everything else is low severity or a residual risk.

---

## Blocking findings

### H1 — `readProvenance` fail-opens the destroy gate the production path refuses (`stale result query`)
`scripts/artifact-salvage-real-proof.ts:423-445`

```
423  const dispatchRows = db.query("... WHERE worker_id=? ORDER BY rowid DESC").all(...)
428  const parsed = dispatchRows.map(...).find((d) => d.result !== null);   // newest WITH a result
431  const latest = dispatchRows[0] ? JSON.parse(dispatchRows[0].body) : null;  // newest dispatch
434  const result = parsed?.result ?? null;
445  latest_persisted: result?.git?.persisted === true,
```

`latest_state`/`latest_run_id` come from the **newest** dispatch; `latest_persisted`, `reported_branch` and the whole `git` block come from the newest dispatch that **has a result** — potentially an older one. Production computes both from the same row (`src/coordinator.ts:1084-1090`):

```
const latest = runs.at(-1);
const verified = latest.state === "completed" &&
  this.store.result(id, latest.run_id)?.git?.persisted === true;   // THAT run's result
```

Evidence (real `Store`, real `readProvenance`, composed tree): worker `w-c6875611…`, newest dispatch `run-2-newer` (`completed`, `result: null`), older `run-1` (`completed`, `git.persisted: true`).

| | newest run | state | persisted | gate |
|---|---|---|---|---|
| production (`src/coordinator.ts:1084-1090`) | `run-2-newer` | completed | result of `run-2-newer` is null → **false** | **REFUSE destroy** |
| script `readProvenance` | `run-2-newer` | completed | from stale `run-1` → **true** | **ALLOW destroy** |

`agree: false`. The branch-mismatch cross-check (`:451-457`) is evaluated against the same stale row, so it is weakened too. This is the "newest completed vs stale result" risk exactly. Precondition for the divergence: the owner has a *later* dispatch that is `completed` with no result (a follow-up that produced no structured result) — plausible in this swarm, and harmless for a single clean dispatch.

**Fix (2 lines):** at `:428-434`, take the result from the same row the state comes from:

```ts
const latest = dispatchRows[0] ? (JSON.parse(dispatchRows[0].body) as Dispatch) : null;
const result = latest?.result ?? null;          // was: parsed?.result ?? null
```
and delete the now-unused `parsed`/`dispatchRows`-`.find` (`:428-433`). Add a regression test with two dispatches (newest `completed` + `result: null`, older `completed` + `persisted: true`) asserting `latest_persisted === false`.

### H2 — destructive steps run against a possibly unfinished owner; the "owner finished" precondition is never enforced
`scripts/artifact-salvage-real-proof.ts:585-593` and `:614-621`, versus the gate at `:783-815`

Order of operations in `--execute`:
1. `:585` `systemctl stop swarmforge-opencode.service` on the fixed VM;
2. `:614` `fs.writeFile(<owner workspace>/.swarmforge/artifacts/findings.json, …)` — a path inside the **real owner's** workspace;
3. `:783` provenance read — and the `latest_state === "completed"` / `latest_persisted` gate at `:808-815` runs **only when `--destroy-proven-fixture` was passed**.

So plain `bun scripts/artifact-salvage-real-proof.ts --execute --evidence-dir <dir>` stops OpenCode and overwrites a file on the target owner's guest **without ever checking that the owner finished**. The header (`:118-119`) states the owner "must have finished all of its code, source and reports durably before the lead executes this runner against it", but that is a comment, not a check — and the lead's own instruction that this owner is *not yet finished* is precisely the condition that would let `--execute` do damage. `:816-821` already refuses `--destroy` without `--provenance-db`; the same requirement is missing for `--execute`.

**Fix:** require `--provenance-db` for any `--execute`, read provenance **before** step 1, and refuse unless `latest_state === "completed"` (plus `latest_persisted` for the destroy phase) — i.e. move the block at `:783-806` above `:576` and change `:816` to `else if (opts.execute)`; alternatively gate `:585` explicitly on a verified finished owner.

### H3 — the destroy gate is configuration-dependent and evaluates the wrong record; the header overstates it
Header `:24-27` and `:830-840` claim destruction "always goes through the coordinator's normal (non-forced) destroy control" and that "that path enforces the existing Git durability checks". Verified by driving real `Coordinator` + real `Store` + real `ArtifactService` over the repo's own `tests/local-artifact-provider` fixture (no VM, no stub of production code):

| run | `SWARMFORGE_GIT_PUSH_MODE` | result |
|---|---|---|
| A | default `none` (`.env.example:19`, `src/config.ts:57-59`) | `destroy_returned_state: "destroyed"`, `vm_deleted_by_provider: true`, guest tree removed — with the newest dispatch still the malformed one (`cancelled`, `result: null`) and **no** handoff verification at all |
| B | forced `ssh` | `destroy_returned_state: "recovery_required"`, `"No verified branch handoff for this worker; inspect before destruction"`, `vm_deleted_by_provider: false` |
| C | default `none`, guest reports a dirty/unpushed tree | `git_checks_observed: 1`, `recovery_required`, `"dirty or unreadable Git workspace; commits not represented by remote refs"`, VM retained |

So: the `inspectPersistence` claim in item C **holds** (`src/artifacts`/`src/safety.ts` gate is not push-mode dependent). The *handoff* claim does not: it is gated on `SWARMFORGE_GIT_PUSH_MODE !== "none"` (`src/coordinator.ts:1091`), so on the documented default the script's own provenance gate (H1) is the **only** handoff gate; with push mode on, destroy is permanently refused, so steps 7-8 and header item 8 ("after the VM is actually deleted … re-read and re-verify") are unreachable on such a host.

Additionally `:831` destroys via `coordinator.control(spawned.worker_id, "destroy")` — the **private salvage record** (`team_id: "artifact-salvage-real-proof"`, fresh `worker_id`, `:657-664`), never the original owner's record. So whenever the production gate is active it is judging a worker whose `branchFor` branch does not exist on the guest — which is precisely why run B refuses.

The author's stated plan (private salvage record, then the original provenance record destroying the same VM) is **not implemented**: only `spawned.worker_id` is ever destroyed, and the original owner's record is only ever read. Do not treat the two as equivalent — the second half does not exist in this head.

**Fix:** (a) after `loadConfig`, refuse the destroy phase unless `config.SWARMFORGE_GIT_PUSH_MODE !== "none"`, so the run's claim and its configuration cannot diverge; (b) restate header item 7 to say which gate is active in which configuration and that it is evaluated on the private record; (c) either implement the original-record destroy or state plainly in the header that the post-destruction re-verification (step 8) requires a host where the private record's own gate permits it.

### M1 — `bun run check` fails at this head (2 biome errors, the only ones in the tree)
`tests/proof-runner.test.ts:8` `assist/source/organizeImports` (`import { Database } from "bun:sqlite"` is out of order) plus formatter diffs at `:249-251` and `:400-406`. `biome check src tests scripts` → **exit 1**; `biome check <the three reviewed files>` at pure head also → exit 1. `tsc --noEmit` on the composed tree is clean. Composed-tree scope: 57 files checked, 2 errors, both in the reviewed test file.
**Fix:** `bunx biome check --write tests/proof-runner.test.ts` (purely mechanical, no behaviour change).

### M2 — this branch neither typechecks nor runs standalone; it silently requires three unmerged branches
At pure head `1960ad9`: `tsc --noEmit` → **12 errors** (`Coordinator.finalize`, `Coordinator.artifacts`, `SWARMFORGE_ARTIFACT_DIR`, missing `../tests/local-artifact-provider`, …) and `bun test tests/proof-runner.test.ts` → 0 pass / 1 fail (`Cannot find module '../tests/local-artifact-provider'`). With the three named deps composed: `tsc --noEmit` clean, **23/23** proof-runner tests pass, `artifact-salvage-scale.ts` runs to completion. Not a code defect, but this branch must not be merged or gated before the data-plane / finalization / API branches land, and that ordering belongs in the merge plan.

---

## Verified fixed (with evidence)

- **Backup clobber (prior HIGH) — fixed.** `preserveExisting` (`:282-292`) copies with `constants.COPYFILE_EXCL` under a per-run unique stamp `${Date.now()}-${randomUUID().slice(0,8)}` (`:516`); `writeRunReports` (`:300-307`) writes a distinct run file and only then the pointer; the `finally` block (`:913-944`) never writes `keptReport`. Covered by 5 tests including a real two-run sequence (`tests/proof-runner.test.ts:46-134`) and a same-stamp collision refusal.
- **Double hash (prior HIGH) — fixed.** `digestStream` (`:338-348`) finalizes exactly once and returns a string; the large-artifact path (`:866-885`) asserts on that single value. The regression test at `:142-147` demonstrates the old defect (`ERR_CRYPTO_HASH_FINALIZED`) still throws, so the guard cannot rot.
- **Private DB forced even with a hostile host env — fixed and verified.** `privateRunPaths` (`:315-328`) derives every path from the evidence directory and throws if any escapes it. `loadConfig({...process.env, SWARMFORGE_DB_PATH: dbPath, SWARMFORGE_ARTIFACT_DIR: artifactDir})` (`:542-552`) forces the two private paths **last**, and `:553-560` fails closed if either was not honoured. The `...process.env` spread is required, not sloppy: `loadConfig`'s `env` argument defaults to `process.env` only when omitted, so a partial object fails validation — `tests/proof-runner.test.ts:199-225` pins that behaviour and passes. Real run with no host config fails at `loadConfig` before any network call (observed: `runner_failed: Invalid configuration: FREESTYLE_API_TOKEN …`).
- **WAL snapshot — present.** `:931-942`: `PRAGMA wal_checkpoint(TRUNCATE)` then `copyFileSync(dbPath, snapshot, COPYFILE_EXCL)` + `chmod 0600`.
- **Genuine peak measurement — fixed.** `MemorySampler` (`:95-117`) samples on a timer across the whole capture window, armed at `:209-210` immediately before the captures and disarmed in a `finally` at `:222-226`; the sample count is reported and `< 2` samples is a refusal (`:319-322`). Real run (`artifact-salvage-scale.ts`, 12 workers × 9 files + 8 MiB): 518 samples at 25 ms over 15 219 ms, heap peak 66 MiB, RSS peak 129 MiB against bounds 768/2048 MiB.
- **Duplicates assert — enforced, not merely reported.** `duplicateFindings` (`artifact-salvage-scale.ts:69-87`) plus `fail()` at `:338-341`, so a duplicated record can never reach exit 0. Real run: **0** duplicated worker/run/paths over 420 records / 109 guest files, 420/420 preserved, 0 checksum mismatches, 252 checksums re-verified by streaming both sides, `peak_guest_helper_exec_concurrency: 4` == bound with 1372 real helper execs.
- **Raw SDK streaming fixture — accurate.** `fs.writeFile(path, string|Uint8Array|Blob, { mode, chunkSize })` is real SDK API (`node_modules/freestyle/dist/vms/fs.d.ts:19-35`, `chunkSize` documented); the 32 MiB path uses `await openAsBlob(staging)` (`:638-647`), so the bytes are never assembled in the runner's heap, and the same `fs.writeFile` transport is already used in production (`src/providers/freestyle.ts:51`).
- **No arbitrary target, no force.** `--vm`, `--worker`, `--force` are all rejected with `unknown argument` (`:167-171`); `control(id, "destroy")` uses the default `force = false` (`src/coordinator.ts:866-869`); the two constants are re-asserted at `:469-472`; destroy needs `--execute` **and** `--destroy-proven-fixture` **and** `--provenance-db`.
- **Broken-model handoff — verified against real production code.** Local harness run of the exact `MalformedHandoffAgent` shape: worker settles `failed` with `"Missing or malformed structured result"`, `prompts: 1`, VM retained, and `finalize` still yields `state: "preserved"` for the declared artifact — i.e. the malformed handoff really does leave a salvageable workspace.
- **Provenance is read-only and never invents a value.** `new Database(snapshotPath, { readonly: true })` (`:401`) with `db.close()` in `finally`; `latest_persisted` is only ever `=== true` (`:445`); a VM mismatch refuses (`:416-419`); a branch mismatch refuses (`:451-457`); an unknown worker refuses (`:411-414`). The *values* are truthful — only the row they are read from is wrong (H1).
- **Plan mode is inert.** `bun scripts/artifact-salvage-real-proof.ts` (no args) exits 0, prints the plan, touches no credential, network or guest (verified).

## Low findings

- **L1 — `.swarmforge/` is not in `.gitignore`, yet the default evidence directory is inside the checkout.** `:508-511` defaults to `join(process.cwd(), ".swarmforge/artifacts/real-proof")`. With `--with-large-binary` that is a 32 MiB staging file plus per-run SQLite DBs and snapshots, all untracked and un-ignored; `git add -A` would commit them. Default outside the checkout, or add `.swarmforge/` to `.gitignore`.
- **L2 — the "re-read the raw private bytes" proof is capped at 32 KiB.** `ArtifactService.read` throws above `safeReadLimit` (`src/artifacts.ts:708-718`), but `:741-743` and `:852-854` pass `record.size` as the length. Fine today (~400 B), fails closed at step 5 if the fixture ever grows. Use `download()` + `digestStream` for the re-read.
- **L3 — the evidence jsonl is shared across runs while reports are per-run.** `Evidence` appends to a single `real-proof.jsonl` (`:522`), and every report names that same file (`:923`). The immutable-backup guarantee covers only the JSON report; run N's event stream is interleaved with run N-1's. Make the jsonl per-run too.
- **L4 — duplicate detection is blind to cross-worker capture of the same bytes.** `duplicateFindings` keys on `worker_id|run_id|original_path`; the local fixture gives every worker the same guest workspace, so one probe file was stored under 3 worker records (`records_for_probe_files: 18` for 10 files) with `duplicates: 0`. Correct for the finding it targets (within-worker duplication) but it cannot see cross-VM duplication; say so in the report text.
- **L5 — `distinct_content_digests` counts stored blobs, not guest files.** 10 probe files → 15 distinct digests, because `kind: "snapshot"` (directory archives) and `kind: "diagnostic"` (`logs/opencode-journal.txt`, `logs/git-report.txt`) records carry digests too. Rename or add a note; not wrong, just easy to misread beside `guest_files`.
- **L6 — the WAL checkpoint and snapshot copy are silently swallowed** (`:934-942`). A failed checkpoint yields a snapshot missing committed WAL data, with no report field saying so. Record a `snapshot_ok` boolean in the report.

## Test / gate results (this review, composed tree)

| gate | command | result |
|---|---|---|
| proof-runner unit tests | `bun test tests/proof-runner.test.ts` | **23 pass / 0 fail**, 70 expects |
| typecheck | `tsc --noEmit` | clean (0 errors) |
| lint/format | `biome check src tests scripts` | **2 errors** (M1), both in the reviewed test file |
| scale probe | `bun scripts/artifact-salvage-scale.ts` | exit 0; 420 artifacts, 420 preserved, 0 duplicates, 0 checksum mismatches, peak heap 66 MiB / RSS 129 MiB over 518 in-window samples, helper exec concurrency peak 4 (bound 4) |
| full suite (context only) | `bun test` | 324 pass / 1 skip / 4 fail → 3 stable pre-existing API+metrics failures (`tests/artifact-api.test.ts` "retry_worker_finalization …", "an unsettled collection keeps the worker …"; `tests/artifact-metrics.test.ts` "finalization stage and durable events …") plus one flaky 5 s timeout in `artifact-api` that passed on re-run. None are in the reviewed runner; out of scope per the brief. |
| plan mode | `bun scripts/artifact-salvage-real-proof.ts` | exit 0, no credential/network/guest |
| arg gates | `--destroy-proven-fixture` alone; `--vm`; `--worker`; `--force` | refused, exit 1 (no guest contacted) |
| real mode, no host config | `--execute` | refused at `loadConfig` before any network call |

**No credentialed `--execute`, no real guest access and no deployment were performed**, per the brief.

## Residual risks

- **R1** — The fixed target's owner is **not yet finished**. Nothing in this head verifies that before stopping OpenCode and writing into its workspace (H2). Until H2 is fixed, `--execute` must not be run against `vm-debbc6d8e4cf4705ba96574c8f1ac519`.
- **R2** — On a `SWARMFORGE_GIT_PUSH_MODE=none` host (the documented default) the production handoff gate is inert, so the script's own provenance gate is the only one; combined with H1 that is a genuine fail-open path to deleting a real VM.
- **R3** — "Artifacts survive VM destruction" (header item 8) is **not demonstrated** by this head: on a push-mode host steps 7-8 refuse; on a `none` host they succeed but with no handoff verification. Do not report post-destruction durability as proven until a run actually reaches `large_artifact_verified_after_destroy` / `sha_verified_after_destroy`.
- **R4** — `bun.lock` (`lockfileVersion: 2`) could not be validated: local Bun 1.3.14 refuses it outright, and deps were installed with `--no-save`. A Bun 1.4.2 `bun install --frozen-lockfile` run is still outstanding and was not performed here.
- **R5** — The scale probe runs the real helper and real capture path, but the guest is `tests/local-artifact-provider`, not a Freestyle VM; its own header says so. Nothing here is evidence about a live VM.
- **R6** — All destroy-path evidence above came from the repo's local fixture (whose provider short-circuits `SWARMFORGE_GIT_CHECK` and `systemctl`). It exercises real `Coordinator`/`Store`/`ArtifactService`/gate logic, but the Freestyle-specific quiesce/exec branches (`:1064-1080`) were not exercised.
- **R7** — This branch cannot be merged or `check`-gated before `6a5d740`, `ef056c` and `c3923f6` land (M2).