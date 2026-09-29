# Adversarial Code Review — `src/providers/freestyle.ts` and VM/bootstrap shell commands

- **Repository:** SwarmForge @ `39c1a90c9e7ec4cfdf246b9c573f1adddddc873d`
- **Scope:** `src/providers/freestyle.ts`, plus the shell command strings, systemd unit and guest bootstrap that it emits (and the callers that consume them: `src/config.ts`, `src/git-handoff.ts`, `src/coordinator.ts`, `src/safety.ts`, `src/files.ts`).
- **Mode:** read-only. No tracked source or test file was modified. `bun test` (102 pass / 1 skip / 0 fail) and `bun run check` (tsc + biome, clean) were run before and after the review and are unchanged.
- **Reproduction:** all findings below were reproduced with local harnesses that execute the *actual* generated command strings under `bash` and drive the real `FreestyleProvider`/`Coordinator` code. Harness: 14/14 pass (`.review-tmp/repro.spec.ts`, `.review-tmp/quote.spec.ts`, `.review-tmp/fetch.spec.ts`; scratch only, removed after review).

---

## Summary

No shell-injection defect was found. The `quote()` helper is a correct POSIX single-quote escaper and is applied to every attacker-influenceable value that reaches a shell. That negative result is evidence-backed (R1), not assumed.

The material findings are instead about **credential lifetime inside the guest**, **client-side timeout layering**, **reconciliation pagination**, and **error masking that hides both**. Two of them (A, B) are High: the deploy credential is deposited into the same machine, same uid, same filesystem namespace as the untrusted coding agent, and the client's HTTP timeout silently overrides the guest exec budget for the very clone and push operations the design is built around.

| # | Severity | Location | Confirmed? |
|---|----------|----------|-----------|
| A | **High** | `freestyle.ts:171-181`, `200-223`, `236-240`; `coordinator.ts:634-640` | Yes (R4, R5) |
| B | **High** | `freestyle.ts:20-24` vs `131`, `257`; `config.ts:38` | Yes (fetch.spec) |
| C | **Medium** | `freestyle.ts:98-107` | Yes (R2, R3) |
| D | **Medium** | `freestyle.ts:236-240`; `coordinator.ts:636-640` | Yes (R6, R7) |
| E | **Medium** | `freestyle.ts:44-47` | Yes (R8) |
| F | **Low** | `freestyle.ts:129` | Yes (R9) |
| G | **Low** | `config.ts:38` | Yes (R10) |
| H | **Low** | `config.ts:57-61` | Yes (R11) |
| I | **Low / hypothesis** | `freestyle.ts:63`, `safety.ts:12-16`, `129` | Not confirmed (no live cloud) |

---

## A. High — The deploy credential is written to disk in the guest that the coding agent owns, while that agent is still running

**Locations**
- `src/providers/freestyle.ts:171-181` — systemd unit written with no `User=`, no sandboxing directives, then `systemctl enable --now`.
- `src/providers/freestyle.ts:200-223` — `withGitAuth` writes the GitHub App installation token or the **host SSH private key** to `/opt/swarmforge/git-secret` (mode `0600`) and the askpass/known_hosts helper to `/opt/swarmforge/git-auth`.
- `src/coordinator.ts:634-640` — `complete()` calls `provider.pushBranch()` on the success path; `quiesce()` (`coordinator.ts:656-673`, which is what stops the guest service) is only reachable from `fail()` and from `control("cancel"|"destroy")`.

**Failure scenario**
1. `prepare()` installs `swarmforge-opencode.service` with no `User=`, so it runs as **root**. `opencode.json` (written at `freestyle.ts:157-161`) sets `permission: { "*": "allow" }`, so every tool call — including Bash — is auto-approved. The agent is executing LLM-authored code as root.
2. The worker finishes. `complete()` calls `pushBranch()` **without ever stopping or aborting the guest service**.
3. `withGitAuth` writes the coordinator host's **SSH private key** (or a repo-scoped GitHub App token with `contents: write`) to `/opt/swarmforge/git-secret`, mode `0600`, owner root.
4. The guest service is uid 0, so `0600` is not a boundary against it. Any process the agent spawned earlier — e.g. a background `sh -c 'while [ ! -f /opt/swarmforge/git-secret ]; do sleep 1; done; …'` planted during the task — can read and exfiltrate the deploy key the moment it appears, for the whole duration of the clone/push.
5. A `github-app` token is repo-scoped to the single configured repository, so exfiltration yields write access to that repo, not the whole org. An **SSH** deploy key has whatever scope the operator's key has — commonly more.

**Impact.** Credential exfiltration from a prompt-injection-reachable process. The mitigation that exists (removal in `finally`, §D) removes the file *after* the window; it does not shrink the window, and the agent's read is not detected.

**Reproduction (R4, R5 — both pass)**
```
R4 unit User= : false | sandboxing: false
R4 secret path/mode: /opt/swarmforge/git-secret 600 | is the host private key: true
R4 start.sh carries the model key and worker password: true true mode 700
R5 provider activity during completion: [">> pushBranch"]
```
`R4` runs the real `prepare()` and captures the exact unit text and the guest writes; the file content is byte-identical to the host key at `SWARMFORGE_GIT_SSH_KEY_PATH`. `R5` drives the real `Coordinator` through `runToRunning` → `agent.complete` → `tick` and records every `provider.exec` call: `pushBranch` runs, and no `systemctl stop` ever occurs.

**Recommended direction (not applied).** Run the service as a non-root uid with a credential group it does not hold; or split the push onto a path that does not share a filesystem with the guest agent (e.g. coordinator-side push via the GitHub API); or at minimum `systemctl stop` the unit before `withGitAuth` and restart it afterwards. Add `User=`, `NoNewPrivileges=yes`, `ProtectSystem=strict`, `ProtectHome=yes` to the unit regardless.

---

## B. High — The injected `fetch` caps every provider call at `SWARMFORGE_API_TIMEOUT_MS`, defeating the configured guest exec budget

**Location** `src/providers/freestyle.ts:20-24`

```ts
fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
  fetch(input, { ...init, signal: AbortSignal.timeout(config.SWARMFORGE_API_TIMEOUT_MS) })) as typeof fetch,
```

The wrapper **unconditionally replaces** `init.signal`. Every request the SDK issues inherits a 30 s default (`SWARMFORGE_API_TIMEOUT_MS`), including `POST /v5/vms/{id}/exec-await`. But `prepare` and `pushBranch` explicitly request a much longer guest budget:

- `freestyle.ts:131` — clone: `timeoutMs: this.config.SWARMFORGE_GIT_PUSH_TIMEOUT_MS` (default **120 000**)
- `freestyle.ts:257` — push: `timeoutMs: this.config.SWARMFORGE_GIT_PUSH_TIMEOUT_MS` (default **120 000**)
- `coordinator.ts:404-407` — the coordinator even bounds `prepare` with `SWARMFORGE_GIT_PUSH_TIMEOUT_MS + SWARMFORGE_API_TIMEOUT_MS` (**150 000**)

So the effective budget for the two longest operations in the system is 30 s, not 120 s, while the surrounding code believes it is 150 s. The three values disagree by 5x.

**Failure scenario.** A repository large enough that `git clone` needs 30-120 s (very common) is aborted client-side at 30 s. The AbortError surfaces as a `statusCode !== 0` check, so the operator sees the generic `Failed to clone SWARMFORGE_GIT_TREE into workspace/repo` (`freestyle.ts:136`) or `Git push or remote commit verification failed` (`freestyle.ts:261`) — neither of which hints at a timeout. In `pushBranch` the failure is additionally masked one level further by `coordinator.complete()` (§D). Retries re-run the same doomed call until the worker deadline expires, and each retry **re-mints a GitHub App installation token** (`freestyle.ts:199`).

**Impact.** Reliability/cost: silent truncation of the long-running Git operations the whole persistence guarantee rests on, with a misleading error and a retry storm that re-issues credentials.

**Reproduction (fetch.spec — passes).** The wrapper is reconstructed exactly as written and driven through the real `Freestyle` SDK:
```
F15 API_TIMEOUT_MS = 30000  GIT_PUSH_TIMEOUT_MS = 120000
F15 requested guest timeoutMs was 120000
F15 client-side signal applied: true aborted: false
F15 observed abort after ms (configured GIT_PUSH_TIMEOUT_MS=120000): 400
```
With `SWARMFORGE_API_TIMEOUT_MS=400`, an `exec` that requested `timeoutMs: 120000` aborts after 400 ms. The SDK documents the ceiling at `node_modules/freestyle/dist/vms/types.d.ts:410` — `Wall-clock limit, milliseconds. 1–300000`.

**Recommended direction (not applied).** Compose rather than replace: `AbortSignal.any([init?.signal, AbortSignal.timeout(max(API_TIMEOUT, requested))])`, or simply give the exec transport a separate, larger budget. Also make `SWARMFORGE_GIT_PUSH_TIMEOUT_MS` `<= 300000` (§G).

---

## C. Medium — `listWorkers` skips records and can loop forever; reconciliation silently under-reports

**Location** `src/providers/freestyle.ts:96-109`

```ts
for (let offset = 0; ; offset += 100) {
  const page = await this.client.vms.list({ metadata: …, limit: 100, offset });
  list.push(...page.vms.map((v) => this.info(v)));
  if (offset + page.vms.length >= page.totalCount || !page.vms.length) break;
}
```

The loop advances `offset` by the **requested** `limit` (100) but terminates on the **returned** count. The two only agree if the server always honours `limit` exactly. It does not have to:

1. **Record loss (confirmed, R2).** If a page comes back short while more remain, the next request starts past the un-returned rows.
   ```
   R2 returned 170 of 250 - missing: vm-60,vm-61,vm-62,vm-63,vm-64 ...
   ```
2. **Non-termination (confirmed, R3).** If the server clamps `offset`, each page is non-empty, the break condition never fires, and the loop issues requests until the process ends.
   ```
   R3 pagination calls before the guard fired: 41 -> runaway   (guard was mine, at 41)
   ```
3. **Concurrent mutation.** `listWorkers` runs from `recover()` (`coordinator.ts:303`), which also runs while workers are being created and destroyed. A shrinking `totalCount` shifts the offsets mid-walk, duplicating or skipping rows.

**Impact.** `recover()` is the startup and 30-second reconciliation pass (`coordinator.ts:235-237`, `250-257`). A skipped VM is:
- an **orphan** the coordinator never learns about → an indefinitely-billed VM (`autoDeleteSeconds: -1`, `idleTimeoutSeconds: -1`, `ttlSeconds: -1` at `freestyle.ts:51-53`) that no destroy path can reach, or
- a worker row stuck with `vm_id: null` in `provisioning` (crash between `createWorker` and the `store.transition` at `coordinator.ts:399`) which is never adopted, so it burns `SWARMFORGE_PROVISION_TIMEOUT_SECONDS` and fails while the live VM leaks.

For R3, note that `bounded()` (`coordinator.ts:36-39`) uses `Promise.race` and does **not** cancel the losing promise. So the runaway loop is not converted into a startup hang — it becomes a permanently-live background request loop, and `recover()` starts a *new* one every 30 s. That is an unbounded request leak rather than a clean failure.

**Recommended direction (not applied).** Advance by what was returned and guard on no progress: `if (!page.vms.length) break; offset += page.vms.length;` plus a `seen` set / repeated-first-id check, and honour a hard page ceiling.

---

## D. Medium — A failed credential cleanup hides the real error, and the coordinator re-deposits the credential on every retry

**Locations** `src/providers/freestyle.ts:229-241`, `src/coordinator.ts:636-640`, `coordinator.ts:450-456`

```ts
let cleaned = false;
try { const result = await vm.exec({ command: `rm -f ${paths.map(quote).join(" ")}`, … }); cleaned = result.statusCode === 0; }
catch {}
if (!cleaned) throw new Error("Failed to remove temporary Git credential from worker");
if (failed) throw failure;          // <-- unreachable whenever !cleaned
```

Two defects compound:

1. **Error masking (confirmed, R7).** When cleanup fails, the original exception (`failed`/`failure`) is discarded. The operator is told the credential cleanup failed and is *never told whether the push succeeded*.
   ```
   R7 operator-visible error: Failed to remove temporary Git credential from worker (underlying exec status 128 lost)
   ```
2. **The security signal is then erased (confirmed, R6).** `coordinator.complete()` wraps *any* `pushBranch` throw in `GitHandoffError("Git branch push or verification failed")`, and `step()` turns that into a retry:
   ```
   R6 repeated error: "Git branch push or verification failed; retrying within deadline"
   R6 state: running | dispatch: sent
   ```
   Three consecutive ticks, identical error, dispatch left `sent` — the loop continues until the worker deadline.

**Impact.** If `rm -f` fails persistently (read-only remount of `/opt`, the freestyle exec endpoint flapping, a guest exec timeout — note §B applies here too), the deploy key stays on the VM indefinitely **and every retry writes it again** (`freestyle.ts:200`/`218`). A credential-on-disk incident is reported to the operator as an ordinary retryable Git error. This is the exact condition the `!cleaned` guard was written to catch, and it is the one condition that gets swallowed.

**Recommended direction (not applied).** Preserve both errors (e.g. `throw new AggregateError([failure, new Error("failed to remove temporary Git credential")])`, or attach the cleanup failure as `cause`); and surface a cleanup failure as a distinct, non-retryable terminal state (`recovery_required`) rather than folding it into the generic Git retry.

---

## E. Medium — `createWorker` adopts an existing VM in any state and never starts it

**Location** `src/providers/freestyle.ts:44-47`

```ts
const existing = await this.getWorker(slug);
if (existing) return existing;
```

The returned `VmInfo.state` is never inspected and `start()` is never called. `createWorker` is the only entry point into `prepare`, and every command in `prepare` is a guest `exec`.

**Failure scenario.** A VM exists with the worker's slug but is `paused` or `stopped` — reachable, because `quiesce()` pauses the VM when the service cannot be stopped (`coordinator.ts:670-673`) and `autoDeleteSeconds/idleTimeoutSeconds/ttlSeconds` are all `-1` so a paused VM is never reclaimed. The most common trigger needs no external cause: the client's `AbortSignal.timeout` (§B) fires on the `POST /v5/vms` during `createWorker`, the VM is created server-side anyway, and the next tick re-enters `createWorker`, which finds it in `starting`/paused and adopts it. `prepare`'s first `exec` then cannot run.

**Impact.** The worker burns its entire provision budget and is failed by the `provisioning`/`booting` timeout at `coordinator.ts:388-393` with a generic message, while the VM is live and unreachable — the same leak as C's second impact mode.

**Reproduction (R8 — passes)**
```
R8 adopted state: paused | provider calls: get(sf-default-6d066a70-…)
```
Only `get` is issued; `start` never is. The runtime consequence depends on whether freestyle permits `exec` against a non-running VM — the SDK documents that constraint explicitly for `snapshot` (`The VM must be running or paused`, `dist/vms/index.d.ts:50`) but not for `exec`. **The code defect (no `start()`, no state check) is confirmed; the API-side failure is a hypothesis I could not test without live cloud operations.**

**Recommended direction (not applied).** `if (existing && existing.state !== "running") await this.client.vms.ref(existing.id).start();` before returning, and re-check state in `prepare` before the first `exec`.

---

## F. Low — A failed clone leaves the staging checkout on disk

**Location** `src/providers/freestyle.ts:129`

```sh
rm -rf '<staging>' && <auth> git clone -- '<target>' '<staging>' && mv '<staging>' '<repository>'
```

There is no `trap` and no `|| rm -rf '<staging>'`. A clone that fails after partial transfer (network drop, auth failure mid-receive, or a §B abort) leaves `/workspace/.swarmforge/repo-clone-<worker_id>` populated.

**Impact.** Bounded: the next `prepare` retry begins with `rm -rf '<staging>'` so it self-heals, and `.swarmforge` is excluded from both `inspectPersistence`'s walk (`safety.ts:32`) and `WorkerFiles` artifact reads, so the residue is invisible to safety checks. It is disk consumption only, and only for the multi-minute window between a failed clone and a retry.

**Reproduction (R9 — passes)**
```
R9 error: Failed to clone SWARMFORGE_GIT_TREE into workspace/repo
R9 clone command: if [ -d '…' ]; then exit 0; fi; … rm -rf '…/repo-clone-w-…' &&  git clone -- … && mv …
R9 has trap/cleanup-on-error: false
```

---

## G. Low — `SWARMFORGE_GIT_PUSH_TIMEOUT_MS` is unbounded, above the guest exec ceiling

**Location** `src/config.ts:38` (`positive(120000)` with no `.max()`), consumed at `freestyle.ts:131`, `freestyle.ts:257`, `coordinator.ts:404`.

The SDK caps guest exec `timeoutMs` at 300 000 (`dist/vms/types.d.ts:410`). `loadConfig` accepts anything.

**Reproduction (R10 — passes)**
```
R10 accepted: 900000 ms (SDK: 1-300000)
```

**Impact.** A misconfiguration (or a value chosen to accommodate §B) is accepted at startup and surfaces only later as an API rejection on every clone and push, reported as a generic Git failure. Config-only, operator-triggered.

**Recommended direction.** `z.number().int().min(1000).max(300000)`.

---

## H. Low — `SWARMFORGE_WORKSPACE` accepts `/` and `.` path segments

**Location** `src/config.ts:57-61`. The regex `^\/(?:[a-zA-Z0-9_.-]+\/?)*$` matches `/` and any `.` segment; only `..` is excluded by the `.refine`.

**Reproduction (R11 — passes)**
```
R11 "/" -> ACCEPTED
R11 "/./workspace" -> ACCEPTED
R11 "/a/./b" -> ACCEPTED
R11 "//workspace" -> rejected
R11 "/a/../b" -> rejected
```

**Impact.** With `SWARMFORGE_WORKSPACE=/`, the bootstrap provisions `//repo`, `//.swarmforge/artifacts` and `//.swarmforge/result.json` at the guest filesystem root, and the agent is told its workspace is `/`. On Linux `//x` resolves as `/x` so it works, but POSIX leaves a leading `//` implementation-defined. `WorkerFiles.noSymlinks` (`files.ts:32-40`) splits on `/` and filters empty segments, so `.` segments are stat'd as `/.` and correctly never flagged as symlinks — no traversal, only non-normalised paths. Config-only.

**Recommended direction.** Require at least one non-dot segment, e.g. `/^\/(?:[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\/?)+$/`, and reject any segment equal to `.`.

---

## I. Low / hypothesis — Unrestricted guest egress and an unbounded filesystem walk

**Locations** `freestyle.ts:61-74` (`{ action: "allow", source: {}, destination: { public: true } }` — allow-all ingress **and** egress on every worker), `safety.ts:12-16` and `safety.ts:31-36`.

Two items I could **not** confirm without live cloud operations, recorded so they are not lost:

1. **Egress.** The firewall rule permits the worker to reach any public destination. For a host that executes LLM-authored code with `permission: { "*": "allow" }`, egress to a cloud metadata endpoint is the standard credential-theft path. Whether freestyle's `public` destination class includes link-local `169.254.169.254` is not determinable from the vendored SDK. **Hypothesis.**
2. **Walk amplification.** `inspectPersistence` adds `result.git.workspace` — **worker-controlled**, `z.string().max(2048)` — to the scan roots (`safety.ts:15`). A worker returning `git.workspace: "/"` forces a full-filesystem `os.walk`. The 200-repo break at `safety.ts:36` only fires when a directory contains *files*; a tree of empty directories never trips it. The walk is then cut off by the 30 s `exec` timeout at `freestyle.ts:295`, whose failure is mapped to `{ safe: false }` (`safety.ts:50-52`), pushing the worker to `recovery_required` and blocking `control("destroy")`. A worker can therefore block its own destruction. **Hypothesis** — the walk volume is bounded by real guest filesystem size, which I did not measure.

---

## What is *not* wrong (verified negatives)

These were in scope and are clean; recording them so the absence is evidence-backed.

- **Shell injection: none found.** `quote()` (`freestyle.ts:8`) is a correct POSIX escaper, and every attacker-influenceable value that reaches a shell goes through it. Verified by executing `printf '%s' ${quote(p)}` under `bash` for ten adversarial payloads including `a'$(id)'b`, newline-separated commands, backticks and `'; … ; '` — all round-tripped byte-exact and no canary fired (R1). The non-quoted interpolations were audited individually: `${auth}` (`:129`, `:255`) is built only from two constant templates; `paths[0]`/`paths[1]` in the SSH command (`:220`) are literals; `OPENCODE_START_COMMAND` (`config.ts:27-30`) is raw by design (it must expand `$OPENCODE_PORT`) and is operator-controlled.
- **Attacker-controlled identifiers are sanitised before use.** `worker_id` is `w-${randomUUID()}` (`store.ts:89`), so the `rm -rf` staging path and the VM slug cannot be steered. `team_id`/`task_id` are constrained by `idSchema` (`domain.ts:24-28`) and are further sanitised for Git by `branchFor` (`git-handoff.ts:12-14`).
- **No credentials in guest Git config or in argv.** The GitHub App token stays in `git-secret` and is reached only via `GIT_ASKPASS`; the SSH key goes through `GIT_SSH_COMMAND` with `IdentitiesOnly=yes`. Neither appears in a command line. `tests/git-handoff.test.ts:242` already asserts the key never appears in the emitted commands.
- **The `init` probe is a pure `&&` chain** (`freestyle.ts:115`), so a `mkdir`/`chmod` failure *does* propagate through the exit status. I initially hypothesised this was masked by the trailing `command -v` chain and the reproduction disproved it — **retracted**.
- **Cleanup is attempted on every path.** `withGitAuth` uses try/catch around `action` plus a `finally`-style cleanup that runs even when the action throws (`freestyle.ts:225-237`) — the gap in §D is the *reporting*, not the attempt.
- **Artifact path handling is sound.** `WorkerFiles.path()` (`files.ts:11-23`) rejects absolute paths, `\`, empty, `.` and `..` segments and `\0`, and `noSymlinks` walks every prefix rejecting symlinks. `readArtifact` over-reads by `pad` bytes on both sides so a secret split across a chunk boundary still trips the redactor (`files.ts:93-107`).
- **`safety.ts:19` double-`JSON.stringify`s the roots**, which is a valid Python string literal — `result.git.workspace` cannot break out into the embedded script. Combined with `quote(script)` at `safety.ts:44` and argv-based `subprocess.run` at `safety.ts:23`, no injection.

---

## Residual test gaps

1. **`listWorkers` pagination has no test at all.** `tests/adapters.test.ts` covers `createWorker` and `domain`, but nothing exercises `listWorkers` against a paginated, mutating, or short-page API. Both C defects would have been caught by a two-page fixture.
2. **`withGitAuth` is only tested on the success and push-failure paths.** `tests/git-handoff.test.ts:169-247` asserts the key is removed after a *push* failure; nothing asserts behaviour when the **`rm -f` itself** fails, which is the branch that masks the error (§D).
3. **No test asserts anything about the generated systemd unit or `start.sh`.** No test would notice if `User=` were added, removed, or if a secret were added to the unit. R4 is the harness this gap calls for.
4. **No timeout/transport test.** Nothing asserts that a `timeoutMs` handed to `vm.exec` is actually honoured end-to-end (§B). The only fetch-level tests (`tests/adapters.test.ts`) assert on URL and body.
5. **`createWorker` idempotence is tested only for the absent-VM path** (`tests/adapters.test.ts:67-98`); the adopt path is untested, which is why §E is invisible.
6. **`SWARMFORGE_WORKSPACE` boundary values are untested.** The config tests (`tests/git-handoff.test.ts:76-101`) cover push-mode combinations only, never path shapes.
7. **Credential-lifetime ordering is untested.** No test asserts that the guest service is stopped (or is not running) at the moment `withGitAuth` writes the key — the property §A turns on.
