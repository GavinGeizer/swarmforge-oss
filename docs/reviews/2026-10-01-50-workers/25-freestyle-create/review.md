# SwarmForge Review — Freestyle VM creation, bootstrap failure cleanup, provider retries/timeouts, orphan prevention

**Target (exact):** `d428e0f730ed5649485732e95d39c32f5d6a8895`
**Published branch:** `feature/binary-config-serve-20260930`
**Assigned baseline in /workspace/repo:** `5672ead2a526e07fea9ed11e58b3725e42013527` (unchanged, clean)
**Reviewer checkout (disposable):** `/tmp/rev-wc71d/repo` — `git rev-parse HEAD` = `d428e0f730ed5649485732e95d39c32f5d6a8895` (verified)
**Toolchain:** official Bun 1.4.2 unpacked at `/tmp/bun142/bun-linux-x64/bun` (system Bun is 1.3.14). `bun install --frozen-lockfile` used unmodified; lockfile not rewritten.

## Scope reviewed

`src/coordinator.ts` (provisioning/boot state machine, `bounded()`, `fail()`, `recover()`),
`src/providers/freestyle.ts` (`createWorker`, `prepare`, `withGitAuth`, `pushBranch`, `destroyWorker`),
`src/providers/opencode.ts` (`ensureSession`), `src/safety.ts`, `src/config.ts` timeout defaults,
`src/serve.ts` startup/recovery ordering, `scripts/smoke.ts`.

## Findings

### F1 — HIGH — `prepare()` can never converge when total bootstrap exceeds the outer bound; endpoint is discarded and the worker livelocks in `booting`

**File/line (exact target):** `src/coordinator.ts:461-467` (bound), root cause `src/coordinator.ts:41-59` (`bounded`), consumed by `src/providers/freestyle.ts:110-185` (`prepare`).

**Code trace.** The outer bound applied to `prepare` is:

```
SWARMFORGE_GIT_PUSH_TIMEOUT_MS + SWARMFORGE_API_TIMEOUT_MS   // coordinator.ts:463-465
```

`prepare()`'s own internal per-step budgets (`freestyle.ts`) are:

| step | line | `timeoutMs` | default |
|---|---|---|---|
| init exec (mkdir, `command -v` probes) | 117 | `30000` | 30 s |
| clone + branch checkout (via `withGitAuth`) | 131 | `SWARMFORGE_GIT_PUSH_TIMEOUT_MS` | 120 s |
| branch checkout exec | 144 | `30000` | 30 s |
| `systemctl daemon-reload && enable --now` | 180 | `30000` | 30 s |

Worst-case internal total = **210 s**, outer bound = **150 s** (defaults `config.ts:53,89`). The outer bound is therefore *shorter than the sum of the inner budgets it wraps*, by 60 s at shipped defaults. `bounded()` (`coordinator.ts:41-59`) uses `Promise.race`, so it rejects at 150 s with `"External operation timed out"` while the abandoned `prepare()` promise keeps running provider-side; its return value (the endpoint URL) is dropped because `w = this.store.patch(id, { endpoint })` at `coordinator.ts:467` is never reached.

**Concrete trigger.** A healthy guest whose bootstrap legitimately takes >150 s (large `SWARMFORGE_GIT_TREE`, slow network, `git clone` near its 120 s budget, cold guest). No provider error is needed.

**Consequence.** The worker stays in `booting` forever, retrying each poll interval (`SWARMFORGE_POLL_INTERVAL_MS`, default 2 s). Each retry starts a **fresh full `prepare()`** — re-running init probes, and critically re-running the clone branch. It never reaches `ready`, never creates an OpenCode session, and never dispatches the task. It burns a running, billable VM (`idleTimeoutSeconds: -1`, `ttlSeconds: -1` at `freestyle.ts:51-53` mean no automatic reclaim) until `SWARMFORGE_PROVISION_TIMEOUT_SECONDS` (300 s) eventually fails it — and `fail()` retains the VM rather than destroying it. A task that would have succeeded is reported as failed purely because of budget arithmetic.

**Reproduction (executed, Bun 1.4.2, outside the checkout).** `/tmp/rev-wc71d/probe/threshold.ts` runs the real `Coordinator` with a local fake provider whose `prepare()` just sleeps, at shipped default ratios scaled 1:1000 (API 30 ms, GIT_PUSH 120 ms → outer bound 150 ms), polling exactly as the scheduler does:

```
inner prepare=100ms  outer bound=150ms  attempts= 1  ->  state=waiting  endpoint=RECORDED
inner prepare=149ms  outer bound=150ms  attempts= 1  ->  state=waiting  endpoint=RECORDED
inner prepare=160ms  outer bound=150ms  attempts=16  ->  state=booting  endpoint=LOST
inner prepare=210ms  outer bound=150ms  attempts=16  ->  state=booting  endpoint=LOST
inner prepare=260ms  outer bound=150ms  attempts=16  ->  state=booting  endpoint=LOST
```

The cliff is exactly at the outer bound. `probe/converge.ts` (staged sleeps matching the four inner `timeoutMs` values, i.e. the shipped worst case) reports `prepare() attempts: 16 | completed server-side: 15 | state: booting | endpoint recorded: null`. `probe/converge-fast.ts` with a fast guest reaches `waiting` in one attempt, confirming the mechanism is the bound and not a defect in the fake.

**Why existing guards/tests do not prevent it.** `SWARMFORGE_PROVISION_TIMEOUT_SECONDS` (`config.ts:86`) is the only backstop and is 300 s — it converts a livelock into a failure, not into success. The `catch` in `step()` (`coordinator.ts:510-526`) deliberately retries provider errors "within deadline", so it actively re-triggers the livelock. `exclusive()` (`coordinator.ts:251-257`) serialises `step()` per worker, which bounds concurrency but does not prevent sequential retries. No test drives `prepare()` slower than the bound: `tests/helpers.ts:48-51` returns immediately, and `tests/adapters.test.ts:138-170` calls `provider.prepare()` directly with no coordinator and no bound at all. `tests/lifecycle.test.ts` (34 tests) and `tests/adapters.test.ts` (7 tests) both pass unmodified — exit 0 — because nothing exercises the slow-bootstrap path.

**Recommendation.** Give `prepare()` a bound that exceeds the sum of its own internal budgets (e.g. `GIT_PUSH_TIMEOUT_MS + 4 * API_TIMEOUT_MS`), or better, make `prepare()` internally abortable and pass an `AbortSignal` into `bounded()` so an abandoned attempt stops instead of being silently duplicated. Track the in-flight `prepare()` per worker and skip the retry while one is outstanding.

### F2 — MEDIUM — Abandoned `prepare()` retries race each other on shared guest paths, corrupting the clone and the temporary Git credential

**File/line (exact target):** `src/providers/freestyle.ts:126` (staging dir), `:129` (`rm -rf staging` inside the clone command), `:193` (credential paths), `:229-240` (`rm -f` cleanup in `withGitAuth`).

**Code trace.** The staging path is derived only from `w.worker_id`: `` `${workspace}/.swarmforge/repo-clone-${w.worker_id}` `` (`freestyle.ts:126`), and the credential files are fixed guest paths `["/opt/swarmforge/git-auth", "/opt/swarmforge/git-secret"]` (`freestyle.ts:193`). The clone command begins `rm -rf <staging> && ... git clone ... && mv <staging> <repository>` (`freestyle.ts:129`). `withGitAuth` writes the credential before the action and unconditionally `rm -f`s both files afterwards (`freestyle.ts:229-240`).

Because F1's `Promise.race` leaves the abandoned `prepare()` running, and `step()` retries on the next tick, two `prepare()` calls execute **concurrently against the same VM**. Attempt B's `rm -rf staging` deletes attempt A's in-flight clone target; attempt A's cleanup `rm -f` deletes the credential attempt B is mid-clone with.

**Concrete trigger.** Same as F1 (bootstrap slower than the outer bound) — the overlap is the same retry, seen from the guest side.

**Consequence.** Intermittent `Failed to clone SWARMFORGE_GIT_TREE into workspace/repo` (`freestyle.ts:134-137`) even when the network is fine; `withGitAuth`'s own `Failed to remove temporary Git credential from worker` (`freestyle.ts:239`); for `ssh` mode a clone whose key file vanishes mid-transfer; `mv` racing a half-written `staging` into `workspace/repo`. These surface as the same generic retry error, so the operator is pointed at the network rather than at a concurrency bug. The credential window also widens: the file is briefly present on a VM whose provisioning is about to be abandoned.

**Reproduction (executed).** `/tmp/rev-wc71d/probe/race.ts` models the two shared guest paths faithfully and instruments them. With inner bootstrap (660 ms) exceeding the outer bound (430 ms):

```
prepare starts: p1,p2 | maxConcurrent: 2
final state: booting | endpoint: null
clone failures: 2
  - p1: credential file deleted by a concurrent prepare (owner=p2)
  - p2: credential file deleted by a concurrent prepare (owner=null)
```

`/tmp/rev-wc71d/probe/stack.ts` shows the same at sustained scale (150 attempts over the provisioning window, `attempts whose rm -rf staging hit a live clone: 1`). `maxConcurrent` never exceeds 2 only because `exclusive()` serialises `step()` — the abandoned promise escapes that lock, which is precisely the defect.

**Why existing guards/tests do not prevent it.** `exclusive()` (`coordinator.ts:251-257`) guards *entry* to `step()`, not the lifetime of the promise `bounded()` abandons, so it gives a false sense of safety here. `withGitAuth`'s cleanup is in a `finally`-equivalent but its `rm -f` is unconditional, so it actively causes the race rather than containing it. As with F1, no test makes `prepare()` slow: `tests/helpers.ts:48-51` is instantaneous and `tests/adapters.test.ts:138-170` exercises `prepare()` serially with no coordinator. Nothing asserts that a retry cannot overlap an in-flight attempt.

**Recommendation.** Make the attempt single-flight per worker (F1's fix covers this), and/or make the staging directory and credential paths attempt-scoped (e.g. include a random suffix) so an abandoned attempt cannot collide with its successor. Consider having `withGitAuth` verify the credential still belongs to the current attempt before removing it.

### F3 — LOW (code-evidenced, not reproduced against the real API) — `createWorker`'s slug pre-check does not prevent duplicate VMs under a create-timeout

**File/line (exact target):** `src/providers/freestyle.ts:44-47` (pre-check), `:48-86` (create), bound at `src/coordinator.ts:457`.

**Code trace.** `createWorker` first does `const existing = await this.getWorker(slug); if (existing) return existing;` (`freestyle.ts:46-47`), then `this.client.vms.create({ slug, ... })` (`freestyle.ts:48`). This check-then-create is not atomic. The create is bounded by `SWARMFORGE_API_TIMEOUT_MS` (`coordinator.ts:457`); the freestyle SDK backgrounds long requests and polls (`node_modules/freestyle/dist/client.js`, `BACKGROUND_AFTER_SECS = 5`), so a slow create can outlive the bound and keep running provider-side after `bounded()` rejects. The next tick calls `createWorker` again; if the first VM is not yet visible to `vms.get(slug)`, the pre-check passes and a **second VM is created for the same worker**.

**Concrete trigger.** VM creation slower than `SWARMFORGE_API_TIMEOUT_MS` (30 s default) combined with a gap before the first VM becomes listable by slug.

**Consequence.** Two VMs carrying the same `metadata.worker_id`. Only one is recorded on the worker; the other is billable and unreferenced. Recovery partially mitigates: `recover()` (`coordinator.ts:365-396`) adopts or flags untracked VMs, so the second VM does eventually surface as a `recovery_required` orphan record rather than leaking silently — the design intent at `coordinator.ts:381-395` holds. Residual impact is a duplicate billable VM plus a spurious recovery record requiring operator cleanup.

**Reproduction status.** **Not reproduced against the real Freestyle API** — that would require real infrastructure, which is out of scope for this review. Reproduced only against a local fake that models slug-visibility lag (`/tmp/rev-wc71d/probe/dup-create.ts`): `VMs created for ONE worker record: 2`, `max concurrent createWorker: 3`, record keeps the second VM. The probe establishes the coordinator-side mechanism; it does **not** establish that the real API exhibits the visibility gap. Flagged as a hypothesis worth confirming, at LOW severity given the recovery net.

**Why existing guards/tests do not prevent it.** `recover()` catches it *after the fact* (every 30 s, `coordinator.ts:308`), it does not prevent the duplicate. `tests/lifecycle.test.ts:179-199` covers restart-during-provisioning adoption and unknown-orphan retention, but not duplicate creation for one worker. `tests/helpers.ts:31-42` `FakeProvider.createWorker` keys by `vm-${w.worker_id}` and would silently overwrite a duplicate, so the existing harness cannot express this failure.

**Recommendation.** Pass an idempotency key to `vms.create` if the API supports one; otherwise record an in-flight `createWorker` per worker and refuse to re-enter while one is outstanding (same single-flight fix as F1/F2), and treat a same-slug VM found in `recover()` as adoption rather than orphan creation.

## Findings summary

| # | Severity | Area | Confidence |
|---|---|---|---|
| F1 | HIGH | `prepare()` outer bound < inner budget → livelock, endpoint lost | Reproduced (local fake, exact default ratios) |
| F2 | MEDIUM | Concurrent `prepare()` retries race on staging dir + Git credential | Reproduced (local fake modelling shared guest paths) |
| F3 | LOW | Duplicate VM from non-atomic slug pre-check | Code-evidenced + local fake; real API behaviour unverified |

## Tests and probes run

Bun 1.4.2 (`/tmp/bun142/bun-linux-x64/bun`), all executed in `/tmp/rev-wc71d/repo`.

| command | result |
|---|---|
| `bun install --frozen-lockfile` | 125 packages, lockfile untouched |
| `bun test tests/lifecycle.test.ts` | **34 pass, 0 fail**, 114 expect(), exit 0 |
| `bun test tests/adapters.test.ts` | **7 pass, 0 fail**, 19 expect(), exit 0 |

Targeted probes (all under `/tmp/rev-wc71d/probe/`, outside the source checkout, all against the real `Coordinator` with local fake providers — no real cloud or model provider was contacted):

- `threshold.ts` — sweeps `prepare()` duration across the outer bound; locates the convergence cliff.
- `converge.ts` / `converge-fast.ts` — staged sleeps matching the four shipped inner `timeoutMs` values vs. a fast guest.
- `race.ts` — models the shared staging directory and credential paths; detects the mid-clone credential deletion.
- `stack.ts` — sustained retry load across the provisioning window.
- `dup-create.ts` — models slug-visibility lag; shows duplicate VM creation.
- `overlap.ts` / `overlap2.ts` / `concurrent-prepare.ts` — earlier probes establishing the abandoned-promise overlap.

Full suite was **not** run (reserved for the whole-suite reviewer) and no packaging/compile was performed (out of scope).

## Limitations

- No real Freestyle/OpenCode/model endpoint was contacted, per instructions. F3's real-API behaviour is therefore unverified.
- F1 and F2 are reproduced against local fakes that reproduce the coordinator's timing and the guest paths named in the source. They demonstrate the coordinator-side mechanism exactly; they do not measure how often a real guest exceeds 150 s.
- Credential-shaped values in probes are the repo's own non-secret test literals; no real credentials appear in this report or in any probe output.
- Reviewer artifacts (`/workspace/.swarmforge/artifacts/`, `/workspace/.swarmforge/logs/`) are outside `/workspace/repo`, which remains at `5672ead2a526e07fea9ed11e58b3725e42013527` and clean.