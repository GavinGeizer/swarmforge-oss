# Reviewer 20 — Host/origin validation, DNS/IPv6, forwarding headers, rebinding protection, transport options

- **Exact target reviewed:** `d428e0f730ed5649485732e95d39c32f5d6a8895` (published branch `feature/binary-config-serve-20260930`)
- **Disposable checkout:** `/tmp/opencode/review20/repo` (detached at target; `git rev-parse HEAD` verified)
- **Assigned workspace (untouched):** `/workspace/repo` at baseline `5672ead2a526e07fea9ed11e58b3725e42013527`, branch `swarmforge/repo-review-50-20260930/20-http-origin/w-5b2b55c4-2493-44ef-8f97-2e3e4f2fff58`
- **Toolchain:** official Bun 1.4.2 unpacked at `/tmp/opencode/bun142/bun-linux-x64/bun` (snapshot Bun 1.3.14 cannot read `lockfileVersion: 2`). Lockfile not rewritten; `bun install --frozen-lockfile` used.
- **Read-only:** no source edits, no commits, no pushes. Reviewer experiments live only in `/tmp/opencode/review20/probe` (disclosed below).
- **Verdict:** FINDINGS (2 MEDIUM, 2 LOW). No CRITICAL/HIGH. The core DNS-rebinding defence (exact `url.hostname` allowlist evaluated on the wire authority, enforced before routing and before `/health`, `/events`, `/mcp`) works and resisted every bypass probe I sent.

## Scope covered

`src/http.ts` (host allowlist, bearer check, Origin check), `src/config.ts` (`loopbackHosts`, `isLoopbackHost`, `acceptedHosts` super-refine), `src/serve.ts` (API + metrics `Bun.serve` transport options, `origin()`), `src/serve-command.ts` + `src/cli/arguments.ts` (serve command, banner), `src/runtime.ts` (`renderStartup`), `src/cli.ts` + `src/cli/client.ts` (client endpoint resolution), `src/metrics.ts`, `src/settings/{load,inspect}.ts` (new `server.host` / `server.allowed_hosts` fields), plus docs (`ENVIRONMENT.md`, `CONFIGURATION.md`, `SERVE.md`, `OBSERVABILITY.md`, `ARCHITECTURE.md`) and `tests/http.test.ts`.

Not reviewed: worker lifecycle/coordinator, store schema, git handoff, packaging/build, settings secret redaction beyond its effect on host fields.

## Verified-good behaviour (so the findings below are read in context)

Raw-socket probes against a real `Bun.serve` listener (logs: `host-wire-probe.log`):

| request | result |
| --- | --- |
| `Host: evil.example` | `403 Forbidden` (allowlist) |
| `Host: evil.example` first, `Host: localhost` second | first `Host` wins, `403` |
| absolute-form target `http://localhost/health` + `Host: evil.example` | `403` (authority comes from the absolute target, RFC 9112 §3.2.2) |
| `X-Forwarded-Host` / `X-Forwarded-Proto` / `X-Forwarded-For` | ignored entirely — correct, no spoofable forwarding trust |
| `Host: LOCALHOST` | `200` — WHATWG `URL` lowercases the authority, so wire `Host` is case-insensitive |
| HTTP/1.0 with no `Host` | `200` (Bun synthesises the authority from the listener address) |
| same probes with `SWARMFORGE_API_TOKEN` set | host check first (`403`), then bearer (`401`) |

---

## F1 — MEDIUM — `SWARMFORGE_ALLOWED_HOSTS` entries are matched case-sensitively, so a valid hostname in any non-lowercase form (or with a port) is silently dead

**File/line:** `src/http.ts:9-19` (set built at lines 13-16, compared at line 18). Contributing: `src/config.ts:16-24` (`acceptedHosts`) and `src/config.ts:10-12` (`isLoopbackHost`, which *does* `.toLowerCase()`).

**Trigger.** Operator sets a reverse-proxy deployment exactly as `docs/ENVIRONMENT.md:33` instructs:

```ini
SWARMFORGE_ALLOWED_HOSTS=MCP.Example.Test
SWARMFORGE_API_TOKEN=<24+ chars>
```

Clients then reach `http://mcp.example.test:8787/mcp` with `Host: MCP.Example.Test` (or the lowercased form).

**Consequence.** `hosts.has(url.hostname)` compares `"MCP.Example.Test"` against `url.hostname`, which WHATWG `URL` has already lowercased to `"mcp.example.test"`. The entry can never match, so every request — `/health`, `/events`, `/mcp` — returns a bare `403 Forbidden` with no log line, no startup diagnostic, and no hint that the accepted-host list is the cause. The deployment looks broken at startup and the token requirement (correctly enforced, because `MCP.Example.Test` is not loopback) suggests a credential problem, sending the operator down the wrong path. Same dead-entry outcome for an FQDN written with a trailing root dot (`example.com` vs `example.com.`) and for an entry that includes a port (`example.com:8787`), since `url.hostname` never contains a port.

**Reproduction (reproduced).** Real listener, bearer token present, only the `allowed_hosts` spelling varies — `host-allowlist-probe.log`:

```
allowed_hosts="MCP.Example.Test"    Host: MCP.Example.Test   -> HTTP/1.1 403 Forbidden
allowed_hosts="Mcp.Example.Test"    Host: Mcp.Example.Test   -> HTTP/1.1 403 Forbidden
allowed_hosts="mcp.example.test"    Host: mcp.example.test   -> HTTP/1.1 200 OK
allowed_hosts="mcp.example.test:8787" Host: mcp.example.test:8787 -> HTTP/1.1 403 Forbidden
```

Control that isolates the cause: `Host: LOCALHOST` reaches `200 OK` against the default config whose allowlist only contains lowercase `localhost` (`host-wire-probe.log`), proving the normalisation happens on the wire side only. Code trace: `new URL(request.url)` (`src/http.ts:8`) → `.hostname` lowercased → `Set.has` with the raw config string.

**Why existing guards/tests do not help.** `loadConfig` only checks that a token exists for non-loopback entries (`src/config.ts:135-141`); it never validates that an entry is even matchable (lowercase, no port, no trailing dot), so the misconfiguration is accepted silently. `isLoopbackHost` normalising case at `src/config.ts:12` shows case-insensitivity is already the intended semantics, so the inconsistency is inside the same feature. `tests/http.test.ts:62-124` only ever uses `SWARMFORGE_ALLOWED_HOSTS: "mcp.example.com"` — already lowercase, portless, dotless — so the test passes and the class of failure is uncovered. This field is newly exposed as `server.allowed_hosts` in the binary config at `src/settings/load.ts:272-277`, widening the set of operators writing it by hand.

**Recommendation.** Normalise both sides at the boundary and reject unusable entries early. In `src/http.ts`, build the comparison set with `new URL(...).hostname` semantics — lower-case each entry, and strip a trailing root dot — and normalise IPv6 entries to their bracketed form. In `src/config.ts`, add a `superRefine` issue on `SWARMFORGE_ALLOWED_HOSTS` for any entry that cannot match `url.hostname` (contains `:`, differs from its own lowercased form, or has a trailing `.`) so `swarmforge config validate` and `bun start` fail loudly instead of serving 403s. Fixing only the lowercasing removes the common case; the config check removes the silent-403 class.

---

## F2 — MEDIUM — `Origin` is compared against `url.origin`, so any TLS-terminating reverse proxy (the documented deployment shape) rejects every request that carries an `Origin` header

**File/line:** `src/http.ts:30-32`.

**Trigger.** Operator terminates TLS at a proxy and forwards to the plaintext SwarmForge listener, forwarding the public `Host`:

```ini
SWARMFORGE_HOST=127.0.0.1
SWARMFORGE_ALLOWED_HOSTS=mcp.example.test
SWARMFORGE_API_TOKEN=<24+ chars>
```

A browser-based MCP client posts to `https://mcp.example.test/mcp`; the proxy relays it as `Host: mcp.example.test` with no `Origin` rewrite.

**Consequence.** `url.origin` is built from the plaintext connection plus the forwarded `Host`, i.e. `http://mcp.example.test`, while the browser sends `Origin: https://mcp.example.test`. The strict inequality at line 31 fires and returns `403 Forbidden` for *every* route — including `/health` and `/events`, because the check sits ahead of routing. The endpoint is unusable from any origin-aware client and the operator sees no diagnostic distinguishing "TLS terminator" from "hostile origin".

**Reproduction (reproduced).** Real listener, allowed host and valid bearer on every request, only `Host`/`Origin` pairing varies — `host-allowlist-probe.log`:

```
Host: mcp.example.test        Origin: https://mcp.example.test -> HTTP/1.1 403 Forbidden
Host: mcp.example.test        Origin: http://mcp.example.test  -> HTTP/1.1 406 Not Acceptable  (passed the origin check)
Host: mcp.example.test:443    Origin: https://mcp.example.test -> HTTP/1.1 403 Forbidden
```

The `406` line is the control: it reaches the MCP transport, proving the 403 is the origin comparison and nothing else.

**Why existing guards/tests do not help.** `tests/http.test.ts:22-29` asserts only that `Origin: https://hostile.example` is refused, i.e. the guard is tested in the direction that must fail and never in the direction that must succeed. No test exercises a same-host https `Origin`, so the strict-equality rule looks correct while silently excluding the documented proxy shape. `docs/ENVIRONMENT.md:33` tells operators to set `SWARMFORGE_ALLOWED_HOSTS` "for a reverse proxy" and the README says to "Deploy TLS and network access policy externally", so TLS termination is the intended deployment; neither doc states that the proxy must forward a plaintext scheme, which is not something a TLS terminator can do. Note the SDK's own `enableDnsRebindingProtection` is left at its default `false` (`node_modules/@modelcontextprotocol/sdk/.../webStandardStreamableHttp.js:79`), so nothing downstream repairs this.

**Recommendation.** Decide the accepted-origin set from configuration rather than deriving it from the plaintext connection. Either (a) treat `Origin` as advisory when the host allowlist already pinned the authority and a bearer token is configured, or (b) accept an explicit `SWARMFORGE_ALLOWED_ORIGINS` list and/or an opt-in `X-Forwarded-Proto`/`Forwarded` scheme trust limited to requests that already passed the bearer check. Trimming trailing default ports (`:443`, `:80`) is required for (b). If neither is added now, document at `docs/ENVIRONMENT.md:33` that a terminating proxy must rewrite `Origin` to the backend origin, and add the missing positive test.

---

## F3 — LOW — The metrics listener enforces neither the host allowlist nor the bearer token, on the same bind host the config validator protects

**File/line:** `src/serve.ts:177-191` (listener created at 179-190); contrast `src/http.ts:9-29`.

**Trigger.** Non-loopback bind, which `src/config.ts:135-141` treats as requiring a token:

```ini
SWARMFORGE_HOST=0.0.0.0
SWARMFORGE_API_TOKEN=<24+ chars>
SWARMFORGE_METRICS_ENABLED=true
```

**Consequence.** The API listener answers `401`/`403`, which reads as "this deployment is authenticated". `http://<host>:9090/metrics` answers `200 OK` to any client presenting any `Host`, with no bearer required, exposing team labels plus worker/inference/provision-duration and token counters (`src/metrics.ts`). The validator's guarantee is scoped to the MCP surface only, so a deployment can satisfy every documented check and still leave telemetry world-readable on a wildcard bind.

**Reproduction (reproduced).** Real `startServer` with the config above — `host-metrics-probe.log`:

```
--- API listener (18787) ---
Host: 127.0.0.1          no credential   -> HTTP/1.1 401 Unauthorized
Host: evil.example       no credential   -> HTTP/1.1 403 Forbidden
--- metrics listener (19090), no credential, no bearer ---
Host: 127.0.0.1                      -> HTTP/1.1 200 OK
Host: evil.example                   -> HTTP/1.1 200 OK
Host: attacker-controlled.example    -> HTTP/1.1 200 OK
```

**Why existing guards/tests do not help.** `docs/ENVIRONMENT.md:45` does say "Protect externally if public", so this is a disclosed limitation rather than an oversight — hence LOW. But nothing in code or config enforces it, and the non-loopback token requirement at `src/config.ts:135-141` creates the impression the whole deployment is covered. `tests/serve.test.ts:530-542` fetches `/metrics` only from `127.0.0.1` with no Host variation, so no test observes the gap.

**Recommendation.** Route the metrics fetch through the same host allowlist as the API handler (at minimum refuse a non-allowlisted `Host` with `403`), and/or require an explicit opt-in such as `SWARMFORGE_METRICS_ALLOW_ANY_HOST=false` before binding metrics to a non-loopback `SWARMFORGE_HOST`. Add a `403` test for `Host: attacker-controlled.example` on the metrics port.

---

## F4 — LOW — Startup banner prints an invalid URL for IPv6 binds, including the wildcard `::`

**File/line:** `src/runtime.ts:50-56` (host interpolated raw at line 53), reached from `src/serve-command.ts:148-161`. Contrast `src/serve.ts:110-113`, which brackets IPv6 correctly.

**Trigger.** `SWARMFORGE_HOST=::1` or `SWARMFORGE_HOST=::` on a TTY.

**Consequence.** The banner renders `MCP       http://::1:8787/mcp` and `MCP       http://:::8787/mcp` — unparseable URLs, so copy/paste fails and the `bun run status` hint cannot be acted on. The server itself is fine: `handle.url` is correct and the endpoint answers `200`. Line 50 already special-cases `0.0.0.0` for the wildcard case but has no IPv6 analogue.

**Reproduction (reproduced)** — `host-ipv6-probe.log`:

```
host=::1        -> MCP       http://::1:8787/mcp
host=::         -> MCP       http://:::8787/mcp
host=0.0.0.0    -> MCP       http://127.0.0.1:8787/mcp

--- real startServer: bind ::1 ---
handle.url = http://[::1]:8787
banner      = MCP       http://::1:8787/mcp
fetch http://[::1]:port/health -> 200 {"status":"ok"}
```

**Why existing guards/tests do not help.** `startServer` builds `handle.url` through the bracketing `origin()` helper, so the machine-readable value is correct and no assertion anywhere fails; only the human-readable path is wrong. `tests/serve.test.ts` binds `127.0.0.1` throughout (every `serveConfig` call sets `SWARMFORGE_HOST: "127.0.0.1"`), so IPv6 is never rendered. Pre-existing at the target, not introduced by this branch.

**Recommendation.** Reuse the same bracketing logic in `renderStartup`, and map `::` to `[::1]` in the way line 50 maps `0.0.0.0`. Cheapest correct fix: export the helper from `src/serve.ts` (or move it to `src/runtime.ts`) and call it in both places.

---

## Tests and probes actually executed

| # | Command (Bun 1.4.2, in `/tmp/opencode/review20/repo`) | Exit | Outcome |
| --- | --- | --- | --- |
| 1 | `bun install --frozen-lockfile` | 0 | 125 packages; lockfile untouched |
| 2 | `bun test tests/http.test.ts` | 0 | 2 pass, 0 fail, 15 assertions |
| 3 | `bun test tests/http.test.ts tests/serve.test.ts` | 0 | 22 pass, 0 fail, 126 assertions, 4.53s |
| 4 | `bun run probe/host-probe.ts` (21-case handler matrix) | 0 | all cases produced a status; log `host-probe-1.log` |
| 5 | `bun run probe/wire-probe.ts` (raw `node:net` sockets, 3 configs x 10 requests) | 0 | log `host-wire-probe.log` |
| 6 | `bun run probe/allowlist-probe.ts` (allowlist normalisation + proxy origin) | 0 | log `host-allowlist-probe.log` |
| 7 | `bun run probe/ipv6-probe.ts` (real `startServer` on `::1`) | 0 | log `host-ipv6-probe.log` |
| 8 | `bun run probe/metrics-probe.ts` (real `startServer`, API vs metrics) | 0 | log `host-metrics-probe.log` |

Probe scripts: `/tmp/opencode/review20/probe/{host,wire,allowlist,ipv6,metrics}-probe.ts`. All use the repo's own `FakeProvider`/`FakeAgent` and an in-memory or `/tmp` SQLite file. No cloud, model, or network provider was contacted; no smoke test was run; no secret file was read. Logs in `/workspace/.swarmforge/logs/`.

## Limitations

- Full `bun test` was not run (whole-suite scope belongs to another reviewer); only `http.test.ts` and `serve.test.ts` were executed.
- `tsc --noEmit` / `biome check` were not run; this review made no source change to lint.
- F1 and F2 were reproduced against the real handler on a real listener. The operator impact described rests on the documented deployment in `ENVIRONMENT.md:33` and the README's "deploy TLS externally"; I did not stand up a real TLS-terminating proxy, so the browser-`Origin` leg of F2 is code-traced plus socket-reproduced, not end-to-end browser-verified.
- F3 and F4 were reproduced end-to-end against a real `startServer`.
- Not probed: HTTP/2 `:authority` handling, HTTP/3 cleartext, `idleTimeout` interaction with the `/events` SSE stream beyond the existing tests, and non-loopback interface binds other than `0.0.0.0`.
- No credentials appear in this report, the logs, or the probes; only the repository's placeholder test tokens were used.