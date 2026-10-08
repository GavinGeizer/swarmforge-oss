# SwarmForge binary packaging & distribution — research report

- **Inspected commit:** `5672ead2a526e07fea9ed11e58b3725e42013527` (`git rev-parse HEAD`, matches the requested SHA)
- **Branch at inspection:** `swarmforge/packaging-research-20260930/binary-packaging/w-99abcec6-8d73-4f9d-a887-568f8f2229f8`
- **Tree state before and after:** clean (`git status --porcelain` → 0 lines, both times). No repo file created, edited, or deleted; no commits, no pushes.
- **Toolchain for experiments:** Bun `1.3.14`, Node `v24.21.0`, host `Linux 6.1.102 x86_64` (glibc); all work confined to `/tmp/opencode/sf-exp`.
- **Docs fetched (2026-09-30):** `https://bun.sh/docs/bundler/executables`, `https://bun.sh/docs/runtime/environment-variables`. Version-flag claims ("New in Bun vX") are quoted from the first page.

---

## 1. Decision (recommended first release)

**Ship two separate standalone Bun executables built with `bun build --compile`, distributed as GitHub Releases with SHA-256 checksums. Do not publish to npm, do not make `bun link` the primary path, and do not merge server+CLI into one executable.**

| Artifact | Entry | First-release targets | Role |
|---|---|---|---|
| `swarmforge-server` | `src/main.ts` | `bun-linux-x64` (glibc), `bun-linux-x64-musl` | Daemon; the only thing that runs on the server |
| `swarmforge-cli` | `src/cli.ts` | `bun-linux-x64`, `bun-linux-x64-musl`, `bun-linux-arm64`, `bun-darwin-arm64`, `bun-darwin-x64`, `bun-windows-x64` | Operator-facing `swarmforge status` client |

Rationale, tied to this code:

1. **Dual executable, not unified.** `src/cli.ts:1-5` imports only `./cli/client`, `./cli/overview`, `./cli/tui`, which import `@modelcontextprotocol/sdk` and `node:readline`; `grep -rn "runtime" src/cli src/cli.ts` returns nothing, so the CLI never imports `src/runtime.ts` and never touches `bun:ffi`. `src/main.ts:7` imports `acquireProcessLock` and `src/main.ts:14` opens `Store`. The graphs are disjoint at the native level, so one binary would carry ~95 MB of `flock`-locked, SQLite-owning server code on every operator laptop and would make the Windows client story impossible (§4).
2. **`--compile` over `bun link`/npm wrapper.** Verified (§5): both entrypoints compile clean from a cold checkout with no source changes, the outputs run with an empty environment and no `bun`, `node`, or `node_modules`, and startup is 1.8× faster than `bun run`. The wrapper also works, but hard-requires Bun on the end-user PATH.
3. **Keep `bun link`/npm as a documented secondary path** for developers who already have Bun ≥ 1.3 (it already works today — §3).

**Supported matrix to state explicitly in the README for the first release:**

- Server: **Linux only** — x86-64 glibc and x86-64 musl. No arm64 server artifact in v1 (§4).
- Client CLI: Linux x64/arm64, macOS arm64/x64, Windows x64.
- Server-host prerequisites unchanged from `README.md`: `opencode` (SDK-compatible with `1.18.31`), Python 3, Git, Bash, systemd, and `opencode` on the service's PATH. **Not** bundled; out of scope here.
- No OAuth, no multi-repo install, no package-registry publishing in v1.

---

## 2. Current-code evidence (file:line)

| Fact | Evidence |
|---|---|
| Only the CLI is exposed as a command; the server has no bin entry | `package.json:6` — `"bin": { "swarmforge": "./src/cli.ts" }` |
| Publishing to a registry is currently blocked | `package.json:4` — `"private": true` |
| The npm/linked command is a raw TypeScript file with a Bun shebang | `src/cli.ts:1` — `#!/usr/bin/env bun` |
| No `dotenv` dependency exists; config reads the process environment directly | `package.json:17-23` has no `dotenv`; `src/config.ts:154` — `env: Record<string, string \| undefined> = process.env` |
| `.env` therefore works purely via Bun runtime autoload, not application code | `grep -rn "dotenv" src scripts tests` → no matches |
| Server holds a single-writer advisory lock via FFI to libc `flock` | `src/runtime.ts:1` (`bun:ffi`), `src/runtime.ts:106-135`, `src/main.ts:13` |
| The dlopen candidate list is POSIX-only (glibc, musl, macOS libSystem) — **no Windows path** | `src/runtime.ts:109-116` — `libc.so.6`, `/lib/x86_64-linux-gnu/libc.so.6`, `/usr/lib/x86_64-linux-gnu/libc.so.6`, `libc.musl-x86_64.so.1`, `/lib/ld-musl-x86_64.so.1`, `libSystem.B.dylib` |
| Designed-in failure when libc `flock` is unavailable | `src/runtime.ts:131-132` — throws `"Advisory file locking is unavailable on this platform"` |
| Durability is `bun:sqlite`, a built-in, not an npm native addon | `src/store.ts:1` — `import { Database } from "bun:sqlite"` |
| Server rejects in-memory DB, so a writable persistent path is mandatory | `src/main.ts:11-12` |
| Server binds two HTTP listeners and installs SIGINT/SIGTERM shutdown | `src/main.ts:39-45`, `src/main.ts:47-60`, `src/main.ts:87-88` |
| CLI is a remote MCP client driven by env vars, not a local process | `src/cli.ts:20`, `src/cli.ts:51-54` — `SWARMFORGE_URL`, `SWARMFORGE_API_TOKEN` |
| CLI gates on `import.meta.main`, making it a valid `--compile` entrypoint | `src/cli.ts:80` |
| No `files` field, no build script, no release script | `package.json:8-16` — only `dev`, `start`, `status`, `test`, `check`, `format`, `smoke` |
| Stated platform assumption is already Linux-only | `README.md` — "Use Linux with Bun 1.3 or newer" |

### Native-dependency answer

There are **no** npm native addons among the five runtime dependencies. The only native surfaces are `bun:sqlite` and `bun:ffi`, both part of the embedded Bun runtime and both verified working inside a compiled binary (§5.3-5.4). `src/providers/opencode.ts:19` declares `npm: "@ai-sdk/openai-compatible"` in the OpenCode *server* config pushed to workers; that is resolved by the remote `opencode` process, not by SwarmForge, so it does not affect bundling.

---

## 3. Alternatives considered and trade-offs

### A. `bun build --compile` standalone (recommended)

- **Pros:** zero runtime install for operators; no `node_modules`; the CLI ran under `env -i PATH=/usr/bin:/bin`; ~95 MB per binary; 1.8× faster startup than `bun run`; cross-compiles for 8 targets from one Linux host in ~1-2 s each; checksums trivially computed.
- **Cons:** ~95 MB per artifact (the docs concede "Bun's binary is still way too big and we need to make it smaller"); the build host becomes a supply-chain artifact; macOS Gatekeeper needs `codesign` (docs require Bun ≥ 1.2.4 plus JIT entitlements); `Bun.isStandaloneExecutable` is unavailable on 1.3.14, so build-detection needs another approach.

### B. `bun link` / npm-installed wrapper (works today; keep as secondary)

- Verified: with `bun` on PATH, `./src/cli.ts --help` prints help; with `PATH=/usr/bin:/bin` it fails `/usr/bin/env: 'bun': No such file or directory`. The wrapper's whole value is "user already has Bun 1.3+".
- `README.md` already documents this ("The package also provides a `swarmforge status` executable when linked or installed").
- **Blockers as primary channel:** `"private": true` blocks `npm publish`/`bun publish`; `bin` points at a `.ts` file, so a registry tarball would ship TypeScript only Bun can execute; `"files"` is absent so tests/docs would publish; the server has no bin entry.
- **Keep it** for the repo-local developer workflow. If a registry package is ever wanted: drop `private`, add `"files": ["src", "docs/ENVIRONMENT.md"]`, add a server bin, keep `engines.bun`.

### C. Single unified executable (rejected)

Would need a subcommand dispatcher and a `main.ts`/`cli.ts` entry switch. Gains one release artifact; costs ~95 MB of server code on every client machine, forces Windows clients to ship a binary that cannot `flock` (it would fail at `src/runtime.ts:131-132` only if the server path ran — avoidable, but a landmine), and makes CLI `--compile` depend on server modules changing. Not justified at v0.1.0.

### D. Container image (not evaluated)

Out of scope for this task's evidence set; noted only because the server already assumes systemd and a writable volume. No claims made.

---

## 4. Platform reality check vs. existing Linux/server assumptions

- **The server cannot run on Windows, by design of the current code.** `src/runtime.ts:109-116` lists only glibc/musl/libSystem libraries; on Windows `dlopen` of all six fails and `src/runtime.ts:131-132` throws. This matches the existing `README.md` Linux-only assumption, so packaging need not weaken anything.
- **musl.** `LIBC` includes `libc.musl-x86_64.so.1` and `/lib/ld-musl-x86_64.so.1`, and `bun-linux-x64-musl` is a documented target, so a static-musl/Alpine-style host is a legitimate target. Only the cross-compile was verified; the binary was not run on musl.
- **arm64.** `LIBC` is not architecture-qualified — `libc.so.6` resolves on arm64 glibc too — so `bun-linux-arm64` is *plausible* but untested. Since v1 is Linux-x64-only server-side, arm64 support can be deferred; ship the arm64 **CLI** only.
- **Windows client.** `bun-windows-x64.exe` cross-compiled and the CLI graph contains no `bun:ffi`, so it should work; only the build was verified, not execution on Windows.
- **CPU baseline: nothing to do.** The docs state that on x64 "Bun ships a single binary that targets Nehalem (SSE4.2) and selects AVX2/AVX-512 code paths at runtime. The `-baseline` and `-modern` target suffixes are still accepted for backward compatibility and resolve to the same binary." So do **not** publish separate baseline artifacts and do not pin a CPU floor beyond x86-64-with-SSE4.2.

---

## 5. Experiments run (all isolated, `/tmp/opencode/sf-exp`, non-mutating to the repo)

Setup: `tar` of the checkout (excluding `.git`, `node_modules`) into `/tmp/opencode/sf-exp/repo`; all installs and builds happened only there.

**1. Dependency install — reproduced a real blocker.**
```
bun install --frozen-lockfile
  2 |   "lockfileVersion": 2,
error: Unknown lockfile version
warn: Ignoring lockfile
error: lockfile had changes, but lockfile is frozen
```
`/workspace/repo/bun.lock:1` is `"lockfileVersion": 2,`, unparseable by Bun 1.3.14. `README.md` instructs `bun install --frozen-lockfile`, so the documented setup step fails on a Bun satisfying `package.json:7` (`engines.bun >=1.3.0`). Non-frozen `bun install` succeeded: **125 packages in 1.64 s, 121 `node_modules` entries**.

**2. Both entrypoints compile unmodified.**
```
bun build --compile --minify --sourcemap=linked src/cli.ts  --outfile ../bin/swarmforge-cli
  [83ms] minify -1.36 MB (estimate) | [34ms] bundle 249 modules | [1014ms] compile -> EXIT=0
bun build --compile --minify --sourcemap=linked src/main.ts --outfile ../bin/swarmforge-server
  [67ms] minify -1.26 MB (estimate) | [39ms] bundle 388 modules | [630ms] compile  -> EXIT=0
```
Sizes: `swarmforge-cli` 95,373,440 B; `swarmforge-server` 96,733,312 B. No source change, no plugin, no `bunfig.toml` needed.

**3. Native probe inside a standalone binary.** A `probe.ts` importing `src/config`, `src/runtime`, `src/store`, compiled with `--compile`, then run from an empty directory with `PATH=/usr/bin:/bin` and no `bun`/`node` present:
```
FLOCK_OK
SQLITE_OK value=written
LOCK_CONFLICT_OK msg=Another SwarmForge process owns this database
SECOND_ACQUIRE_UNEXPECTED=false
REACQUIRE_AFTER_UNLOCK=true
CONFIG_ERR msg=Invalid configuration: FREESTYLE_API_TOKEN: ... (expected string, received undefined)
DOTENV_PROBE=from-dotenv-file
```
`bun:ffi` `dlopen`+`flock`, `bun:sqlite`, and the cross-process lock protocol from `src/runtime.ts:145-171` all work inside the binary. `Bun.isStandaloneExecutable` and `Bun.execPath` printed `undefined` on 1.3.14 (also `undefined` under plain `bun -e`), so do not rely on them for build detection.

**4. Server binary boots with an empty environment.**
```
cd srv && env -i HOME=/root PATH=/usr/bin:/bin ../bin/swarmforge-server
{"level":"error","message":"Startup reconciliation failed; verify Freestyle connectivity and configuration"}
SERVER_EXIT=1
```
That message is verbatim `src/main.ts:30-36`. Reaching it proves config load, `.env` autoload, lock acquisition, `Store` open, and the `Bun.serve` path all ran; only the outbound Freestyle call failed (no real credentials used).

**5. CLI binary needs nothing installed.**
```
cd cleancli && PATH=/usr/bin:/bin ../bin/swarmforge-cli --help   -> full usage text, CLI_EXIT=0
../bin/swarmforge-cli          -> "SwarmForge: Unable to connect. Is the computer able to access the url?"
```

**6. dotenv autoload in compiled executables (the key config question).**
- A `.env` containing `SWARMFORGE_DOTENV_PROBE=from-dotenv-file` → `DOTENV_PROBE=from-dotenv-file`. **Autoload is ON by default**, resolved against the *current working directory*, consistent with the docs' "load configuration files from the directory where they are run".
- A `.env` containing `SWARMFORGE_URL=ftp://example.invalid` → `SwarmForge: MCP endpoint must use http or https`. That message can only come from `src/cli.ts:38-39`, proving `src/cli.ts:20` read the value from `.env`.
- A real environment variable beats `.env`: `SWARMFORGE_URL=http://127.0.0.1:1/mcp` → connection error instead.
- **Build-time opt-out works:** recompiled with `--no-compile-autoload-dotenv --no-compile-autoload-bunfig`, the same `.env` produced the connection error (fallback to the default `http://127.0.0.1:8787/mcp`), i.e. `.env` was ignored.
- **Caveat:** `BUN_OPTIONS="--no-env-file"` did **not** suppress `.env` in the compiled binary (same `ftp` error). Use the build-time flag, not the runtime env var, for determinism.
- Docs match: compiled executables autoload `.env` and `bunfig.toml` by default and do **not** autoload `tsconfig.json`/`package.json`; the docs also warn `.env`/`bunfig.toml` autoload "may also be disabled by default in a future version of Bun". For a systemd unit using `EnvironmentFile=`, pass `--no-compile-autoload-dotenv --no-compile-autoload-bunfig` so behaviour is CWD-independent and version-stable.

**7. Cross-compilation from one Linux x64 host.** All four targets built without source changes: `bun-darwin-arm64` (63,759,842 B), `bun-windows-x64` (auto `.exe`, 98,791,936 B, downloaded a 37 MB runtime), `bun-linux-arm64` (93,956,240 B), `bun-linux-x64-musl` (91,482,400 B) — ~1.2-1.8 s each. Bun reported target runtime versions (`bun-darwin-aarch64-v1.3.14`, `bun-windows-x64-v1.3.14`, `bun-linux-aarch64-v1.3.14`, `bun-linux-x64-musl-v1.3.14`), confirming the target runtime is pinned by the building Bun.

**8. Startup cost, 10 invocations each.**
```
10x swarmforge-cli --help   real 0m0.658s   (~66 ms/invocation)
10x bun src/cli.ts --help   real 0m1.165s   (~117 ms/invocation)
```

**9. Wrapper route sanity check.**
```
./src/cli.ts --help                    -> works (bun on PATH)
PATH=/usr/bin:/bin ./src/cli.ts --help -> /usr/bin/env: 'bun': No such file or directory
```

**10. Checksum example** (`sha256sum`, the proposed release-asset mechanism):
```
652265f72b954ec634cfeb6a18e8d7f7a01f975e2662ea49d27991f8bd491a29  swarmforge-cli
155648b3b5b058ded48a2ba9b78eaaecb6a390e0dce9bd0d28b05db09ac72c58  swarmforge-server
```
Digests from this machine only, not reproducible release values (build determinism untested).

---

## 6. Implementation sequence

1. **Fix `bun.lock` first (blocking).** Regenerate it with a Bun that understands `lockfileVersion: 2`, or rewrite it to the version 1.3.14 emits, so the `bun install --frozen-lockfile` step in `README.md` works. Everything below assumes a reproducible install.
2. **Add a build script** (new `scripts/build.ts` or shell in `package.json`), not source changes to `src/`:
   - server: `bun build --compile --minify --bytecode --target=bun-linux-x64 --no-compile-autoload-dotenv --no-compile-autoload-bunfig --define SWARMFORGE_VERSION='"0.1.0"' src/main.ts --outfile dist/swarmforge-server`
   - CLI: same flags, `src/cli.ts`, per target, `--outfile dist/<target>/swarmforge-cli`
   - Hold `--bytecode` until measured on the real server start path; the docs report 2× faster `tsc` starts for large inputs and the server is not startup-latency-critical.
3. **Add a server bin entry** for symmetry: `"bin": { "swarmforge": "./src/cli.ts", "swarmforge-server": "./src/main.ts" }`, plus a `#!/usr/bin/env bun` shebang on `src/main.ts` for the wrapper path only.
4. **Surface the build-time version** (`--define SWARMFORGE_VERSION`) in `renderStartup` (`src/runtime.ts:32-57`). Today `src/main.ts` accepts no flags at all, so a `--version` acceptance test needs a small `process.argv` check.
5. **Emit `dist/SHA256SUMS`** in the build script (`sha256sum` on Linux, `shasum -a 256` on macOS) and attach it to the GitHub Release.
6. **Add a release workflow**: `on: push tags v*` → matrix `[bun-linux-x64, bun-linux-x64-musl, bun-linux-arm64, bun-darwin-arm64, bun-darwin-x64, bun-windows-x64]` for the CLI and `[bun-linux-x64, bun-linux-x64-musl]` for the server; `oven-sh/setup-bun` pinned per `engines`; upload each binary plus `SHA256SUMS`; on the `darwin-arm64` runner add `codesign` with JIT entitlements per the docs. Install = download binary, `chmod +x`, place on `PATH` (e.g. `/usr/local/bin`).
7. **Document the matrix** in `README.md` (Linux server; cross-platform CLI) and `docs/ENVIRONMENT.md`, keeping `bun run dev` / `bun start` as the developer path.---

## 7. Acceptance tests (and how to run them)

1. **Server binary on a bare host.** On a clean VM with only `opencode`, git, bash, systemd: `env -i PATH=/usr/bin:/bin /opt/swarmforge/bin/swarmforge-server` with `EnvironmentFile=/etc/swarmforge/swarmforge.env`; assert the JSON `SwarmForge listening` line from `src/runtime.ts:41-49` (non-TTY) and that `curl http://127.0.0.1:8787/mcp` answers.2. **Autoload determinism.** With the `--no-compile-autoload-dotenv` binary, `cd /tmp && .../swarmforge-server` must fail config validation even though `/tmp/.env` exists; without the flag it must pick it up. Guards the CWD-dependent behaviour in §5.6.
3. **Lock exclusivity across binaries.** Start A on a db path, start B on the same path; assert B exits with `Another SwarmForge process owns this database` (`src/runtime.ts:153`). Then SIGTERM A (`src/main.ts:87-88` → `src/runtime.ts:162-170`) and assert B can then start.
4. **SQLite durability through the binary.** Start server A, create a worker via MCP, `SIGKILL`, restart, assert `get_worker`/`get_worker_result` still resolve (mirrors `tests/restart.test.ts`).
5. **CLI on every shipped target.** For each CLI asset, `swarmforge-cli --help` must exit 0 with the exact usage string from `src/cli.ts:7-17`; `swarmforge-cli --json` against a live server must emit parseable overview JSON.
6. **Checksum integrity.** `sha256sum -c SHA256SUMS` must pass for every asset, and the release's `SHA256SUMS` must match the binaries attached to that tag.
7. **Frozen install reproducibility.** `bun install --frozen-lockfile && bun test && bun run check` must pass in CI on a clean checkout — currently failing, see §5.1.
8. **Wrapper parity.** `bun link` (or an npm-pack install) must still yield a working `swarmforge status`, keeping the existing README claim true.

---

## 8. Residual uncertainty

- The Windows and macOS binaries were **built but not executed**; no Windows/macOS runner was available. Their viability rests on the CLI having no `bun:ffi` in its graph.
- `bun-linux-x64-musl` and `bun-linux-arm64` binaries were **built but not executed**. Arm64 support of the `LIBC` list in `src/runtime.ts:109-116` is inferred from `libc.so.6` being architecture-neutral, not verified.
- No `--bytecode` build was measured; that startup win comes from the docs, not this code.
- Build reproducibility (identical bytes from two runs of one commit) was **not** tested, so the §5.10 digests are illustrative only. `--sourcemap=linked` also writes sidecar `.map` files; decide whether those ship.
- Whether `bun install --frozen-lockfile` was ever verified green upstream is unknown — only that it fails on Bun 1.3.14 here.
- `bun:ffi` `flock` was not stress-tested under concurrent multi-process load in a compiled binary; §5.3 covered only the single-process success/conflict/reacquire path.
- `--minify` cost/benefit on a 95 MB binary is unmeasured (it trims the JS payload, not the runtime).
- `docs/ENVIRONMENT.md` and the Freestyle/OpenCode integration were read only enough to identify native and subprocess requirements; no VM, `opencode` process, or real endpoint was exercised. No credentials were used.
