# SwarmForge review — dispatch delivery scope

**Exact target reviewed:** `d428e0f730ed5649485732e95d39c32f5d6a8895` (branch `feature/binary-config-serve-20260930`)
**Verified via:** disposable detached clone at `/tmp/rev-d428`, `git rev-parse HEAD` = `d428e0f730ed5649485732e95d39c32f5d6a8895`.
**Assigned workspace:** `/workspace/repo` left untouched at baseline `5672ead2a526e07fea9ed11e58b3725e42013527`, `git status --porcelain` empty.
**Toolchain:** Bun 1.4.2 unpacked to `/tmp/bun142/bun-linux-x64/bun` (repo-pinned Bun is 1.3.14 and cannot read this `bun.lock`; lockfile was never rewritten). Experiment copy at `/tmp/probe` (disposable, outside the source checkout).

## Scope

Dispatch `pending -> sending -> sent -> completed/cancelled` transitions, exactly-once / idempotent
delivery boundaries, message loss and duplication, crash recovery.

Files read in full: `src/coordinator.ts`, `src/store.ts`, `src/domain.ts`, `src/providers/opencode.ts`,
`src/providers/freestyle.ts`, `src/safety.ts`, `src/mcp.ts` (tool wiring), `src/config.ts`,
`tests/helpers.ts`, `tests/lifecycle.test.ts`, `tests/restart.test.ts`, plus `docs/ARCHITECTURE.md`,
`docs/MCP-API.md`, `docs/WORKER-PROTOCOL.md`, `docs/OBSERVABILITY.md`.

Delta note: between baseline `5672ead` and the target, `src/coordinator.ts` changed only in shutdown
tracking (`track()`, `stopWaiters`, `startProvisioning`) and control gating — no change to the dispatch
state machine. `src/store.ts`, `src/domain.ts` and `src/providers/opencode.ts` are byte-identical to
baseline, so the dispatch logic reviewed here is long-standing, not newly introduced.

## Verdict: FINDINGS

### Finding 1 — HIGH — a follow-up acknowledged as `queued` is never delivered and wedges the worker permanently

**File / line:** `src/coordinator.ts:226-237` (root cause), with `src/coordinator.ts:220-224`
(the guard that is missing here), `src/coordinator.ts:561-580` (how the stale `sending` run is
produced), `src/store.ts:236-240` (`dispatch()` selection), `src/coordinator.ts:475-484`
(`step()` "ready" branch).

**Concrete trigger:**

1. A dispatch is in state `sending` and the submit outcome is unknown — a coordinator crash between
   `claimDispatch` and the OpenCode acknowledgement, or a connection-level `promptAsync` failure.
   `deliver()` (`src/coordinator.ts:528-534`) has already committed `sending`, and the `catch` in
   `step()` (`src/coordinator.ts:510-526`) leaves the run in `sending` because `fallback()` only
   accepts a `result.json` whose `run_id` matches the new run.
2. `monitor()` (`src/coordinator.ts:568-579`) finds no message with `d.message_id`, sees the session
   idle, and once `Date.now() - d.sent_at > SWARMFORGE_API_TIMEOUT_MS` (default 30s) moves the worker
   to `recovery_required`. **It does not call `cancelDispatches`, so the run stays `sending` forever.**
3. The operator pauses the retained VM to inspect it — the action the emitted error text
   ("Prompt delivery ambiguous; inspect session before sending a follow-up") and
   `docs/MCP-API.md:29` both point at. The worker becomes `paused` with
   `previous_state: "recovery_required"`.
4. The lead calls `send_worker_message`. `queueMessage()` takes the `w.state === "paused"` branch at
   `src/coordinator.ts:226-237`, which only patches `previous_state` to `"booting"` and enqueues the
   new run. It never cancels the stale `sending` run, because the `cancelDispatches(id)` call is
   gated on `w.state` being `failed`/`recovery_required` (`src/coordinator.ts:220-224`) and this
   worker's *current* state is `paused`.
5. `resume` sends the worker to `booting` -> `ready`. `step()` then calls
   `this.store.dispatch(id)`, which returns the **oldest** non-terminal run
   (`src/store.ts:236-240`) — still the stale `sending` one, not the newly queued `pending` run.
   `d.state !== "pending"`, so `step()` takes the monitor branch
   (`src/coordinator.ts:478-483`) and re-enters the ambiguity check, which returns the worker to
   `recovery_required` on the very next tick.

**Consequence:**

- The run returned by `send_worker_message` is reported as `{ delivery: "queued", run_id, state:
  "paused" }` and is then silently dropped in practice: it stays `pending` forever and is never
  submitted. Confirmed message loss with a misleading acknowledgement.
- The worker is permanently wedged in `recovery_required`. It is terminal
  (`src/domain.ts:14-19`), so `runTick` filters it out (`src/coordinator.ts:344-349`) and
  `runRecover` returns early for terminal states (`src/coordinator.ts:420`). There is no deadline, no
  token-progress budget and no ambiguity timer that can clear it, because `monitor()` is never
  entered again. Verified stable after 30 coordinator ticks.
- Every subsequent `send_worker_message` is also accepted and also never delivered (probe B observed
  two acknowledged `pending` runs and one total submit). Only an explicit `cancel`/`destroy` clears it
  (probe C: cancel moved both runs to `cancelled`).
- The same root cause also stalls a follow-up queued behind a stale **`sent`** run: the destroy
  quiesce path at `src/coordinator.ts:919-926` reaches `recovery_required` without cancelling
  dispatches, and after pause/resume the follow-up stayed `pending` with `submits: 1`
  (probe C3). In that variant the stale run may eventually drain, but only via the token-idle or
  deadline failure budget, which then cancels the follow-up too.

**Reproduction (reproduced, local fakes only):** `/tmp/probe/tests/rev-dispatch-finding.test.ts`,
run with Bun 1.4.2. Log: `/workspace/.swarmforge/logs/dispatch-probe.log` (exit 1, 1 fail / 1 pass).

```
accepted: {"run_id":"90b1cd94-...","state":"paused","delivery":"queued"}
after 30 ticks -> recovery_required | submits: 1 | runs: sending,pending
acknowledged follow-up run state: pending
```

The same file's CONTROL case shows the mechanism: with the worker **not** paused, the
`cancelDispatches` branch at `src/coordinator.ts:220-224` fires, the stale run becomes `cancelled`,
and the follow-up is submitted (`submits: 2`).

**Why existing guards and tests do not prevent it:**

- The teardown guards (`this.tearingDown`, `w.intent === "cancel" | "destroy"`,
  `src/coordinator.ts:201-208`) only cover in-flight teardown; they say nothing about stale dispatch
  rows, and `tearingDown` is long released by the time the message arrives.
- The `store.dispatch(id)` "oldest open run wins" rule is correct for turn ordering, but it is
  applied unconditionally in the revive path with no check that the selected run is still the one the
  revive intends to resume.
- `src/coordinator.ts:197-200` states the invariant "no run is ever acknowledged as 'queued' and then
  silently removed by a cancel, destroy or failure the caller did not order after it". This finding is
  the mirror case: the run is acknowledged and then silently *stranded* by a revive that never cancels
  its predecessor, so the documented invariant is not actually upheld for the paused-revive path.
- `tests/lifecycle.test.ts` covers the paused-revive path only for `previous_state === "completed"`
  (line 407 asserts a throw for `vm_missing`; lines 118/292 cover pause/resume budgets) and covers
  `recovery_required` + message only *without* pause (line 655, "a message is accepted again once the
  failed lifecycle operation has settled"). No test combines a paused worker whose `previous_state` is
  `recovery_required` with a follow-up message, which is exactly the broken combination.
- A fix candidate was validated in a throwaway `/tmp` test: adding
  `cancelDispatches(id)` to the `w.state === "paused" && terminal.has(w.previous_state)` branch
  (skipping the already-throwing `cancelled` case) makes the follow-up submit (`submits: 2`).

**Recommended correction:** inside the `src/coordinator.ts:226-237` branch, before
`this.store.enqueue(...)`, cancel every non-terminal run for the worker when `previous_state` is a
terminal state other than `cancelled` — the predecessor turn is already over, so any still-open run
is undeliverable and only `store.dispatch()` can select it again. Alternatively, make the revive
explicit about which run it resumes: refuse (or `recovery_required`-report) instead of acknowledging
`delivery: "queued"` when `store.dispatch(id)` is not the run just enqueued. Applying the same
treatment to the `src/coordinator.ts:919-926` quiesce path (which also reaches a terminal state with
open runs) would close the `sent`-state variant.

### Finding 2 — LOW — `send_worker_message` has no idempotency key, so client retries duplicate turns

**File / line:** `src/coordinator.ts:192-250` (`message`/`queueMessage`), `src/mcp.ts:120-126`
(tool schema `{ worker_id, message }`).

**Trigger:** a lead retries `send_worker_message` after a transport/MCP timeout without having
received the response. `Store.enqueue` (`src/store.ts:213-228`) unconditionally inserts a new
`run_id`/`message_id`; there is no caller-supplied key to collapse the retry, unlike `spawn_worker`,
which is explicitly documented as retry-safe via `request_id` (`src/mcp.ts:73`,
`src/store.ts:75-85`).

**Consequence:** the same instruction is delivered to the worker as two separate turns, which for a
coding worker means duplicated edits, commits and verification work in the guest repository. This is
at-least-once semantics, so it is not silent corruption, but it is a real gap against the
exactly-once framing the rest of the dispatch machinery is built around.

**Why not guarded:** `docs/MCP-API.md:29` only prescribes `request_id` reuse for creation, so this is
a deliberate-looking API omission rather than a code regression. Confidence that the behaviour is as
described: high (code-evidenced). Confidence that it is a defect rather than accepted design: low —
flagged so the boundary is explicit, not to demand a change.

**Recommended correction:** accept an optional `request_id` on `send_worker_message` and key the
dispatch on it (e.g. a `UNIQUE(worker_id, request_id)` index plus a body fingerprint check mirroring
`Store.create`), so retries are collapsed exactly as creation retries are.

## Reviewed and found sound (no defect)

- **Single-delivery guarantee inside one process.** `deliver()` is only entered when
  `d.state === "pending"` (`src/coordinator.ts:477`), and `claimDispatch` flips the run to `sending`
  inside a transaction together with the `running` transition (`src/store.ts:251-264`), so the
  pending -> sending edge is atomic. `exclusive(worker_id)` serialises `step`, `control` and
  `recover`, and `tick()` is guarded by `this.ticking`, so no duplicate `submit` for the same
  `run_id` is reachable. The `message_id` is also passed to OpenCode as `messageID`
  (`src/providers/opencode.ts:96`), giving a provider-side idempotency key.
- **Crash recovery of an interrupted submit.** After a restart, a `sending` run on a `running` worker
  is resolved by stable message ID in `monitor()` (`src/coordinator.ts:561-567`) and is never blindly
  replayed; the ambiguous case escalates to `recovery_required` instead. This matches
  `docs/ARCHITECTURE.md:24`. `tests/restart.test.ts` covers database reopen retaining VM, session,
  result and tokens.
- **Duplicate completion / duplicate usage.** `Store.finish` re-reads the run and no-ops when it is
  already `completed`/`cancelled` (`src/store.ts:277-299`); usage is keyed by
  `(worker_id, message_id)` with monotonic max-upsert (`src/store.ts:307-322`). Covered by
  "duplicate completion is harmless" in `tests/lifecycle.test.ts`.
- **Stale result files cannot complete the wrong run.** `fallback()` requires
  `r.run_id === d.run_id` and, when present, a matching `worker_id`
  (`src/coordinator.ts:685-687`), so a `result.json` left by a previous turn cannot settle a new one.
- **Acknowledged-but-dropped runs around teardown.** `fail()`, `applyControl` cancel/destroy and the
  `store.ts:775/799/935/953/968` cancellation points hold `tearingDown` across provider round-trips,
  and `queueMessage` refuses while it is set. Verified by the existing tests at
  `tests/lifecycle.test.ts:551`, `:588`, `:616`, `:640`, `:655`.
- **Queue-full accounting** uses the same non-terminal predicate as `store.dispatch()`
  (`src/coordinator.ts:213-219`, `src/store.ts:236-240`), so the 100-turn cap cannot be bypassed by
  stranded runs being invisible to the cap.

## Tests and probes

- `bun test tests/lifecycle.test.ts tests/restart.test.ts tests/wait.test.ts
  tests/session-status.test.ts tests/token-idle.test.ts tests/core.test.ts`
  → **exit 0, 81 pass / 0 fail, 302 assertions** (Bun 1.4.2). Log:
  `/workspace/.swarmforge/logs/inscope-tests.log`.
- Reviewer probe `tests/rev-dispatch-finding.test.ts` (defect case + control case, local fakes only)
  → **exit 1, 1 pass / 1 fail**; the failure is the reproduced defect. Log:
  `/workspace/.swarmforge/logs/dispatch-probe.log`.
- Two throwaway probe files were also run during triage and then deleted (a three-case wedge/control
  set and a fix-candidate check); their outcomes are quoted inline above. No probe contacted a real
  provider, model endpoint, VM or network service.

## Limitations

- No full-suite run and no compile/package step: out of scope for this reviewer (whole-suite and
  packaging scopes own those). `bun run check` was not executed.
- All reproduction used the repository's own `FakeProvider`/`FakeAgent` doubles. The post-crash
  `sending` state was constructed directly through `Store.saveDispatch` because a real crash cannot be
  staged in-process; that is the exact persisted shape `claimDispatch` commits, so the state machine
  entry condition is faithful. Nothing was verified against a live Freestyle VM or a real OpenCode
  server, so the real-world timing of the 30s ambiguity escalation and OpenCode's
  `messageID` idempotency behaviour are code-evidenced only.
- The `sent`-state variant (Finding 1, second paragraph) was observed with a hand-built
  `recovery_required` state rather than by driving the full destroy/quiesce sequence; its severity is
  therefore lower and partly unverified.
- No credentials, tokens, or credential-shaped example values appear in this report or in the logs.
