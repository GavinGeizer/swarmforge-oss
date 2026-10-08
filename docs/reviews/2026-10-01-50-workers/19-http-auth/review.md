# Reviewer 19 — HTTP bearer authentication, public-host policy, timing/error paths

- **Target (exact):** `d428e0f730ed5649485732e95d39c32f5d6a8895`
- **Branch:** `feature/binary-config-serve-20260930`
- **Verified:** `git rev-parse HEAD` in disposable detached clone `/tmp/sf19/r` = `d428e0f730ed5649485732e95d39c32f5d6a8895`
- **Assigned branch** `/workspace/repo` left at baseline `5672ead2a526e07fea9ed11e58b3725e42013527`, clean (`git status --porcelain` empty), no writes.
- **Toolchain:** Bun 1.4.2 (official release, unpacked to `/tmp/sf19/bun-linux-x64`); snapshot Bun is 1.3.14 and cannot read `lockfileVersion: 2`. Lockfile never rewritten.
- **Scope files:** `src/http.ts`, `src/config.ts` (host/token policy), `src/serve.ts` (listener wiring), `src/security.ts` (token redaction on authed surfaces), `src/mcp.ts` (authed surface), `tests/http.test.ts`, `tests/core.test.ts`, `docs/ENVIRONMENT.md`.
- **Verdict:** FINDINGS (6; 2 MEDIUM, 4 LOW). No CRITICAL/HIGH.
- **Sanitization:** every credential-shaped literal below is a fake local fixture replaced with `<TOKEN>`; no real credentials appear. Reviewer scripts live only in `/tmp/sf19/probe/`, logs in `/workspace/.swarmforge/logs/`.

## Delta context

`src/http.ts` and `src/config.ts` are **unchanged** from baseline `5672ead`; `src/serve.ts` is new. The unauthenticated metrics listener (F1) was carried over verbatim from the deleted `src/main.ts` (verified via `git show 5672ead:src/main.ts`), so F1 is pre-existing rather than introduced by this branch.

## Finding F1 — MEDIUM — Metrics listener has no host allowlist and no bearer authentication

- **File/line:** `src/serve.ts:177-191` (listener), gate logic at `src/serve.ts:182-190`.
- **Trigger:** deployment sets `SWARMFORGE_HOST=0.0.0.0` (or a public IP) plus `SWARMFORGE_API_TOKEN` — the exact configuration `src/config.ts:135-141` requires and the only thing that stops anonymous access to the API port. Metrics bind on the same `SWARMFORGE_HOST` with a bare `fetch` that does `new URL(request.url).pathname === "/metrics"` and nothing else.
- **Consequence:** any host that can reach `SWARMFORGE_METRICS_PORT` gets `swarmforge_workers{team=...,state=...}`, `swarmforge_workers_created_total`, `swarmforge_tokens_total{model=...}` and provision/task-duration histograms with **no credential and no Host check**. Team identifiers and the model name are disclosed for teams listed in `SWARMFORGE_METRICS_TEAMS`; every other team collapses to `"other"`. No token values are exposed. The operator's mental model ("a token is required for any non-loopback host") is only true of one of the two listeners.
- **Reproduction (reproduced):** started `startServer` with `SWARMFORGE_HOST=0.0.0.0`, `SWARMFORGE_API_TOKEN` set, `SWARMFORGE_METRICS_TEAMS=default,team`, fake provider/agent, on-disk DB in `/tmp`. Then, with no `Authorization` header:
  ```
  [P4] metrics /metrics NO token -> 200, 2037 bytes
  [P4] metrics with WRONG token -> 200
  [P4] metrics with arbitrary Host header -> 200
  [P4] api /health no token -> 401          # contrast: API port is gated
  [P5] UNAUTH metrics -> 200
  [P5]   swarmforge_workers{team="team",state="queued"} 1
  [P5]   swarmforge_workers_created_total{team="team"} 1
  [P5]   swarmforge_tokens_total{team="team",model="qwen",direction="input"} 0
  ```
  (See `/workspace/.swarmforge/logs/probe-auth.log`.)
- **Recommendation:** run the metrics listener through the same `createHttpHandler` allowlist+bearer gate (extract a `hostAndAuth(request)` helper from `src/http.ts` and reuse it), or give metrics its own credential and host allowlist, and/or bind `SWARMFORGE_METRICS_PORT` to a loopback-only address by default (`SWARMFORGE_METRICS_HOST`, default `127.0.0.1`) while exposing it through the authenticated port.
- **Why existing guards/tests do not prevent it:** the non-loopback token invariant is enforced only in `config.ts` `superRefine` and implemented only inside `createHttpHandler`; `serve.ts` builds the metrics listener with a separate inline `fetch`. `tests/serve.test.ts` / `tests/http.test.ts` never assert anything about the metrics port's authorization. `docs/ENVIRONMENT.md:32` does document that `SWARMFORGE_HOST` is the "MCP **and metrics** listen interface", so the exposure is real, and `docs/ENVIRONMENT.md:35` scopes the token promise to "every accepted hostname" without mentioning the second listener.

## Finding F2 — MEDIUM — Origin equality rejects the documented TLS-terminating reverse-proxy deployment

- **File/line:** `src/http.ts:30-32`.
- **Trigger:** the deployment `src/config.ts:13-15` and `docs/ENVIRONMENT.md:33` explicitly target — loopback bind + `SWARMFORGE_ALLOWED_HOSTS=mcp.example.com` behind a proxy that terminates TLS. The proxy forwards `Host: mcp.example.com`; Bun builds the request URL as `http://mcp.example.com/...`, so `url.origin` is `http://mcp.example.com` while any browser-origin client sends `Origin: https://mcp.example.com`. The `!==` test is true and the request is refused.
- **Consequence:** an authenticated browser MCP client or `EventSource` subscriber behind HTTPS gets `403 Forbidden origin` on **every** surface (`/health`, `/events`, `/mcp`), while `curl` and the `swarmforge` CLI (which send no `Origin`) work. Because auth already passed, the 403 is indistinguishable to the operator from a bad token, and the only workaround is disabling the origin check.
- **Reproduction (reproduced over a real socket, `Bun.serve` on 127.0.0.1:18789):**
  ```
  [P6] loopback Host, token, no Origin              -> HTTP/1.1 200 OK
  [P6] public Host, token, no Origin                -> HTTP/1.1 200 OK
  [P6] public Host, token, https Origin (TLS proxy) -> HTTP/1.1 403 Forbidden
  [P6] public Host, token, http Origin same port    -> HTTP/1.1 200 OK
  [P6] public Host, token, events https Origin      -> HTTP/1.1 403 Forbidden
  ```
  Also reproduced with a synthetic `Request` (`Origin: https://mcp.example.com` on `http://mcp.example.com/health` → 403; no `Origin` → 200).
- **Recommendation:** compare the origin **host** against the same accepted-host set used for the `Host` header instead of exact `scheme://host:port` equality — a hostile page's `Origin` host is then still rejected because it cannot be in the allowlist, while `https` vs `http` and proxy-rewritten ports stop mattering. Alternatively accept the configured public origins explicitly (e.g. a `SWARMFORGE_ALLOWED_ORIGINS` list).
- **Why existing guards/tests do not prevent it:** `tests/http.test.ts:19-31` only asserts that `Origin: https://hostile.example` is rejected. Nothing asserts the accept path, so the check is tested exclusively in the direction that passes.

## Finding F3 — LOW — Bearer comparison short-circuits on length, so `timingSafeEqual` never protects wrong-length candidates

- **File/line:** `src/http.ts:24-28`.
- **Trigger:** any request whose `Authorization` value has a different byte length than `Bearer <token>`. `Buffer.byteLength(actual) !== Buffer.byteLength(desired)` short-circuits, so `timingSafeEqual` is never called for those requests.
- **Consequence:** the response time for a `401` is a function of the candidate's length, disclosing the **exact length of the configured token** (config enforces only `min(24)`, `src/config.ts:81`) and confirming a length match. It does not disclose any prefix, so practical impact is small.
- **Evidence:** the short-circuit is explicit in source. Micro-measurement of the in-process handler (120 000 interleaved samples, `Buffer.byteLength` vs `timingSafeEqual` vs success paths): `len8 median=0.00184ms`, `same-len-wrong median=0.00221ms`, `correct median=0.00241ms` — a real but ~0.4 µs branch difference, far below network/HTTP noise. **Honest limit: not demonstrated exploitable over a network; code-evidenced only.**
- **Recommendation:** hash both sides before comparing, e.g. `timingSafeEqual(sha256(actual), sha256(desired))`, which is fixed-length and removes the branch entirely.
- **Why existing guards/tests do not prevent it:** `tests/http.test.ts:12-31,68-110` only asserts status codes for wrong/absent tokens; no test exercises constant-time behaviour, and none can.

## Finding F4 — LOW — Host allowlist is compared case-sensitively, so a configured hostname in non-lowercase form never matches

- **File/line:** `src/http.ts:9-18` (`hosts` set built verbatim) versus `src/config.ts:11-12` (`isLoopbackHost` does `.trim().toLowerCase()`).
- **Trigger:** `SWARMFORGE_ALLOWED_HOSTS=MCP.Example.COM`. `new URL(...).hostname` is always lowercased by the WHATWG parser, so the entry can never match. `config.ts` accepts the value and demands a token, so the deployment looks healthy at startup.
- **Consequence:** the operator's configured public hostname is silently refused with `403 Invalid host` for every request — an availability break on the exact endpoint they configured. Fail-closed, so this is not a bypass.
- **Reproduction (reproduced):**
  ```
  [F4] allowed="MCP.Example.COM" url=http://mcp.example.com/health  -> 403
  [F4] allowed="MCP.Example.COM" url=http://MCP.EXAMPLE.COM/health  -> 403
  [F4] allowed="  mcp.example.com  " (trimmed by http.ts)           -> 200
  [P2] 2h host upper case (allowed="mcp.example.com", url upper)    -> 200
  ```
- **Recommendation:** normalize once in `http.ts` (`.trim().toLowerCase()`) or, better, export a single `acceptedHosts(config)` helper from `config.ts` and use it in both `superRefine` and `createHttpHandler` so the policy cannot drift.
- **Why existing guards/tests do not prevent it:** `tests/core.test.ts:33-48` and `tests/http.test.ts:58-135` only use already-lowercase hostnames; there is no mixed-case assertion.

## Finding F5 — LOW — Missing `Host` header throws out of the handler before any auth check

- **File/line:** `src/http.ts:8` (`const url = new URL(request.url);`), unguarded.
- **Trigger:** an HTTP/1.0-style request with no `Host` header and a relative target (`GET /health HTTP/1.0`). Bun hands the handler a relative `request.url`, so `new URL` throws `TypeError [ERR_INVALID_URL]`. This happens **before** the host allowlist (line 18) and the bearer check (line 20), so it is unauthenticated and pre-auth by construction. Nothing in `createHttpHandler` or `startupGate` (`src/serve.ts:50-61`) catches it, so it escapes to Bun's global error handler.
- **Consequence:** the client gets a bare `500` instead of `400`/`403`, and Bun writes an attacker-triggerable stack trace to server stderr on every such request (log flooding / alerting noise; absolute filesystem paths and source line numbers land in operator logs).
- **Reproduction (reproduced over a real socket):**
  ```
  [P6] no Host header (HTTP/1.0 style) -> HTTP/1.1 500 Internal Server Error
  # stderr: TypeError: Invalid URL  input: "/health"  at http.ts:8:17 ... "GET - /health failed"
  ```
  (The probe process exited 1 only because this unhandled error was the last statement of the script.)
- **Recommendation:** wrap the parse (ideally the whole handler body) in `try/catch` returning `400 Bad Request`, and reject early when `request.headers.get("host")` is absent.
- **Why existing guards/tests do not prevent it:** `tests/http.test.ts` and `tests/serve.test.ts` always construct absolute URLs; no test drives a raw HTTP/1.0 request or an empty-Host request.

## Finding F6 — LOW — `401` responses omit `WWW-Authenticate: Bearer`

- **File/line:** `src/http.ts:28`.
- **Consequence:** RFC 9110 requires a `WWW-Authenticate` challenge on a `401`; without it, HTTP clients and MCP transports that key re-authentication off the challenge header cannot discover that a bearer credential is expected, surfacing the bare body string `Unauthorized` instead.
- **Evidence (reproduced):** every `401` observed had `www-authenticate=null` — `[P5] UNAUTH events -> 401 www-authenticate=null`, and all `[P2]` cases report `no-WWW-Authenticate`.
- **Recommendation:** `return new Response("Unauthorized", { status: 401, headers: { "www-authenticate": 'Bearer realm="swarmforge"' } });`
- **Why existing guards/tests do not prevent it:** status-code-only assertions in `tests/http.test.ts`.

## Guards verified as working (no defect)

- Gate ordering in `src/http.ts` is host → bearer → origin → route; `/health`, `/events` and `/mcp` all sit behind it. Unauthenticated `GET /health`, `GET /events` and `POST /mcp` all returned `401` against a live server with a token configured (`[P5]`).
- Unknown paths return `404` only **after** auth (`src/http.ts:54`), so there is no unauthenticated route enumeration. `GET/DELETE /mcp` → `405 Allow: POST`; `OPTIONS` → `405` with no CORS headers, so browsers cannot read cross-origin responses.
- An unlisted `Host` is refused even when the bearer token is correct (`[P6] unlisted Host, token -> 403`), i.e. DNS-rebinding protection is not bypassable with a valid token. `Host: mcp.example.com.` (trailing dot) → `403` (fail-closed).
- Token requirement for non-loopback exposure is enforced in `src/config.ts:135-141` and reproduced: `SWARMFORGE_HOST=0.0.0.0`, `SWARMFORGE_HOST=203.0.113.10` without token, `SWARMFORGE_ALLOWED_HOSTS=0.0.0.0`, `=localhost.`, `=mcp.example.com` are all rejected at startup. Loopback-only + no token stays anonymous **by design** and is documented (`docs/ENVIRONMENT.md:35`, `tests/http.test.ts:58-66`).
- Token redaction is applied on both authenticated event surfaces: `src/http.ts:42` (`redactorFor(c)` for `/events`) and `src/mcp.ts:14,40` (every tool result), and `redactorFor` includes `SWARMFORGE_API_TOKEN` (`src/security.ts:47`), so an echoed credential cannot leak through `/events` or MCP.
- `expected` is read from config per request (`src/http.ts:20`), so the gate cannot go stale.
- `SWARMFORGE_HOST=LOCALHOST` is correctly treated as loopback by config's lowercasing and is matched by `http.ts`'s hardcoded lowercase `localhost`.

## Tests and probes actually executed

| Command (Bun 1.4.2, in `/tmp/sf19/r`) | Exit | Result |
| --- | --- | --- |
| `bun test tests/http.test.ts` | 0 | 2 pass, 0 fail, 15 assertions |
| `bun test tests/core.test.ts tests/cli.test.ts -t "token"` | 0 | 2 pass, 0 fail, 8 assertions, 10 filtered out |
| `bun run /tmp/sf19/probe/auth-probe.ts` | 0 | P1–P4 logged |
| `bun run /tmp/sf19/probe/auth-probe2.ts` | 0 | F3/F4 logged |
| `bun run /tmp/sf19/probe/auth-probe3.ts` | 0 | P5 logged (live server + MCP spawn) |
| `bun run /tmp/sf19/probe/auth-probe4.ts` | 1 | P6 logged; exit 1 caused by the F5 unhandled error at end of script |

Probe scripts and raw logs: `/tmp/sf19/probe/*.ts`, `/workspace/.swarmforge/logs/probe-auth*.log`.

## Limitations

- **No real providers, no network egress, no cloud/model calls.** All probes used the repo's own `FakeProvider`/`FakeAgent` and SQLite in `/tmp` or `/tmp` on-disk DBs. `FreestyleProvider`, `OpenCodeAgent` and `git push` paths were out of scope.
- **Full test suite not run** — reserved for the whole-suite reviewer. Only `tests/http.test.ts` and the token-filtered `core`/`cli` tests were executed; no typecheck (`tsc --noEmit`) or `biome` run, since this scope produced no source changes.
- F3's timing claim is **code-evidenced with an in-process micro-measurement only**; network exploitability was not measured.
- F2 was reproduced against `Bun.serve` with a proxy-style `Host` header, not against a real TLS-terminating proxy; the reverse-proxy deployment itself was not stood up.
- `/workspace/repo` was never written to; the working tree is the disposable clone at `/tmp/sf19/r` (`bun install` created `node_modules` there, outside the source checkout).
