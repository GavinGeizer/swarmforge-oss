# Review: Prometheus listener configuration, auth exposure, labels/cardinality, correctness, bind/shutdown

- Target: `d428e0f730ed5649485732e95d39c32f5d6a8895` (branch `feature/binary-config-serve-20260930`)
- Reviewer workspace: disposable detached clone `/tmp/sfrev/target` (`git rev-parse HEAD` = target; verified)
- Assigned branch `/workspace/repo` left untouched at baseline `5672ead`, clean.
- Toolchain: official Bun 1.4.2 unpacked in `/tmp/bun142` (image ships 1.3.14, lockfile is `lockfileVersion: 2`). Lockfile not rewritten.
- Scope files: `src/metrics.ts`, `src/serve.ts:177-192` (metrics listener), `src/config.ts` metrics keys,
  `src/http.ts` (contrast: MCP auth/Host guard), `src/store.ts` (event/usage schema), `docs/OBSERVABILITY.md`,
  `docs/ENVIRONMENT.md`, `tests/serve.test.ts` metrics coverage.

Verdict: **FINDINGS** (3). No credentials appear below; all example hosts/tokens are synthetic.

## F1 - HIGH - Unauthenticated `/metrics` render is O(workers x events) and starves the event loop

- Location: `src/metrics.ts:70` (`const all = this.c.store.all()`), per-worker statements at
  `src/metrics.ts:88-92`, `src/metrics.ts:100-105`, `src/metrics.ts:108-120`; handler installed at
  `src/serve.ts:178-192`.
- Trigger: any `GET /metrics` once worker history has accumulated. `src/store.ts` has no
  `DELETE FROM` anywhere, so `workers`/`events`/`dispatches` grow monotonically for the life of the
  database and every scrape re-scans the whole history.
- Evidence (reproduced, `/tmp/sfrev/probe/probe-blocking.ts`, `/tmp/sfrev/probe/probe-render-cost.ts`):
  one scrape, in-process, 2,000 retained worker rows -> 2,100 ms and 10,003 SQL statements
  (5.0 per historical worker). Through the real listener, MCP `/health` latency observed while the
  scrape is in flight (same event loop):
  | retained workers | concurrent `/health` latency (two runs) | scrape status |
  | --- | --- | --- |
  | 250 | 50 ms / 44 ms | 200 |
  | 1000 | 562 ms / 535 ms | 200 |
  | 2000 | 10,312 ms / 7,679 ms | 200 |
  | 4000 | 23,132 ms / 20,801 ms | 200 |

  (both runs logged in `/workspace/.swarmforge/logs/probe-blocking-scaling.log`)
  `EXPLAIN QUERY PLAN` (`probe-queryplan.ts`) for the two hot statements returns `SCAN events`, i.e. a
  full table scan of `events` per worker and per completed dispatch; `events` has only a primary key
  on `id` (`src/store.ts:27`).
- Consequence: MCP tool calls, worker reconciliation and turn-deadline enforcement all stall for the
  duration because Bun serves both listeners on one event loop. With default Prometheus scraping
  (15 s) a long-lived instance is permanently wedged, and per F2 the trigger needs no credentials.
- Why existing guards do not prevent it: `tests/serve.test.ts:525-560` only asserts `status === 200`
  and the presence of `swarmforge_workers` on a near-empty database; there is no cache, TTL, row cap,
  handler timeout or scale test, and `docs/OBSERVABILITY.md` documents no cost characteristic.
- Recommendation: replace the per-worker loop with a small number of set-based aggregates
  (`GROUP BY team,state` over `workers`, one `GROUP BY type` over `events`, one join for provision
  and one for dispatch->result), add `CREATE INDEX events_worker_type ON events(worker_id,type)`,
  and cache the rendered exposition for a few seconds. Consider persisting `result.received` timing on
  the dispatch row so the `json_extract(data,'$.run_id')` scan disappears.

## F2 - HIGH - Metrics listener has no authentication and no Host validation, and reuses `SWARMFORGE_HOST`

- Location: `src/serve.ts:178-186` binds `hostname: config.SWARMFORGE_HOST` with a bare handler that
  only checks `pathname === "/metrics"`; `src/config.ts:142-150` validates only that the ports differ;
  contrast the MCP listener at `src/http.ts:11-28` (Host allowlist + timing-safe bearer check).
- Trigger: the supported public-deployment path. `docs/ENVIRONMENT.md` requires a non-loopback
  accepted hostname to expose MCP, and `SWARMFORGE_HOST` is the only bind variable for either
  listener (`src/serve.ts:158-160` and `src/serve.ts:181`), so setting `SWARMFORGE_HOST=0.0.0.0`
  (token-protected MCP) also publishes `:9090/metrics` with no credentials. On a loopback bind the
  Host guard is still missing, so the DNS-rebinding vector that `src/http.ts:11-21` exists to close
  remains open on the metrics port.
- Evidence (reproduced, `/tmp/sfrev/probe/probe-listener.ts` and `/tmp/sfrev/probe/probe-wildcard.ts`):
  - `SWARMFORGE_HOST=127.0.0.1` + `SWARMFORGE_API_TOKEN` set: `GET :9090/metrics` -> 200 with no
    `Authorization` header, 200 with `Authorization: Bearer <wrong>`, and 200 with
    `Host: attacker.example.com`. Same config, `GET :8787/health` -> 401 (no token), 403 (hostile Host).
  - `SWARMFORGE_HOST=0.0.0.0` + token: `http://172.17.0.1:<metricsPort>/metrics` -> 200 while
    `http://172.17.0.1:<apiPort>/health` -> 403.
  - Exposed payload: `swarmforge_workers{team="platform",state="booting"}`,
    `swarmforge_tokens_total{team=...,model="qwen",direction=...}`, queue depth, inference estimate.
    Unlisted team IDs are correctly bucketed to `other` (`acme-secret-org` absent from the output).
- Consequence: allowlisted team identifiers, model name, worker/state counts and token volumes are
  readable by anyone who can reach the port, and the same endpoint is the F1 amplifier.
- Why existing guards do not prevent it: `src/config.ts:139-141` requires `SWARMFORGE_API_TOKEN` for a
  non-loopback accepted hostname, which protects only the MCP listener; `docs/ENVIRONMENT.md` says
  "Protect externally if public", which is not achievable when one variable drives both binds; no
  `SWARMFORGE_METRICS_HOST` exists (`grep -rn METRICS src/` returns only ENABLE/PORT/TEAMS).
- Recommendation: add `SWARMFORGE_METRICS_HOST` (default `127.0.0.1`) and bind the metrics listener to
  it; apply the same `Host` allowlist (and optionally `SWARMFORGE_API_TOKEN`) inside the metrics
  handler; keep the metrics port out of `SWARMFORGE_ALLOWED_HOSTS` semantics.

## F3 - LOW - `swarmforge_tokens_total{model}` ignores the recorded `usage.model`

- Location: `src/metrics.ts:79-85` labels every observation with
  `this.c.config.SWARMFORGE_MODEL_NAME`, while `src/coordinator.ts:546-556` persists
  `m.model ?? config.SWARMFORGE_MODEL_NAME` per message into `usage.model` (`src/store.ts:30`).
- Trigger: a guest reporting a different model id than configured (routing, alias or fallback).
- Evidence (reproduced, `probe-wildcard.ts`): `usage` rows written with
  model `some-other-model-9000` are exported as `swarmforge_tokens_total{model="qwen",...}`;
  `store.tokens()` (`src/store.ts:323-353`) has no `GROUP BY model`, so the recorded column is never
  surfaced anywhere.
- Consequence: token accounting is misattributed whenever the reported model differs; operators cannot
  detect model substitution. `docs/OBSERVABILITY.md` already warns that OpenCode reporting is the
  accounting source, so impact is accounting accuracy rather than availability.
- Why existing guards do not prevent it: no test asserts the `model` label against a usage row with a
  differing model; `tests/excerpt.test.ts:145` only asserts that rendered output excludes excerpt text.
- Recommendation: add a store aggregate grouped by `usage.model` and use it as the label value (falling
  back to the configured name), or state explicitly in `docs/OBSERVABILITY.md` that the label is the
  configured model and not the recorded one.

## Checked and found correct (no finding)

- Team-label bucketing: unlisted teams map to `other`; trimmed allowlist parsing handles
  `"a, b"`; cardinality is bounded by `min(teams+1, allowlist)` x 12 states.
- Label-value injection: `SWARMFORGE_MODEL_NAME` is an unconstrained string used as a label value.
  A name containing `"`, `\` and a newline is correctly escaped by prom-client as a single label value,
  so no extra HELP/series can be injected (`probe-label-escape.ts`).
- Counter semantics: `created_total` equals persisted workers, `completed_total` counts
  `worker.completed` events (follow-ups included), `failed_total` counts `failed` +
  `recovery_required`; consistent with `docs/OBSERVABILITY.md`.
- Bind/shutdown: metrics listener is created after the API listener and before the event log; on any
  failure or `stop()` the release order is `api` -> `metricsServer` -> `coordinator` -> flush ->
  `store.close()` -> `unlock()`, and both ports are released (verified: connection refused after
  `stop()`). Occupied-API-port and occupied-metrics-port rollback tests exist and pass. `stop()` is
  idempotent. No `idleTimeout` on the metrics listener is not a defect (Bun's 10 s default is enough
  for a scrape).
- Metrics are served during provisioning (before `gate.open()`); data is accurate rather than stale,
  and the MCP listener still refuses mutations, so this is not reported.

## Tests / probes

- `bun test tests/serve.test.ts` (Bun 1.4.2, /tmp clone): 20 pass, 0 fail, 111 expect() calls,
  4.05 s, exit 0. Full suite not run (out of scope for this reviewer).
- Six bounded local probes under `/tmp/sfrev/probe` (outside the source checkout) using the repo's own
  `FakeProvider`/`FakeAgent` and temp-dir SQLite only. No real provider, VM, cloud or network service
  was contacted; all binds were 127.0.0.1 / 0.0.0.0 on ephemeral ports inside the container.

## Limitations

- Timings are container-local on one machine with SQLite in a temp dir; the trend (super-linear,
  full-scan driven) is the reproducible part, not the absolute milliseconds.
- Non-loopback reachability was demonstrated on `172.17.0.1` (docker0) inside this container, not a
  real external interface.
- F3 was verified by seeding `usage` rows directly rather than by driving a guest that reports a
  different model.
- Not assessed: settings-file parsing for metrics keys, Grafana/dashboard assets, MCP `status` output of
  the metrics port (reviewed only for consistency with the listener).