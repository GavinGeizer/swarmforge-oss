# SwarmForge review — terminal dashboard (input / render / lifecycle / control confirmations / races / untrusted control chars)

- Target: `d428e0f730ed5649485732e95d39c32f5d6a8895` (branch `feature/binary-config-serve-20260930`)
- Reviewer scope: `src/cli/tui.ts`, `src/cli/overview.ts`, `src/cli/client.ts`, CLI dashboard path in `src/cli.ts`
- Read-only review. Disposable detached clone: `/tmp/opencode/rev-42/checkout` (`git rev-parse HEAD` = target). Assigned branch `/workspace/repo` left at baseline `5672ead`, clean, untouched.
- Verdict: **FINDINGS** (1 HIGH, 2 MEDIUM, 3 LOW)
- All probes are local fakes (EventEmitter/PassThrough streams + fake MCP client object). No real MCP server, provider, VM, or network call was made. No credentials were used, read, or stored; every probe input was a synthetic local value.
- Sanitization note: probe outputs are described structurally below. Credential-shaped literals from probe fixtures (an endpoint URL with userinfo and a credential query parameter) are intentionally omitted; only the code shape and the redaction behaviour they produced are reported.

## Findings

### F1 — HIGH — Interactive dashboard re-prints the raw, unredacted MCP endpoint after every refresh
- File/line: `src/cli/tui.ts:56` (assignment `data = await client.overview()`), with `src/cli/client.ts:88` (`url` returned verbatim from the `connectSwarmForge` closure) and `src/cli.ts:160` (the one-shot `data.url = scrub(settings, endpoint)`).
- Trigger: a human operator runs `swarmforge status` on a TTY against an endpoint whose URL carries credential material in the userinfo component or a query parameter — a shape this repo explicitly supports and scrubs everywhere else (`src/cli.ts:157-159` comment; `tests/settings.test.ts:949` asserts the scrubbed form replaces both the userinfo and the query value; `resolveClientSettings` checks only the scheme, `src/settings/load.ts:871-891`). Frame 1 is scrubbed by `cli.ts:160`, but the first poll refresh (default 5 s, `src/cli.ts:167`) — or the `r` key — replaces the whole `data` object with `client.overview()`, whose `url` is the raw endpoint, and `renderOverview` prints it at `src/cli/overview.ts:156`.
- Consequence: the endpoint credential is written to the operator's terminal in clear text from the 5-second mark onward, redrawn every second (`tui.ts:124`), visible to screen shares and terminal recorders. It defeats the redaction the CLI applies to every other diagnostic.
- Reproduction (probe `g2.ts`, fake client, no server): with a fixture endpoint whose URL contained userinfo and a credential query parameter, frame 1's header line showed the production `Redactor` output (userinfo and query value both replaced by the redactor's placeholder), while every frame after the first poll showed the original unredacted endpoint — i.e. the probe compared the two header strings and found the post-refresh value equal to the raw fixture while the pre-refresh value was not. Both raw components were present in the post-refresh byte stream.
- Why guards do not prevent it: `scrub()` is applied once to the initial snapshot object; `tui.refresh()` overwrites that object wholesale and nothing re-applies the scrub. `tests/cli.test.ts:41` exercises only the piped/JSON one-shot paths (no refresh), and `tests/overview.test.ts` uses a credential-free loopback URL, so no test covers `data.url` after a refresh.
- Recommendation: keep the display endpoint out of the refreshable payload — drop `url` from `OverviewData` in `client.ts` and pass the scrubbed display URL from `cli.ts` into `runDashboard`; or at minimum re-apply the scrub in `tui.refresh()` (`data = { ...(await client.overview()), url: displayUrl }`).

### F2 — MEDIUM — `renderOverview` applies no terminal control-character sanitization
- File/line: `src/cli/overview.ts:211-213` (`.map((line) => (line.includes("\u001b[") ? line : clipped(line, width)))`).
- Trigger: any string in the overview body that is not schema-constrained. Reachable today mainly through a non-SwarmForge or compromised MCP endpoint, which the CLI accepts for any http(s) `--url`; a hostile response carrying raw `ESC`/`OSC` in a summary field or the `url` field reaches the terminal verbatim (probe D/H asserted the rendered view still contained a raw `ESC` byte).
- Consequence: `ESC[2J`/`ESC[H` can blank or reposition the whole alternate screen mid-redraw, and `OSC 0;…` can retitle the operator's terminal; a long attacker-influenced line can also scroll the destroy-confirmation prompt off screen (`tui.ts:45-50` appends the prompt after the body).
- Code-evidenced reachability limits (stated honestly): `idSchema` (`src/domain.ts:24-28`) constrains `worker_id`/`team_id`/`task_id`, `state` is an enum, and the WHATWG URL parser rejects an endpoint string containing raw control bytes (verified locally), so a compliant SwarmForge server cannot currently inject here. The gap is that the sanitizing helper already exists and is applied to the sibling view but not this one.
- Why guards do not prevent it: `safeTerminalText` (`overview.ts:81`) is applied to every detail line (`overview.ts:274`) and to `message` (`tui.ts:48`), but never to the overview body; the existing test "worker text cannot inject terminal control sequences" (`tests/overview.test.ts:124`) only calls `renderWorkerDetail`.
- Recommendation: `.map((line) => clipped(safeTerminalText(line), width))` for the overview, and sanitize the header `data.url` the same way.

### F3 — MEDIUM — Terminal state is restored only on the keypress quit path
- File/line: `src/cli/tui.ts:118-138` — `\u001b[?1049h\u001b[?25l` at line 121, restore `\u001b[?25h\u001b[?1049l` only inside `stop()` at line 136, reachable only from the keypress handler (line 140); the await at line 123 is not wrapped in `try/finally`.
- Trigger: a `SIGTERM`/supervisor stop, or an EPIPE from a closed stdout raised inside the 1-second redraw timer (`tui.ts:124`).
- Consequence: the operator's terminal is left in the alternate screen with the cursor hidden and stdin still in raw mode; the shell scrollback is not restored and `reset`/`stty sane` is required.
- Evidence: probe E — `process.listenerCount` for `SIGTERM`, `SIGINT`, `exit` and `uncaughtException` was 0 before and during an active dashboard session.
- Why guards do not prevent it: in raw mode Ctrl-C arrives as a keypress (handled at `tui.ts:140`), so the keypress handler is the only exit; there are no process signal handlers and no `finally` around the promise.
- Recommendation: register `SIGTERM`/`SIGHUP` handlers that call the existing idempotent `stop()` (the `stopped` flag already prevents a double restore), and put the render/interval work in a `try/finally` that restores the terminal.

### F4 — LOW — A confirmed control action can be overwritten by an older in-flight poll snapshot
- File/line: `src/cli/tui.ts:60-74` together with `src/cli/tui.ts:106-109`.
- Trigger: a poll `refresh()` passes the `!busy` check at line 60 and blocks inside `await client.worker(id)` (line 63) while the operator confirms a destroy. `control()` then calls `refresh()` at line 107, which no-ops because `refreshing` is already true, so `control()` finishes first and the older snapshot lands afterwards at line 65.
- Consequence: the detail view shows state `RUNNING` and re-offers `p pause` / `c cancel` for an already-destroyed worker until the next poll (≤5 s); the operator can be prompted to pause a worker that no longer exists.
- Reproduction (probe `A`, gated fake `client.worker`): after a confirmed destroy the last detail frame matched `/RUNNING/` and contained `p pause`.
- Why guards do not prevent it: the `!busy` guard at line 64 is evaluated after the await that already started, so it cannot order the two writes; the `detail?.worker.worker_id === id` guard only protects against a worker switch, not a state regression.
- Recommendation: stamp detail refreshes with a monotonic sequence and drop any result older than the last applied one, or ignore state/`last_activity_at` regressions for the same worker.

### F5 — LOW — Destroy confirmation is never re-validated against the current worker state
- File/line: `src/cli/tui.ts:144-151`.
- Trigger: press `d` to arm the confirmation, then let a poll refresh move the worker to a state where `availableActions` no longer offers destroy (e.g. another lead already destroyed it). The prompt keeps rendering and `y` calls `control("destroy")` directly, bypassing the `availableActions(detail.worker.state)` check every other action key uses (line 177).
- Consequence: a stale destructive prompt that keeps re-arming for an already-destroyed worker, and a `y` keypress dispatches a destroy the UI no longer offers.
- Reproduction (probe `C2`): 5 consecutive frames still asked "Destroy this worker?" after the state became `destroyed`, and the recorded control calls were `["destroy"]`.
- Why guards do not prevent it: `confirmation` is cleared only by `n`/`escape` (line 146) and at the start of `control()` (line 102); nothing invalidates it when `detail` changes.
- Recommendation: clear `confirmation` in `refresh()` when the refreshed state no longer offers destroy, and re-check `availableActions` in the confirmation branch before dispatching.

### F6 — LOW — Ctrl-D in the detail view arms the destroy confirmation
- File/line: `src/cli/tui.ts:184` (action matching ignores `key.ctrl`); the guard at `tui.ts:140` special-cases only `ctrl+c` and `q`.
- Trigger: the handler matches `key.name === "d"` with no `key.ctrl` check. readline reports Ctrl-D as `{name:"d", ctrl:true}` (verified with `node:readline` `emitKeypressEvents` over a `PassThrough`), so Ctrl-D reaches the destroy branch.
- Consequence: a user who presses Ctrl-D to exit instead gets "Destroy this worker? Press y to confirm…"; the prompt names no worker, so the target is not identifiable at the moment of the decision. Damage still requires `y`.
- Reproduction (probe `ctrld2.ts`, real `emitKeypressEvents` over a `PassThrough`): after the Ctrl-D byte the destroy confirmation was rendered.
- Why guards do not prevent it: `key.ctrl` is only consulted for `c`; no test exercises modifier combos, and the existing confirmation test (`tests/overview.test.ts:229`) sends bare `d`/`y` key names.
- Recommendation: skip keys with `key.ctrl || key.meta` in the action branches, and include the worker id in the confirmation prompt.

## Tests / probes actually run

- `bun test tests/overview.test.ts` in the disposable clone: **10 pass, 0 fail, exit 0** (bun 1.3.14; the file needs no third-party modules).
- `bun test tests/cli.test.ts`: **0 pass, 1 fail, exit 1** — module resolution error for `@modelcontextprotocol/sdk/client/index.js`. Not run meaningfully: the disposable clone has no `node_modules`, and Bun 1.3.14 cannot read this repo's `lockfileVersion: 2` lockfile, so dependencies were not installed. Reported as-is, not retried.
- Local fake-client probes (all outside the source checkout, in `/tmp/opencode/rev-42/probe/`): `tui-probe.ts`, `url-probe.ts`, `g2.ts`, `misc.ts`, `ctrld.ts`, `ctrld2.ts` — every probe exited 0. They drive `runDashboard` with `EventEmitter`/`PassThrough` stdio and a fake MCP client object; no server, provider, VM, or network was contacted.
- Not run: the full test suite (whole-suite reviewer scope), any `bun run check`/typecheck or compile (packaging scope), `bun run smoke` (billable, explicitly excluded).

## Limitations

- Review limited to the dashboard surface; server-side control-path and packaging behaviour were not assessed.
- F1 and F6 are reproduced with fake clients/streams rather than a live MCP server; the code trace for both is short and unambiguous (`client.ts:88` → `tui.ts:56` → `overview.ts:156`; readline Ctrl-D key shape verified empirically).
- F2's reachable vector is narrow against a compliant server (`idSchema`, enum `state`, WHATWG URL parsing) and is reported as defense-in-depth rather than a live injection against SwarmForge itself.
- Interactive behaviours that need a real TTY (true alt-screen entry, cursor visibility, wrapping) were reasoned from the emitted byte stream, not observed in a terminal emulator.
- This report was sanitized with the production `Redactor` from the target plus generic URL/query rules; all probe fixture literals and derived strings were removed, and the artifacts were re-checked for credential-shaped residue.
- No files in `/workspace/repo` or the disposable clone were modified; `git status` in both is clean.
