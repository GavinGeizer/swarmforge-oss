# Swarmforge reviewer report — scope 30

- **Exact target reviewed:** `d428e0f730ed5649485732e95d39c32f5d6a8895` (branch `feature/binary-config-serve-20260930`)
- **Verdict:** FINDINGS
- **Reviewer workspace:** disposable clone `/tmp/rev30/repo` (detached at target, `git rev-parse HEAD` verified). `/workspace/repo` left untouched on baseline `5672ead`, clean.
- **Scope:** token accounting / progress / excerpt sanitation; cumulative vs per-run usage; misleading inference counts.
- **Toolchain:** official Bun 1.4.2 installed under `/tmp/rev30/bun142`; `bun install --frozen-lockfile` in the disposable clone only. Lockfile never rewritten.
- **Sanitizer note:** all secret-shaped material below is described by role/config key name only; no real or canary credential values are reproduced. Secrets referenced are the project's own synthetic test fixtures.

## Files examined (target)

`src/providers/opencode.ts`, `src/coordinator.ts`, `src/store.ts`, `src/security.ts`, `src/metrics.ts`, `src/mcp.ts`, `src/domain.ts`, `src/cli/overview.ts`, `src/cli/client.ts`, `src/http.ts`, `docs/OBSERVABILITY.md`, `docs/MCP-API.md`, `docs/ENVIRONMENT.md`, `tests/{token-idle,excerpt,session-status,core,overview,api}.test.ts`, `tests/helpers.ts`.

---

## Finding 1 — HIGH — Excerpt redaction is bypassed by invisible code points that are deleted *after* redaction

**File/line:** `src/security.ts:96-109` (`excerptText`), reached from `src/coordinator.ts:651`.

**Trigger.** Assistant text containing a configured secret with a terminal-invisible code point inserted inside it, e.g. the configured model API key rendered as `model-` + U+200B + `secret` (also reproduced with U+200C, U+200D, U+FEFF, U+00AD, U+0001, U+0007, U+001F, U+0085, U+0091, U+009B, U+2028, U+202E, U+2060 — 13 distinct code points).

**Consequence.** `get_worker` returns the reassembled plaintext secret in `excerpt`. Reproduced end to end for:
- `SWARMFORGE_MODEL_API_KEY` and `FREESTYLE_API_TOKEN` (values from `tests/helpers.ts` fixtures),
- the worker's own `server_password`, i.e. the OpenCode guest HTTP Basic credential exported as `OPENCODE_SERVER_PASSWORD` (`src/providers/freestyle.ts:153`). A worker that knows only its own password could exfiltrate it, or another worker's password if it obtained it.

**Trace.** `excerptText` runs `redact(value)` first (`src/security.ts:97`), then strips invisibles (`isInvisible(code) ? "" : chars[index]`, line 107). Splitting a secret with U+200B defeats the `replaceAll` in `Redactor.text`; the subsequent strip deletes the splitter and *rejoins* the halves into the exact secret. The file comment at line 95 asserts the opposite ("redact before trimming so a secret split by truncation is never partially revealed") — the same ordering causes the full secret to be reconstructed.

**Reproduction (local, no provider calls).** `/tmp/rev30/probe/confirm.test.ts` C1/C2, log `/workspace/.swarmforge/logs/rev30-confirm-probe.log`:
```
C1 rejoin count: 13 cps: U+200b,U+200d,U+200c,U+feff,U+ad,U+1,U+7,U+85,U+91,U+9b,U+2028,U+202e,U+2060
C2 leaks own server password: true
```

**Why existing guards do not help.** `tests/excerpt.test.ts:91-110` only asserts direct-containment redaction and control stripping. An ANSI-split secret is neutralised correctly (`\u001b[0m` becomes a space) but no test splits a secret with an invisible code point. `Redactor.value()` is unaffected (`Redactor.value` never strips invisibles), so only the excerpt path is exposed — which narrows impact but leaves it real.

**Recommendation.** Sanitize invisible code points first, then redact, then apply terminal-escape/whitespace collapsing — i.e. move the redaction call after the character loop (or pre-strip invisibles before invoking `redact`). Add a regression test asserting `excerptText` output for a secret split by U+200B and U+0007.

---

## Finding 2 — HIGH — `inference` gauge and excerpt entries survive reconciliation and out-of-band loss, permanently overstating activity

**File/line:** `src/coordinator.ts:421-432` (reconcile `paused` / `recovery_required`) and `src/coordinator.ts:486-503` (poll-time `paused` / lost guest). Contrast the guarded paths at `src/coordinator.ts:408-411`, `:849-850`, `:892-893`, `:966-967`.

**Trigger.** Any of:
1. Guest `state === "paused"` seen by `runRecover` → worker transitions to `paused` (line 425).
2. Guest `state === "stopped"` seen by `runRecover` → `recovery_required` (line 430).
3. `getWorker` returns null in `step()` → `failed` (line 490).
4. Guest `paused`/`pausing` seen in `step()` → `paused` (line 498).

**Consequence.** `this.inference` and `this.excerpts` are never cleared on these four transitions. A settled/terminal worker keeps contributing `inference_active=1` forever:
- `swarmforge_inference_requests_active` reports 1 for a `recovery_required` worker that will never run again (verified stable across 5 further tick+recover cycles).
- `get_swarm_status.inference_requests_active` (`src/mcp.ts:287`) likewise over-reports.
- `get_worker` on a `failed` worker still returns `excerpt`/`excerpt_partial`/`excerpt_at`, contradicting `docs/MCP-API.md:8` ("absent once the worker settles") and `:35` ("cleared when a turn settles or a new dispatch starts").
- Unbounded memory growth: two entries per settled worker, never reclaimed (`Map` has no eviction).

The reconcile path is the realistic route: `runTick` calls `recover()` **before** the per-worker `step()` loop (`src/coordinator.ts:308-314`), so a stopped/paused guest is normally reconciled into a terminal/paused state and never re-inspected. The lost-guest case in `step()` self-heals on the *next* reconcile, leaving a window in which a `failed` worker advertises a live excerpt.

**Reproduction.** `/tmp/rev30/probe/confirm.test.ts` C3/C4/C5 and `/tmp/rev30/probe/recoverfirst.test.ts` R1/R2, logs `rev30-confirm-probe.log`, `rev30-reconcile-probe.log`:
```
C3 failed gauge: 1 swarmforge_inference_requests_active 1 excerpt: "partial model output"
C4 paused gauge: 1 excerpt: {"text":"partial model output",...,"partial":true}   (after 5 tick+recover cycles)
C5 recovery_required gauge: 1                                                        (after 5 tick+recover cycles)
```
Control case: `control(id,"pause")` (`src/coordinator.ts:849`) *does* clear both maps — `gauge: 0, excerpt: null` — proving the invariant is intended, not optional.

**Why existing guards do not help.** `tests/excerpt.test.ts:176-248` covers completion, `fail()`, cancel, destroy and new dispatch; no test covers reconcile-driven `paused`/`recovery_required` or poll-time guest loss. No test anywhere asserts the inference gauge after these transitions (`grep inference tests/*.test.ts` matches only `tests/session-status.test.ts` adapter-level checks).

**Recommendation.** Clear `this.inference` and `this.excerpts` in all four transitions (or centrally in `Store.transition`/`patch` when a worker leaves `running`/`waiting` without a result, since both maps are keyed by worker id). Gate `publicWorker`'s excerpt on `!terminal.has(w.state) && w.state !== "paused"` so the documented contract holds even if a cleanup path is missed.

---

## Finding 3 — MEDIUM — `swarmforge_tokens_total` labels every token row with the configured model, discarding the recorded per-message model

**File/line:** `src/metrics.ts:84-99` (label at line 95) against the stored column at `src/store.ts:30` and `src/store.ts:307-321`.

**Trigger.** Any assistant message whose `modelID` differs from `SWARMFORGE_MODEL_NAME` — e.g. OpenCode auxiliary/small-model calls (title generation, summarization) or a model override in the worker session.

**Consequence.** `metrics.render()` iterates workers and calls `store.tokens({worker_id})`, which sums all five directions with no model grouping, then `tokens.inc({team, model: this.c.config.SWARMFORGE_MODEL_NAME, direction}, …)`. All rows collapse onto one `model` label; the `usage.model` column written at insert time is never read. Prometheus `sum by (model)` and any per-model cost attribution is wrong, and `docs/OBSERVABILITY.md:16` advertises a `{team,model,direction}` breakdown that the code does not produce.

**Reproduction.** `/tmp/rev30/probe/confirm.test.ts` C6: inserting `usage(worker_id,"m1","aux-model",11,0,0,0,0)` renders `swarmforge_tokens_total{team="other",model="qwen",direction="input"} 11`; the row stored under `aux-model` is reported as `qwen`.

**Why existing guards do not help.** `docs/OBSERVABILITY.md:19` states counters are reconstructed from SQLite and that usage is keyed by worker/message — nothing asserts label fidelity, and no test in the repository inspects the `model` label.

**Recommendation.** Select usage grouped by `model` (`SELECT model, sum(input), … GROUP BY model`) and emit one `tokens.inc` per recorded model; keep the configured name only as a fallback for rows with an empty model.

---

## Finding 4 — MEDIUM — Progress/excerpt helpers are keyed on the *current* dispatch, so a re-queued turn can leak the previous turn's text

**File/line:** `src/coordinator.ts:637-663` (`trackExcerpt`, filter at 638-639) and `src/coordinator.ts:612-618` (token-progress baseline derived from `this.store.dispatch`).

**Trigger.** `send_worker_message` enqueues a follow-up while an earlier dispatch is still `sent`/unresolved, then the earlier one is cancelled (`store.cancelDispatches`, e.g. from `fail()` or `queueMessage` at `src/coordinator.ts:223`), leaving the follow-up as `store.dispatch()`'s answer.

**Consequence.** `trackExcerpt` only accepts assistant messages whose `parent_id === d.message_id`. Messages belonging to the abandoned dispatch are ignored, so the live excerpt disappears (`this.excerpts.delete`, line 643) even though the guest is still streaming for the newly-current dispatch — misleading progress reporting. Conversely, once a message from the *previous* turn is parented to the newly current dispatch id after a retry, stale text is presented as the current turn's live output.

**Reproduction.** Partially confirmed at the unit level: `tests/excerpt.test.ts:204-212` already exercises a stale prior-turn message and asserts the excerpt stays `null` — the guard works for the case it covers. The leak direction is *code-evidenced* only; I did not build a full cancel-then-requeue coordinator sequence, so confidence is medium.

**Why existing guards do not help.** No test drives `queueMessage` + `cancelDispatches` + `trackExcerpt` together; `tests/excerpt.test.ts` only sets snapshots directly.

**Recommendation.** Track excerpt candidates across all unresolved dispatches for the worker rather than only `store.dispatch()`'s single record, and stamp the excerpt with its originating `message_id` so text from a superseded run can never be shown as current.

---

## Tests run (actual execution, Bun 1.4.2, disposable clone)

Targeted existing suites — all pass at target:
- `bun test tests/token-idle.test.ts tests/excerpt.test.ts` → 20 pass / 0 fail
- `bun test tests/session-status.test.ts tests/core.test.ts` (added to the above run) → 42 pass / 0 fail across 4 files, 162 assertions
- `bun test tests/overview.test.ts tests/api.test.ts` → 18 pass / 0 fail

Reviewer probes (all outside the source checkout, in `/tmp/rev30/probe`, importing the disposable clone):
- `/tmp/rev30/probe/confirm.test.ts` → 0 pass / 6 fail (C1–C6 each fail for the reason asserted; these are the reproductions above). Log: `/workspace/.swarmforge/logs/rev30-confirm-probe.log`
- `/tmp/rev30/probe/inv.test.ts` → 1 pass / 1 fail; enumerates the 13 re-joining code points. Log: `rev30-invisible-probe.log`
- `/tmp/rev30/probe/recoverfirst.test.ts` → 0 pass / 3 fail. Log: `rev30-reconcile-probe.log`
- `/tmp/rev30/probe/persist.test.ts` → 3 pass / 1 fail (persistence across 5 cycles). Log: `rev30-persist-probe.log`
- `/tmp/rev30/probe/reach.test.ts` → 1 pass / 1 fail (worker server password leak). Log: `rev30-reach-probe.log`

No cloud/model provider, VM, or network service was contacted. All probes used the repository's `FakeProvider`/`FakeAgent` and a stubbed `fetch`.

## Limitations

- Finding 4 is code-evidenced, not reproduced end to end; a full cancel-then-requeue sequence was not constructed within the time budget.
- Finding 3 assumes OpenCode can emit a `modelID` different from `SWARMFORGE_MODEL_NAME`; that was simulated at the store boundary rather than against a real OpenCode server.
- Finding 1 severity assumes the worker guest can read its own exported `OPENCODE_SERVER_PASSWORD` (it is set in the guest environment per `src/providers/freestyle.ts:153`); I did not boot a guest to confirm the guest process can read it.
- Full suite, packaging, and build scopes were intentionally not run (out of scope).
- `bun test` was not run on the whole suite; only the four targeted files above.