# SwarmForge review — idle/busy detection, absent session status, interrupted messages, false completion

- **Target reviewed:** `d428e0f730ed5649485732e95d39c32f5d6a8895` (published branch `feature/binary-config-serve-20260930`, remote `https://github.com/GavinGeizer/swarmforge-oss.git`).
- **Verification:** detached clone at `/tmp/opencode/rev29/repo`; `git rev-parse HEAD` → `d428e0f730ed5649485732e95d39c32f5d6a8895`.
- **Assigned workspace:** `/workspace/repo` left untouched at baseline `5672ead2a526e07fea9ed11e58b3725e42013527`, clean (`git status --short` empty). No source edits, commits, pushes or config changes.
- **Reviewer experiments:** only under `/tmp/opencode/rev29/probe` (outside the source checkout).
- **Verdict: FINDINGS** (1 MEDIUM, 1 LOW). Both reproduced locally with in-repo doubles.

## Scope actually read

- `src/providers/opencode.ts` — `inspect()` (105-170), `sessionStatus()` (183-188), `inference_active` estimate (162-164), message mapping/pagination (108-161).
- `src/coordinator.ts` — `monitor()` settle gate (535-635), the `step()` catch path (510-526), `fallback()` (673-691), `complete()` (692-719), token-idle stop (610-626), pause/resume clock shift (858-873).
- `src/domain.ts` — `AgentSnapshot.status` (222-227). `src/metrics.ts:80` gauge use. `src/cli/overview.ts:246` excerpt label.
- `src/providers/freestyle.ts:173` (`Restart=on-failure` for the OpenCode unit) and `88-95` (`getWorker` returns null only on 404).
- Tests read: `tests/session-status.test.ts`, `tests/token-idle.test.ts`, relevant `tests/lifecycle.test.ts` cases, `tests/helpers.ts` doubles.

Delta note: the branch delta (baseline `5672ead` → target) touches none of these files; `src/providers/opencode.ts` and `src/domain.ts` are byte-identical to the baseline, and the only `src/coordinator.ts` change is the shutdown/wait tracking added by the serve command. **Every finding below therefore pre-dates this branch** and is a review of existing code, not of the new delta.

## Findings

### 1. MEDIUM — A thrown status/inspect error completes a run from a result file with no idle evidence, bypassing the "settles only on reported idle" guard

- **File / line (exact target):** `src/coordinator.ts:519-525` (recovery inside the `step()` catch), contradicting the invariant documented at `src/coordinator.ts:556-560` and enforced in `monitor()` at `src/coordinator.ts:560` and `603-609`.
- **Concrete trigger:** any throw out of the `running`/`waiting` pass while `<workspace>/.swarmforge/result.json` exists with the current `run_id`:
  - the 30 s `bounded()`/`AbortSignal.timeout(SWARMFORGE_API_TIMEOUT_MS)` guard on every OpenCode request (`src/providers/opencode.ts:68-74`) firing while the OpenCode server is loaded or blocked;
  - connection reset / ECONNREFUSED during an OpenCode service restart (`Restart=on-failure`, `src/providers/freestyle.ts:173`) or a `4xx/5xx` from `/session/status` or `/session/messages` (`throwOnError: true`, `src/providers/opencode.ts:64`);
  - a Freestyle `getWorker` error/timeout at `src/coordinator.ts:487` (same `try`).
- **Consequence:** `complete()` runs with no status evidence at all. The run is stored as `completed` with the mid-turn result; with `github-app`/`ssh` push mode the branch is pushed and remote-verified and the result reports `persisted: true` (`src/coordinator.ts:693-704`) — while the session may still be generating. The worker becomes terminal, so `step()` never inspects it again: later assistant text, usage and commits are never collected. With the default `SWARMFORGE_GIT_PUSH_MODE: "none"` (`src/config.ts:50-52`) the completion happens with no push at all. `fallback()` only checks `run_id`/`worker_id` (`src/coordinator.ts:685-686`), so a file written mid-turn is indistinguishable from the final one.
- **Reproduction** (`/tmp/opencode/rev29/probe/probe-a.test.ts`, `probe-b.test.ts`, using the in-repo `FakeAgent`/`FakeProvider` doubles; no real providers, VMs or models):
  - Probe A: run to `running`, write a result file with the current `run_id`, snapshot = `status:"busy"` with an incomplete (`completed:false`) assistant message, then `agent.broken = true` (inspect throws) and `tick()`. Observed: `state: completed | error: null | result: "written mid-turn"`. Exit 0, 1 pass.
  - Probe C: same, then the probe recovers and `tick()` again. Observed: `state: completed | error: null | inference gauge: undefined` — the still-busy session is never polled again.
- **Why existing guards do not prevent it:** the settle gate lives in `monitor()`, which was never entered; the catch path re-reads the result file without ever re-polling status. `tests/session-status.test.ts:234` ("an unrecognized busy status does not complete a mid-turn result file") and `:257` ("a reported busy turn is not completed by its result file") assert exactly this guard **for the monitor path only**. `tests/lifecycle.test.ts:212` ("OpenCode crash after file completion still recovers structured output") codifies the opposite intent for the error path, but only with a genuinely final file. No test combines a thrown inspect with a mid-turn file, and no warning is attached to the stored result, so a status-unconfirmed completion is indistinguishable from a confirmed one in `get_worker_result`.
- **Recommended correction:** in the catch path, re-poll the session status once and only call `complete()` on an idle report; or require that the last observed snapshot for this dispatch was settled (`store`/in-memory flag) before recovering from the file; or, at minimum, append a `warnings` entry (e.g. `"completed from a result file while session status was unavailable"`) so the result is explicitly marked unconfirmed. Keep `tests/lifecycle.test.ts:212` passing by treating a genuinely final file as settled.
- **Confidence:** high — reproduced twice; the residual uncertainty is only how often a worker writes `result.json` before its final message (models do, and an OpenCode retry after a crash re-enters a turn with the file still present).

### 2. LOW — A lost turn (session vanished with an unfinished assistant message) is recorded as a healthy `waiting` turn and is only explained 5 minutes later by an unrelated error

- **File / line (exact target):** `src/coordinator.ts:603-609` (settled fallback returns nothing) and `src/coordinator.ts:627-634` (transition with `error: null` unless status is `retry`); excerpt label at `src/cli/overview.ts:246`; token-idle message at `src/coordinator.ts:620-623`.
- **Concrete trigger:** OpenCode restarts (systemd `Restart=on-failure`, `src/providers/freestyle.ts:173`), the turn is aborted, or a paused VM is resumed (`quiesce()` calls `agent.abort()` and stops the unit, `src/coordinator.ts:725-737`). The session then disappears from `/session/status` while the last assistant message has no `time.completed` (`src/providers/opencode.ts:140`, `162-164` → `inference_active: 1`).
- **Consequence:** the worker sits in `waiting` with `error: null` and a live `RESPONSE partial` excerpt that reads as in-flight, identical to a turn legitimately waiting on the model. The only later signal, after `SWARMFORGE_TOKEN_IDLE_TIMEOUT_SECONDS` (default 300), is `"No token progress for 300s; worker quiesced"`, which never mentions that the session is gone or that an unfinished message is stranded. An operator cannot distinguish "waiting on the model" from "turn already lost" without manual VM/session inspection — the 5-minute delay actively discourages that.
- **Reproduction:** `/tmp/opencode/rev29/probe/probe-b.test.ts` probe B — snapshot `status:"idle"`, `inference_active: 1`, assistant message `completed:false` with text, no result file, one `tick()`. Observed: `state: waiting | error: null | excerpt_partial: true | excerpt_text: "cut off mid sentence by the restart"`. Exit 0.
- **Why existing guards do not prevent it:** the status map legitimately omits sessions with no work, so `idle` is the only available signal (documented at `src/providers/opencode.ts:177-182`), and `inference_active` is already computed per snapshot — but it is used only for the metric gauge (`src/coordinator.ts:542`, `src/metrics.ts:80`). `tests/session-status.test.ts:123-133` asserts the estimate rather than using it for the durable record, and `tests/session-status.test.ts:275-293` asserts the end state (`waiting` → `failed` "No token progress") without asserting any diagnosis.
- **Recommended correction:** when `settled` is true but the newest assistant reply for the dispatch is incomplete (`inference_active === 1`), record a distinct error on the transition — e.g. `"OpenCode no longer reports the session and the last assistant message is unfinished; the turn may have been lost"` — and mark the excerpt as stranded rather than a live partial.
- **Confidence:** medium-high — the state/excerpt/error are reproduced; the "operator cannot tell" consequence is a judgement call about diagnostics, not a correctness failure.

## Checks performed that found nothing (recorded so they are not re-reviewed)

- `sessionStatus()` maps exactly the SDK's `SessionStatus` union (`idle|retry|busy` in `@opencode-ai/sdk` 1.18.31, `types.gen.d.ts:396-405`), so the `unknown` branch (`src/providers/opencode.ts:185-187`) is defensive/unreachable with the pinned SDK; an unrecognised type correctly never settles.
- Absent session → `idle` is the intended and tested shape (`tests/session-status.test.ts:113-121`); stale/incomplete history from an earlier dispatch cannot block a finished follow-up (`:193-232`).
- Dispatch `message_id` is unique (`src/store.ts:28`, `217`), so stale replies cannot match a new dispatch.
- Resume shifts `token_progress_at` by the paused duration (`src/coordinator.ts:866-868`; `tests/token-idle.test.ts:155`), so the pause/interrupt path does not cause an instant idle-stop.
- A failed status poll is not counted as a no-progress observation (`tests/token-idle.test.ts:139-153`).
- The `inference_active` gauge staying at 1 for a session holding any unfinished assistant message (`src/providers/opencode.ts:162-164`) is documented as an estimate (`docs/OBSERVABILITY.md:17`) and asserted by tests; not reported as a defect.
- `getWorker` returns `null` only on 404 (`src/providers/freestyle.ts:88-95`), so a Freestyle 5xx does not by itself produce the terminal "VM disappeared" state at `src/coordinator.ts:487-496`.

## Tests run (Bun 1.4.2 installed under `/tmp/opencode/bunhome`; the ambient `bun` is 1.3.14 and cannot read this `lockfileVersion: 2`)

| Command | Exit | Result |
| --- | --- | --- |
| `bun install --frozen-lockfile` (in the /tmp clone, lockfile untouched) | 0 | 125 packages |
| `bun test tests/session-status.test.ts tests/token-idle.test.ts tests/lifecycle.test.ts` | 0 | 59 pass, 0 fail, 192 expect() calls |
| `bun test probe/probe-a.test.ts` | 0 | 1 pass (false completion reproduced) |
| `bun test probe/probe-b.test.ts` | 0 | 2 pass (waiting/`error:null`/partial excerpt; stuck completion) |

Targeted only: the whole suite, compilation/packaging and `scripts/smoke.ts` were deliberately not run (other reviewers' scopes); no real cloud/model provider, VM or network smoke was used.

## Limitations

- No real OpenCode 1.18.31 server was available, so the "`/session/status` omits sessions with no work" premise is taken from `src/providers/opencode.ts:177-182` and the repo's tests, not from server behaviour. Findings depend on that premise only for the *frequency* of the states, not for the code paths.
- Findings 1 and 2 use the repository's own injected doubles (`tests/helpers.ts`, `OpenCodeAgent` with an injected `fetch`), so provider-specific error shapes (Freestyle/OpenCode) are inferred from the wrapper code, not observed.
- Line numbers are from the exact target checkout and were re-read after cloning; the assigned workspace at baseline was not modified.
- No credentials appear in this report; it was passed through the production `Redactor` (`src/security.ts:3-23`) with the repository's canary values before export.
