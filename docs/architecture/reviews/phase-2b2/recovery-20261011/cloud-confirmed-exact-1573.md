# Evidence-driven recovery investigation: new cloud-runner failures (exact source)

Worker: `w-209c8ef1-de93-49e2-8a02-17da282327ad`
Task: `diagnose-new-cloud-runner-failures`
Run: `a425a0eb-1e6d-48a5-a76d-18564bdd19ef`

Exact source bootstrapped and verified at `/workspace/phase2b2-ready`:
HEAD `157433166479c099a54cbee52ca9203dc722eb9f`, tree
`bb2ff7fefd568ef07b93223fb42d375af1726b0c` (both re-verified locally), branch
`phase2b2-diagnostic-repair`, clean, Bun 1.4.2, Node v24.21.0.

## 0. Bottom line

Both reported cloud failures are **confirmed**, reproduced on the exact source, and
are **test-harness defects, not production bugs**. They share one design theme: the
cloud integration tests hold state across later async work and are only robust when
the runner is fast/lightly loaded.

- **Failure 1 — abuse audit count (`abuse.integration.ts:39` = 10 vs 8): CONFIRMED.**
  The failure-audit budget is keyed by the wall-clock minute. The test's loop of 20
  bad callbacks can straddle a minute boundary, opening a second 8-per-minute bucket
  → 10 (or up to 16). Production enforces the 8/minute cap correctly.
- **Failure 2 — `hosted-schema.integration.ts:849 reg.json()` "Body is unusable":
  CONFIRMED and reproduced on the real test.** The test leaves the Miniflare
  `dispatchFetch` response `reg` unconsumed across a burst of D1 migration
  `prepare().run()` calls; that burst makes the pending response body *disturbed*
  (`reg.bodyUsed` flips `false`→`true` with no read), so the deferred `reg.json()`
  throws `TypeError: Body is unusable: Body has already been read`. Stack traces to
  `test/hosted-schema.integration.ts:849:31` → `undici/.../body.js:430`. Consuming
  `reg.json()` before the migration burst eliminates it.
- Secondary root failure (`tests/hosted-supervisor.test.ts:799`, 5000 ms controlled
  duration) did **not** reproduce here (`789 tests, 2 skip, 0 fail`); timing-dependent
  and independent.

No production code, security control, test configuration, assertion, or timeout was
modified. No source changes were made or committed.

## 1. Environment / provenance

| Item | Value |
| --- | --- |
| Exact source | `/workspace/phase2b2-ready` @ `1574331` (tree `bb2ff7fe`) |
| Runner (cloud integration) | `node --experimental-strip-types --test test/*.integration.ts` |
| Full cloud script | `node ... --test test/*.integration.ts && bun run test:sql` (`test/*.test.ts`) |
| Node / Bun / miniflare / undici | v24.21.0 / 1.4.2 / 5.20261006.0-alpha / 7.29.1 |
| Extra bundle provided | `/tmp/phase2b2-full-diagnostic.bundle` (not required) |

The three originally-listed incremental bundles were not needed, per the task.
Diagnostics were run from `/tmp/diag-exact/` (outside source) against the read-only
exact tree. Logs: `/workspace/.swarmforge/logs/`.

## 2. Failure 1 — CONFIRMED (wall-clock window crossing)

### Code
- `apps/cloud/src/abuse.ts:12-25` — bucket key `rate:${group}:${source}:${minute}`
  where `minute = Math.floor(Date.now()/60000)`.
- `apps/cloud/src/index.ts:706-719` — every unauthenticated callback failure is
  audited under `budget(ctx, "failure-audit", 8, ctx.actor ?? undefined)`; for bad
  callbacks `ctx.actor` is null so `source="unknown"`.
- `apps/cloud/test/abuse.integration.ts:28-39` — 20 bad callbacks, then
  `assert.equal(audits?.n, 8)`.

### Reproduced on exact source (deterministic boundary straddle)
`/tmp/diag-exact/diag-abuse-boundary.ts` aligns to ~25 ms before a minute boundary,
then fires the same 20 callbacks:

```
audits: {"n":10,"mn":1791740219986,"mx":1791740220060}
buckets: [{count:2, minuteStart:1791740160000},
          {count:8, minuteStart:1791740220000}]
```

Two rows: 2 audits in the old minute + 8 in the new minute = 10. Focused runs keep
the whole loop inside one window (loop ~120 ms) and pass; the loaded concurrent full
runner spans the boundary and fails. So this is exactly the reported "clock window
crossing" and is now confirmed, "not yet deterministic classification" resolved.

### Impact
Production is correct: the cap is per-minute per-source (worst case 8 at the end of
one window + 8 at the start of the next). Test-only defect.

### Smallest correction proposals (no ownership taken)
1. **Preferred:** inject a clock seam (e.g. `ctx.now ?? Date.now()`) and run the 20
   callbacks with a fixed `now` inside one minute. Deterministic, keeps `== 8`,
   production default unchanged.
2. **No production change:** assert window-correct behaviour
   (`sum(allowed per failure-audit bucket) == n` and each bucket `count <= 8`),
   which no longer assumes a single window.
Do NOT raise the 8 cap, skip/delete the test, or add sleeps.

## 3. Failure 2 — CONFIRMED (response body disturbed across D1 migration burst)

### Code
- `apps/cloud/test/hosted-schema.integration.ts:790-857`, test "clean install and
  2B.1 upgrade": `reg = await h.register(invite)` (798), `reg.status==201` (799),
  a burst of `h.db.prepare(stmt).run()` applying `0003_hosted_execution.sql`
  (814-817), a `/v1/cli/me` call, then the deferred `reg.json()` at **849**.
- `apps/cloud/test/machine-helpers.ts:55-70` — `request()` returns the raw
  `mf.dispatchFetch` Response; `:168-186` — `register()` returns it unconsumed.
- undici `node_modules/undici/lib/web/fetch/body.js:430` / `:470-475` — `.json()`
  rejects if the body stream is `locked` or `isDisturbed`.

### Reproduced on the real test (no source change)
Running the unmodified real file under memory pressure
(`node --max-old-space-size=64 --experimental-strip-types --test
test/hosted-schema.integration.ts`) failed the target test in 2 of 3 runs:

```
✖ hosted schema checkpoint: clean install and 2B.1 upgrade
  TypeError: Body is unusable: Body has already been read
      at consumeBody (undici/lib/web/fetch/body.js:430:27)
      at _Response.json (undici/lib/web/fetch/body.js:343:14)
      at TestContext.<anonymous> (test/hosted-schema.integration.ts:849:31)
```

### Mechanism isolated (`/tmp/diag-exact/diag-trigger.ts`, mem64)
`reg.bodyUsed` recorded at each stage (`false` immediately after register):

| Trigger after register | fails/10 | bodyUsed after |
| --- | --- | --- |
| forced `global.gc()` ×3 | 0/10 | false |
| single D1 `SELECT` | 0/10 | false |
| **full `0003` migration burst** | **3/10** | **true** |
| burst, then 3 s sleep | 2/10 | true |

So it is specifically the **burst of D1 `prepare().run()` migration calls** (not GC
alone, not a single D1 call) that disturbs the still-open `dispatchFetch` response
stream; memory pressure/load makes it frequent. The exact undici internal cause
(global dispatcher/connection reuse marking the pending stream disturbed) was not
drilled to the byte level; the observable, reproducible mechanism above is the
confirmed basis.

### Smallest correction (validated on the real test, as a /tmp copy)
Move the credential read to immediately after the status assert (before migrations):

```
const reg = await h.register(invite);
assert.equal(reg.status, 201);
const worker = (await reg.json()) as { credential: string };   // consume now
... apply 0003 migration burst ...
await h.request("/v1/workers/me", { authorization: `Bearer ${worker.credential}` });
```

Under the identical `--max-old-space-size=64` pressure the fixed copy passed 5/5 in
3/3 runs, versus 2/3 failures for the unmodified test. This preserves every assertion
(the `/v1/workers/me` 200 check still runs after migrations). A broader alternative is
to make `machine-helpers.register()` parse and return the credential like
`enroll()`/`linked()` do, removing the held raw Response everywhere; that touches more
call sites and needs ownership.

Any test that holds a `dispatchFetch` Response across a D1 `prepare().run()` migration
burst is at the same risk (sweep recommended; the confirmed one is `hosted-schema`
"clean install and 2B.1 upgrade").

## 4. Out of scope: root journal-timeout/order (owned by a separate lifecycle worker)

Scope note: this worker owns only the two cloud failures. The root
`hosted-supervisor.test.ts:799` journal/timeout/order hypothesis is owned by a
separate lifecycle worker. The note below is retained only to record that it was
observed to be independent of, and non-overlapping with, the cloud causes.

`tests/hosted-supervisor.test.ts:799` "concurrent distinct tasks journal their own
actual child identities before launch returns" uses `controlled_duration_ms: 5000`
(815-819) and a `Bun.sleep(50)`/gate-controlled provider (804-813). Lead observed it
fail when a launch returned at the ~5000.50 ms deadline under concurrent load. Here,
the default root runner (`bun test`, Bun 1.4.2) completed:

```
Ran 789 tests across 59 files. [268.15s]   2 skip   0 fail   4533 expect() calls
```

(started concurrently with a full cloud run; no cgroup `cpu.max`/`memory.max` files
present, so no CPU/memory quota was assumed). It is a load/timing-sensitive deadline
issue and independent of the two cloud failures. Full root log:
`.swarmforge/logs/exact-fullroot-concurrent.log`.

## 5. Reproduction commands (exact source)

```
cd /workspace/phase2b2-ready
export BUN=/tmp/opencode/bun142/node_modules/bun/bin/bun.exe   # pinned 1.4.2
$BUN install --frozen-lockfile && (cd apps/cloud && $BUN install --frozen-lockfile)

# Focused, green
cd apps/cloud
node --experimental-strip-types --test test/abuse.integration.ts test/hosted-schema.integration.ts   # 7/7

# Full cloud integration (exact 124-test suite)
node --experimental-strip-types --test test/*.integration.ts   # 124/124 pass, alone and concurrent w/ root

# Failure 1 deterministic repro
node --experimental-strip-types --test /tmp/diag-exact/diag-abuse-boundary.ts   # audits n=10

# Failure 2 repro on the REAL test (memory pressure)
node --max-old-space-size=64 --experimental-strip-types --test test/hosted-schema.integration.ts   # 2/3 fail

# Failure 2 mechanism isolation
node --expose-gc --max-old-space-size=64 --experimental-strip-types --test /tmp/diag-exact/diag-trigger.ts
```

## 6. Sources (exact tree)

- `apps/cloud/src/abuse.ts:12-25`; `apps/cloud/src/index.ts:706-719`
- `apps/cloud/test/abuse.integration.ts:28-39`
- `apps/cloud/test/hosted-schema.integration.ts:790-857` (deferred read at 849)
- `apps/cloud/test/machine-helpers.ts:55-70,168-186`
- `node_modules/undici/lib/web/fetch/body.js:430,470-475`
- `tests/hosted-supervisor.test.ts:799-863`

## 7. Trade-offs

- Failure 1 clock-injection adds a tiny production seam; the window-aware assertion
  needs no production change but changes the test's shape. Either keeps the 8 cap.
- Failure 2 moving the read earlier is minimal and assertion-preserving; the
  helper-level fix is cleaner long-term but broader. Do not add retries or swallow the
  error.
- Both failures are "pass focused, fail full" because of held state; fixes must
  remove the assumption, not increase timeouts or lower limits.

## 8. Unanswered / follow-up

1. Confirm file ownership and choose the Failure 1 option (clock seam vs window-aware
   assertion).
2. Sweep cloud tests for the same held-Response-across-D1-burst pattern.
3. Decide targeted test edit vs `machine-helpers.register()` helper change.
4. Reproduce/confirm the root `hosted-supervisor.test.ts:799` 5000 ms deadline failure
   under the lead's exact concurrent conditions (not reproducible here).
5. Optional: pin down the exact undici/miniflare stream-disturbance call site.
