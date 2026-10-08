# SwarmForge review - task 40-cli-status (client HTTP/MCP + redaction + URL/JSON output)

Sanitized report. All credential-shaped examples are described structurally; no raw
credential literals, credential-bearing URLs or query values appear below.

- **Exact target reviewed:** `d428e0f730ed5649485732e95d39c32f5d6a8895` (branch `feature/binary-config-serve-20260930`)
- **Baseline branch checkout (untouched):** `/workspace/repo` @ `5672ead`, clean
- **Disposable detached checkout:** `/tmp/rev40/repo` (`git rev-parse HEAD` = `d428e0f730ed5649485732e95d39c32f5d6a8895`)
- **Reviewer scope:** Client HTTP/MCP connection/error/close handling, token redaction, URL output and noninteractive JSON semantics
- **Toolchain:** Bun 1.4.2 unpacked to `/tmp/rev40/bun142/bun-linux-x64/bun` (system `bun` is 1.3.14; lockfile never rewritten). `bun install --frozen-lockfile` succeeded (exit 0).
- **Verdict:** FINDINGS (2, both MEDIUM)

## Files in scope examined

`src/cli.ts`, `src/cli/arguments.ts`, `src/cli/client.ts`, `src/cli/overview.ts`,
`src/cli/tui.ts`, `src/http.ts`, `src/mcp.ts`, `src/security.ts`,
`src/settings/inspect.ts`, `src/settings/load.ts`, plus `tests/cli.test.ts`,
`tests/commands.test.ts`, `tests/http.test.ts`, `tests/overview.test.ts`.

---

## Finding 1 - MEDIUM: interactive dashboard re-prints the unredacted endpoint after its first refresh

**File/line (target):** `src/cli/client.ts:88` (root cause), consumed at `src/cli/tui.ts:56`
and rendered at `src/cli/overview.ts:156`. Correct redaction is applied once at
`src/cli.ts:160`, but the dashboard discards it on refresh.

**Concrete trigger:** the operator runs `swarmforge status` on a TTY while the resolved
endpoint carries a bearer value, supplied either in the endpoint's query string (a
`token`-named parameter) or in the endpoint's user-information component, via `--url` or via
`client.url` in the config file. The first frame is correct; from the first poll (5 s default,
`src/cli/tui.ts:125`) onward the raw endpoint is on screen. Evidence shape: the rendered
overview header line begins `MCP  ` followed by the loopback endpoint with its query string
intact, followed by `     Metrics  enabled :9090`.

**Consequence:** the control-plane bearer value is rendered on the operator's terminal (and
into scrollback, any terminal recording or screen share) for as long as the dashboard runs.
This is the exact case the code documents protecting at `src/cli.ts:158-160`.

**Reproduction (reviewer probes, outside the source checkout; `tests/helpers.ts` fake provider
only, no real provider or cloud call).** All probe credentials were synthetic and have been
removed from this report; probes assert on a boolean "does any rendered frame contain the
marker" rather than on the marker text.

- `/tmp/rev40/probe/tui-url.ts` - real `createHttpHandler` server, real `connectSwarmForge`,
  real `runDashboard`; inspects rendered frames after the poll fires. Reported booleans:
  initial frame marker present = false; post-refresh frame marker present = true.
- `/tmp/rev40/probe/pty-e2e.ts` - full `bun src/cli.ts status --url <endpoint carrying the
  marker>` under a real pty (`script -qec`), sampled past the 5 s poll. Reported boolean:
  transcript marker present = true; the same header line shape as above.

**Code trace:** `client.overview()` builds `{ url, ... }` from the *raw* `url` argument
(`src/cli/client.ts:88`). `src/cli.ts:160` overwrites `data.url` with the scrubbed endpoint,
but `runDashboard`'s `refresh()` replaces the whole object with a fresh `client.overview()`
result (`src/cli/tui.ts:56`), and `renderOverview` prints `MCP  ${data.url}`
(`src/cli/overview.ts:156`). The scrub is never re-applied to refreshed data.

**Why existing guards/tests do not prevent it:** the redaction regression tests
(`tests/commands.test.ts:987-1055`, "the printed endpoint carries no credential from any
layer") exercise only `--json` and `--no-interactive`. The dashboard is reached only when
`process.stdin.isTTY && process.stdout.isTTY` (`src/cli.ts:163-166`), which those tests never
create. `tests/overview.test.ts:285-333` drives `runDashboard` but with a `data` object whose
`url` is already fixed and a stub client that returns the same object, so a refresh cannot
change the URL and the leak is unobservable.

**Recommended correction:** separate the connection URL from the display URL. Either let
`connectSwarmForge` accept a caller-supplied display URL, or re-apply `scrub(settings, ...)` to
`data` inside `runDashboard`'s `refresh()` immediately after `data = await client.overview()`.
Keeping the raw URL for the connection and a separate redacted string for display removes the
ordering dependency. Add a test that drives `runDashboard` with a client whose `overview()`
returns a credential-bearing `url` and asserts no rendered frame contains it.

---

## Finding 2 - MEDIUM: dashboard error banner is not scrubbed with the client credential context

**File/line (target):** `src/cli/tui.ts:77`, `src/cli/tui.ts:93`, `src/cli/tui.ts:111`;
rendered at `src/cli/tui.ts:48`. Compare the noninteractive equivalent at
`src/cli.ts:184-186`.

**Concrete trigger:** any error raised inside the dashboard after the initial successful
overview - a poll refresh, an inspect, or a `pause`/`resume`/`cancel`/`destroy` control whose
remote failure text contains the bearer value. `runDashboard` catches each of these itself
(`src/cli/tui.ts:76-81`, `92-97`, `110-115`), so `showStatus`'s outer `catch` at
`src/cli.ts:180-187` - the only place the resolved credential context is applied - never runs.
The message reaches the terminal through `safeTerminalText` (`src/cli/tui.ts:48`), which
removes control characters but performs no credential redaction.

**Consequence:** the control-plane bearer value reaches the terminal whenever the server, or an
intermediary proxy, echoes the received `Authorization` header inside an error body. This is
the exact threat the codebase already models and tests for the noninteractive path
(`tests/commands.test.ts:909-985`, "a remote error that echoes a resolved credential never
prints it"), and the comment at `src/cli.ts:181-183` states the intent explicitly; the
interactive path simply does not honour it.

**Reproduction (reviewer probes, outside the source checkout; synthetic markers only):**

- `/tmp/rev40/probe/tui-error.ts` drives the real `runDashboard` with a client whose
  `overview()` throws an error embedding the marker. Reported booleans: banner contains marker
  = true. Banner text shape: a `Refresh failed:` prefix followed by a remote refusal phrase and
  a bearer scheme followed by the marker.
- `/tmp/rev40/probe/transport-error.ts` confirms transport-level feasibility with a real
  `StreamableHTTPClientTransport`: the SDK raises an error whose message is a streamable-HTTP
  POST failure phrase that embeds the remote response body, and that body contained the marker.
  Reported boolean: transport error message contains marker = true.

**Why existing guards/tests do not prevent it:** the redaction test at
`tests/commands.test.ts:909` drives `run` with `--json` and `--no-interactive` only and asserts
`stderr` is clean. In interactive mode the error never becomes an exception out of
`showStatus`, so the scrub is bypassed by construction, and no test enters the `isTTY`
dashboard branch with a failing client. Server-side redaction (`src/mcp.ts:59-63`) does not
help here: the echo arrives in an HTTP status body, outside any tool-result redactor.

**Recommended correction:** pass the resolved client settings (or a `scrub` callback) into
`runDashboard` and apply it to every `message` before rendering, e.g. wrap the assignment at
`src/cli/tui.ts:77`, `:93` and `:111` in `scrub(settings, ...)`. Add a test that enters
`runDashboard` with a rejecting client and asserts the credential is absent from every frame.

---

## Checks performed that produced no finding

- **`client.close()` runs on the failure path.** `src/cli.ts:175-179` closes in `finally`, so a
  refused connection or a failed overview still tears down the transport. Confirmed by code trace.
- **Pagination advance guard.** `src/cli/client.ts:82-85` rejects a non-advancing `next_offset`
  rather than looping forever. Exercised by `tests/cli.test.ts:6-39` (101 workers, 2 pages).
- **Noninteractive JSON semantics.** `--json` writes exactly one line of JSON to stdout, exits 0
  on success and 1 with an empty stdout and a scrubbed stderr on failure; `--no-interactive`
  prints a plain snapshot with no ANSI. Verified by `tests/commands.test.ts:322-380` and
  `tests/cli.test.ts:41-87`, all passing.
- **Server-side auth/origin/host handling** (`src/http.ts:9-32`): timing-safe bearer compare with
  a length pre-check, origin equality, host allowlist. `tests/http.test.ts` passes.
- **Escape handling in `renderOverview`**: `src/cli/overview.ts:212` does not route the first
  three header lines through `safeTerminalText`, but a probe
  (`/tmp/rev40/probe/overview-escape.ts`) found no injectable server field reaches those lines
  (`data.url` is a URL; `metrics` is numbers/boolean; the state and token lines are
  enumerated). No finding.

## Tests run (actual execution)

Toolchain: Bun 1.4.2 at `/tmp/rev40/bun142/bun-linux-x64/bun`.

| Command | Exit | Result |
| --- | --- | --- |
| `bun install --frozen-lockfile` | 0 | 125 packages installed |
| `bun test tests/cli.test.ts tests/overview.test.ts tests/http.test.ts` | 0 | 14 pass, 0 fail, 65 expect() calls |
| `bun test tests/commands.test.ts` | 0 | 15 pass, 0 fail, 223 expect() calls |
| `bun run /tmp/rev40/probe/tui-url.ts` | 0 (probe exits 42 on the leak branch; leak confirmed) | Finding 1 reproduced |
| `bun run /tmp/rev40/probe/pty-e2e.ts` | 0 | Finding 1 reproduced end-to-end under a pty |
| `bun run /tmp/rev40/probe/tui-error.ts` | 0 | Finding 2 reproduced |
| `bun run /tmp/rev40/probe/transport-error.ts` | 0 | Echoed-bearer transport error confirmed |
| `bun run /tmp/rev40/probe/overview-escape.ts` | 0 | No finding |
| `bun run /tmp/rev40/probe/live-call-error.ts` | 1 | Inconclusive (ad-hoc stub did not satisfy the MCP handshake; superseded by `transport-error.ts`) |

The full suite was not run: that is the whole-suite reviewer's scope. Only the four test files
covering this scope were executed.

## Limitations

- The dashboard is TTY-gated, so reproductions used a real pty (`script -qec`) or the same
  fake-stdin/stdout `EventEmitter` pattern the repository's own `tests/overview.test.ts` uses.
- All probes ran against `tests/helpers.ts` fake provider/agent and a loopback `Bun.serve`
  handler. No real cloud or model provider was contacted and no real infrastructure smoke was run.
- Finding 2's trigger depends on a server or intermediary echoing the `Authorization` header.
  Reachability of the echoed header is confirmed at the client boundary; the specific deployment
  that does it is environment-dependent. Code-evidenced and probe-reproduced.
- `/tmp/rev40/repo/node_modules` exists only in the disposable /tmp checkout. `/workspace/repo`
  was never checked out, built, or modified.
- This document was sanitized after the review: probe credential markers were removed and
  credential-shaped URLs and query values were replaced with structural descriptions. Findings,
  evidence shapes and conclusions are unchanged.