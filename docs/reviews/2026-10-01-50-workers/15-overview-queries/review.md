# Reviewer 15 — Overview aggregation, counts / latest result / current run / token accounting, pagination

- **Target SHA:** `d428e0f730ed5649485732e95d39c32f5d6a8895`
- **Branch:** `feature/binary-config-serve-20260930`
- **Assigned workspace (untouched, clean):** `/workspace/repo` @ `5672ead2a526e07fea9ed11e58b3725e42013527`
- **Disposable detached review checkout:** `/tmp/rv15/target` (verified `git rev-parse HEAD` = target)
- **Toolchain:** official Bun 1.4.2 at `/tmp/opencode/bun142` (snapshot bun is 1.3.14; lockfile untouched)
- **Verdict:** FINDINGS (3)

## Scope reviewed

`src/mcp.ts` (aggregation tools, pagination cursors), `src/store.ts` (`all`, `tokens`,
`result`, `events`, `tasks`, `teams`, `dispatch`, usage upsert), `src/security.ts`
(`publicWorker`), `src/cli/overview.ts` (grouping/counts/render), `src/cli/client.ts`
(overview pagination, inspect), `src/cli/tui.ts`, `src/coordinator.ts` (result/run
selection, `inference` map, `claimDispatch`, `recordProgress`), `src/metrics.ts`,
`src/domain.ts` (`states`, `terminal`, `resultSchema`), `docs/MCP-API.md`.

Delta note: `5672ead..d428e0f` does not touch `src/mcp.ts`, `src/store.ts`,
`src/security.ts`, `src/metrics.ts`, or `src/cli/overview.ts`/`client.ts` rendering. These
findings are pre-existing at both baseline and target, so they are latent, not
regressions from this branch.

## Findings

### 1. HIGH — `list_workers` pages can exceed the 128 KiB MCP cap; `swarmforge status` fails outright

- **File/line:** `src/mcp.ts:44` (cap), `src/mcp.ts:101-118` (`list_workers`),
  `src/cli/client.ts:77-80` (CLI sends `limit: 100`)
- **Trigger:** ~30 retained workers whose `error` is a long failed-result summary.
  `Store.finish` copies `result.summary` into `error` (`src/store.ts`, `finish`), and
  `resultSchema` allows `summary` up to 4000 chars (`src/domain.ts:44`). `publicWorker`
  returns that `error` verbatim for every row (`src/security.ts:143`).
- **Consequence:** `list_workers` with `limit:100` serialises >131072 bytes, `register()`
  throws "Response exceeds limit; request a smaller page", and the tool returns `isError`.
  The CLI `overview()` loop does not catch or shrink the page, so the whole
  `swarmforge status` / `bun run status` command errors out and no overview renders at
  all — the counts, token totals and worker lists all become unavailable.
- **Reproduction (reproduced):** in-memory MCP server + client, 40 failed workers with
  4000-char summaries. `list_workers{limit:20}` → not an error; `list_workers{limit:100}`
  → `isError: true`, text `Response exceeds limit; request a smaller page`. Replaying the
  verbatim `cli/client.ts` overview loop → `OVERVIEW FAILED`. Threshold sweep: 20 workers
  → 88,993 B (ok), 29 → 129,025 B (ok), 30 → 133,473 B (exceeds).
- **Why existing guards do not prevent it:** the cap at `src/mcp.ts:44` is the only guard
  and it is exactly what fires; it converts an oversized page into a hard tool error
  instead of a smaller page. The CLI hardcodes `limit: 100` with no error recovery or
  retry at a smaller page size. No test asserts page size against the cap
  (`grep "exceeds limit|131072" tests/` → no hits).
- **Recommendation:** make `list_workers` bound its own payload (drop/clip `error` to a
  short form for list views, or cap total bytes and return `next_offset` accordingly), and
  have `cli/client.ts` catch the oversized-page error and retry with a halved `limit`
  instead of propagating.

### 2. MEDIUM — Worker-detail TIMELINE renders the OLDEST events, not the newest

- **File/line:** `src/cli/client.ts:101-104` (`get_worker_logs {limit:100}`, no `after`),
  `src/cli/overview.ts:256` (`for (const event of events.slice(-8))`)
- **Trigger:** any worker with more than 100 durable lifecycle events. `Store.events`
  (`src/store.ts`) uses `WHERE id > after ORDER BY id LIMIT ?`, so `after=0` returns the
  *oldest* 100 events, not the newest. Each turn emits several events
  (`worker.running`, `result.received`, `worker.ready`), so ~30+ follow-up turns on one
  worker crosses 100 events — a normal pattern given `send_worker_message` follow-ups.
- **Consequence:** `renderWorkerDetail` shows `events.slice(-8)` of the oldest page. The
  operator inspecting a worker sees a stale timeline from early turns while the actual
  latest transitions (including `worker.completed`/`failed`/`destroyed` of the current
  run) are invisible. This directly undermines "confirm the current run" during inspection.
- **Reproduction (reproduced):** 40 simulated follow-up turns → 121 events. Default page
  ends at event id 100; newest event in the whole log is id 121. With deterministic
  one-minute event timestamps, the rendered TIMELINE ends at `01:40:00` while the true
  newest event is `02:01:00`; the newest timestamp never appears in the rendered view.
- **Why existing guards do not prevent it:** the cursor semantics are correct for an
  ascending forward log, but nothing reverses or pages to the tail. `client.inspect`
  passes no cursor and never follows `next_offset`; `get_worker_logs` has no `total`/
  reverse-cursor affordance. `tests/overview.test.ts` only exercises 2-event timelines
  (lines 108-113), far below the 100-event page size.
- **Recommendation:** in `client.inspect`, page to the tail (request the last page via a
  `latest`-anchored cursor or iterate `after` to exhaustion and keep the final page), and
  render from that. Cheaper alternative: add a bounded reverse read in `Store.events`
  (`ORDER BY id DESC LIMIT ?` then reverse) and use it for the detail view.

### 3. MEDIUM — Stale `inference` entries permanently inflate `get_swarm_status` / metrics

- **File/line:** `src/coordinator.ts` `reconcile()` pause branch (transition to `paused`,
  ~line 419-424) and `step()` pause branch (~line 500-506); `src/mcp.ts:287-290`
  (`inference_requests_active`); `src/metrics.ts:80` (`swarmforge_inference_requests_active`)
- **Trigger:** a worker is running with an in-flight assistant message
  (`snapshot.inference_active = 1`), then the guest is paused out of band (operator or
  provider auto-pause). Both the `reconcile()` and `step()` paths transition the worker to
  `paused` **without** calling `this.inference.delete(worker_id)` — unlike the
  control-intent pause path (`applyControl`), which does delete.
- **Consequence:** `coordinator.inference` keeps `{worker_id: 1}`. Because `runTick`
  filters out `paused` workers, `step()` never runs again for it and `monitor()` never
  refreshes the value, so the entry is never corrected until some other lifecycle action
  happens. `get_swarm_status.inference_requests_active` and the Prometheus gauge
  `swarmforge_inference_requests_active` over-report active inference for the life of the
  paused worker — a permanently wrong aggregate used for capacity/observability decisions.
- **Reproduction (reproduced):** harness worker driven to `running`; snapshot forced to
  `busy`/`inference_active:1`; tick → estimate `1`; provider VM set to `paused`; tick +
  `recover()` + tick → worker `paused`, estimate still `1`, map still holds
  `[worker_id, 1]`.
- **Why existing guards do not prevent it:** deletion is scattered across `complete`,
  `fail`, `applyControl` pause/cancel/destroy and the reconcile *missing-VM* branch; the
  two pause-detection branches omit it. `tests/session-status.test.ts:124` asserts the
  gauge reflects incomplete messages but never exercises an out-of-band pause, so no test
  catches the leak.
- **Recommendation:** clear the map entry in both pause branches (or delete entries for
  every worker not in an active state at the end of `runTick`/`reconcile`), so the
  aggregate is derived from currently-polled workers rather than accumulating history.

## Tests / probes run

- `/tmp/opencode/bun142 install --frozen-lockfile` in `/tmp/rv15/target` — exit 0,
  125 packages, lockfile not rewritten.
- `bun test tests/overview.test.ts tests/api.test.ts tests/cli.test.ts` — **20 pass, 0 fail**
  (exit 0), baseline green.
- `bun test tests/overview.test.ts tests/api.test.ts tests/cli.test.ts tests/session-status.test.ts tests/wait.test.ts`
  — **43 pass, 0 fail** (exit 0). These cover the scope's happy paths; none exercises a
  >100-event log, a >128 KiB page, or an out-of-band pause, which is why findings 1–3
  are unguarded.
- Reviewer probes (all outside the source checkout, under `/tmp/rv15/probes`, run with
  Bun 1.4.2 against real `Store`/MCP/`publicWorker`/`renderWorkerDetail` code):
  - `p1-events.ts`, `p3-timeline.ts`, `p4-timeline2.ts` → finding 2 (121-event log;
    rendered timeline stops at event 100).
  - `p5-page-limit.ts`, `p7-threshold.ts`, `p8-threshold2.ts` → finding 1 (30 workers ×
    4000-char summary ⇒ 133,473 B page; threshold sweep 20/29/30).
  - `p6-mcp-cap.ts`, `p10-cli-loop.ts` → finding 1 end-to-end through `InMemoryTransport`
    with the verbatim `cli/client.ts` overview loop ⇒ `OVERVIEW FAILED`.
  - `p9-inference.ts` → finding 3 (paused worker retains `inference = 1`).
  - A temporary `.review-probes/` dir inside `/tmp/rv15/target` was used for module
    resolution and **deleted**; `git status --porcelain` there is clean.
- No real cloud/model providers, no VMs, no network smoke, no credentials used or emitted.

## Limitations

- Full suite was not run (out of scope; whole-suite reviewer's job).
- Findings 1 and 2 were reproduced with locally synthesized failure summaries and event
  histories rather than a real failed swarm; the code paths that produce them
  (`Store.finish` copying `summary` into `error`, one event per transition) are the
  shipped ones, so reachability follows, but no production incident was observed.
- Finding 1's exact byte threshold depends on `team_id`/`task_id`/`role` length; the
  quoted numbers use short identifiers. Larger identifiers lower the worker count needed.
- `get_swarm_status` counts, `get_task`/`get_team_status` totals and `store.tasks`/
  `store.teams` aggregates were traced and probed and found consistent; no defect found
  there. `result()` correctly returns the newest result and the run-scoped lookup by
  `run_id` (`src/store.ts`), and `list_workers`/`list_tasks`/`artifacts` `next_offset`
  arithmetic is correct — except for the interaction in finding 1.
- Credential-shaped values were not inspected; only redacted/non-secret test fixtures
  (`tests/helpers.ts`) were used.
