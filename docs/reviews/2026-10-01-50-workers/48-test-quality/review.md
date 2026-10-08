# SwarmForge review 48 — test quality

- Target: `d428e0f730ed5649485732e95d39c32f5d6a8895` (`feature/binary-config-serve-20260930`)
- Verified: `git -C /tmp/opencode/sf48/target rev-parse HEAD` = `d428e0f730ed5649485732e95d39c32f5d6a8895` (disposable detached clone under `/tmp`)
- Assigned baseline in `/workspace/repo`: `5672ead2a526e07fea9ed11e58b3725e42013527`, left clean and unmodified
- Toolchain: official Bun 1.4.2 installed to `/tmp/opencode/bun142` (snapshot `bun` is 1.3.14 and cannot read this lockfile); `bun install --frozen-lockfile` into the `/tmp` clone only. No lockfile rewrite.
- Scope: test coverage gaps, ineffective assertions, fake divergence, isolated startup flake, random port races, fixture cleanup.

## Verdict: FINDINGS (5)

All five are gaps where the suite passes against deliberately broken production code. Each was confirmed by mutation in a throwaway copy at `/tmp/opencode/sf48/mutant` (never in the source checkout): edit one line, run the suite, observe green.

### F1 — MEDIUM — The real `serve` command is never started by any test

- File: `src/cli.ts:205` (`return runServe(settings.value);`), unguarded.
- Trigger: any regression in the last two lines of `serveCommand` — the `await import("./serve-command")`, the argument it forwards, or the exit code it returns.
- Consequence: `swarmforge serve` becomes a no-op that exits 0. An operator following `README.md:21` gets a silent success, no listener, no banner, no `systemd` supervision failure. The documented production entry point ships broken with a green suite.
- Evidence: mutation `if (settings.value.SWARMFORGE_DB_PATH !== ":memory:") return 0;` inserted before `return runServe(...)`. Full suite `bun test` → **262 pass, 1 skip, 0 fail** (exit 0), 263 tests / 21 files.
- Why existing guards do not prevent it: every test that touches `serve` stops at `runServe`'s own boundary. `tests/commands.test.ts:753,789` and `tests/packaging.test.ts:234,514` only run `serve --check-config`, which returns at `src/cli.ts:199` before the import. `tests/serve.test.ts` calls `runServe`/`startServer` directly. The compiled lifecycle tests in `tests/packaging.test.ts:349-525` deliberately substitute `tests/fixtures/compiled-serve.ts`, which imports `runServe` itself and never goes through `src/cli.ts`. So the only production wiring of `serveCommand` → `runServe` is unexercised.
- Independent confirmation the path is real: I compiled the CLI with `scripts/build.ts` settings and ran `<binary> serve` against a local double config. It reached `runServe` and failed at the provider with `{"level":"error","message":"Startup failed; no SwarmForge listener is running","error":"Invalid or unknown API key"}` — so the wiring exists, is reachable, and is simply never asserted.
- Recommendation: add one test that spawns the compiled binary (or `src/cli.ts`) as `serve` with a persistent DB, waits for `/health`, asserts a nonzero-after-SIGTERM exit, and asserts the startup banner. A local `FREESTYLE_API_URL` pointing at a loopback stub is enough; the failing-provider path already exits 1 cleanly and is a valid assertion target.

### F2 — MEDIUM — `bun run build` and `bun run package` are never executed

- Files: `scripts/build.ts:181-192` (`if (import.meta.main)`), `scripts/package.ts:461` (`const packaged = await packageCli()`).
- Trigger: a break in either script's `import.meta.main` block — wrong output path, missing `process.exit`, a bad default, a stdout shape the release job parses.
- Consequence: the two commands the release workflow actually runs (`.github/workflows/release.yml:60,63`) are unverified. `release.yml` then uploads `dist/*` with `if-no-files-found: error`, so the failure surfaces as a confusing red draft-release job rather than a test failure.
- Evidence, two mutations against `tests/packaging.test.ts` (the only suite that imports these modules), each **35 pass / 0 fail**:
  - `scripts/build.ts`: `compileCli()` replaced with a literal `{path:"/tmp/never",...}` stub → 35 pass.
  - `scripts/package.ts`: bare-`packageCli()` branch replaced with `process.stdout.write('{"packaged":"mutant"}')` → 35 pass.
- Why existing guards do not prevent it: `tests/packaging.test.ts:845-846` asserts only that `package.json` *strings* contain `scripts/build.ts` / `scripts/package.ts`. The suite calls the exported functions with explicit `{outDir, version, commit, executable}` so the default-resolution code (`distDirectory`, `packageVersion`, `repositoryCommit`) and both `import.meta.main` blocks are never entered. `repositoryCommit`'s own failure path (`scripts/build.ts:118-122`, "package from a real checkout") has no test either.
- Recommendation: one test per script that runs `bun scripts/build.ts` and `bun scripts/package.ts` as programs into a temp out dir, parses stdout as JSON, and asserts the reported path/version/commit. Extend to a non-git temp dir to cover the `repositoryCommit` throw.

### F3 — MEDIUM — The symlink-kind filter on artifact directory listings is dead to the suite

- File: `src/files.ts:57` (`e.kind !== "symlink" &&`).
- Trigger: a worker creates a symlink inside `.swarmforge/artifacts/`. `FreestyleProvider.listFiles` (`src/providers/freestyle.ts:308-310`) passes the SDK's `DirEntry` straight through, and `node_modules/freestyle/dist/vms/types.d.ts:449-453` documents `kind` as `file | directory | symlink`.
- Consequence: the symlink entry is listed to a lead as a retrievable artifact. The read path still refuses it (`noSymlinks` → "Symlink artifact paths are not allowed"), so this is a listing-integrity and information-disclosure defect, not a read escape — the symlink's *target path* would be revealed even though its contents are not.
- Evidence: deleting the single line at `src/files.ts:57` → full suite `bun test` **262 pass, 1 skip, 0 fail**. My probe with a realistic `DirEntry[]` (`{name:"escape",kind:"symlink"}`) confirmed the guard is the only thing keeping the entry out of the listing, and that the read is refused independently.
- Why existing guards do not prevent it: `tests/helpers.ts:93-97` `FakeProvider.listFiles` hardcodes `kind: "file"` for every entry, so the fake can never produce the value under test. The one symlink test, `tests/api.test.ts:183-190`, overrides `stat` (the `noSymlinks` path) and never touches `listFiles`. No test anywhere in the repo constructs a `kind: "symlink"` entry.
- Recommendation: in `tests/api.test.ts`, override `h.provider.listFiles` to return `[{name:"ok.txt",kind:"file"},{name:"link",kind:"symlink"},{name:"dir",kind:"directory"}]` and assert only `ok.txt` (and `dir`, if directories are meant to be listed) appears. Better still, give `FakeProvider` a way to record symlinks so the shape matches the SDK.

### F4 — LOW — The OpenCode turn-error branch is never reached

- File: `src/coordinator.ts:596-599`, specifically the `reply.error ? \`OpenCode session failed (${reply.error})\`` arm.
- Trigger: OpenCode returns a completed assistant message with `error` set and no parseable result. `OpenCodeAgent.inspect` maps this at `src/providers/opencode.ts:142` (`error: info.error?.name`).
- Consequence: operators lose the provider's error name. The worker fails with the generic "Missing or malformed structured result" instead of, say, `ProviderOverloadedError`, which is exactly the signal needed to tell a retryable outage from a model that will never answer.
- Evidence: replacing the whole `else` with `await this.fail(w, "Missing or malformed structured result");` → full suite **262 pass, 1 skip, 0 fail**. My probe confirmed the branch is reachable and currently correct (`{"state":"failed","error":"OpenCode session failed (ProviderOverloadedError)"}`), so this is a coverage gap, not a live bug.
- Why existing guards do not prevent it: no test anywhere constructs an `AgentMessage` with `error` set — `grep` for `error:` alongside `role: "assistant"` across `tests/` returns nothing. `FakeAgent.complete` (`tests/helpers.ts:160-197`) only ever sets `result`, and every lifecycle test drives completion through it.
- Recommendation: in `tests/lifecycle.test.ts`, set the snapshot directly to a settled `idle` state whose assistant reply has `error: "SomeError"` and `result: undefined`, tick once, and assert `state === "failed"` with `error` containing that name.

### F5 — LOW — `USERPROFILE` home fallback is untested

- File: `src/settings/paths.ts:15` (`for (const key of ["HOME", "USERPROFILE"])`).
- Trigger: a deployment with no absolute `HOME` but a `USERPROFILE` set.
- Consequence: `homeDirectory` silently falls through to `os.homedir()`, so `~` expansion, the XDG config default and the default database path all land somewhere the operator did not choose — a database created outside the intended location.
- Evidence: reducing the loop to `["HOME"]` → `tests/settings.test.ts tests/commands.test.ts tests/inspect.test.ts` **76 pass / 0 fail**.
- Why existing guards do not prevent it: no test in the repo mentions `USERPROFILE`; every fixture sets an absolute `HOME`.
- Recommendation: one unit test in `tests/settings.test.ts` asserting `defaultConfigPath`/`defaultDatabasePath` follow `USERPROFILE` when `HOME` is unset or relative. Low severity because the project advertises `linux-x64-glibc` only, so this is defensive rather than load-bearing.

## Checked and found sound

- **Random port races** (`tests/serve.test.ts:29-39` `freePort`, `tests/packaging.test.ts:360-370` `port`): both bind port 0, read `.port`, and release. `freePort` uses `void probe.stop(true)` without awaiting, which looks racy; a 200-iteration probe of the exact helper found **0** rebind failures and 0 consecutive duplicate ports. Not a finding.
- **Startup flake budget**: `healthy()` allows 100 × 50 ms = 5 s. Measured compiled-harness boot to `/health` at **154/157/155 ms** over three runs — ~32× headroom. Not a finding.
- **`/tmp/tmp.*` leftover assertion** (`tests/packaging.test.ts:1139-1142`): this asserts on the *global* `/tmp`, not the test's own `mkdtemp` root, so any unrelated process creating a `tmp.*` entry fails the suite. **Confirmed reproducible**: creating `/tmp/tmp.swarmforge-probe` made this test fail with `expect(received).toEqual(expected): - [] + ["tmp.swarmforge-probe"]`, and removing the README `trap` (mutant) produced the intended failure. This is a real cross-test/cross-process coupling defect — but it fails *loudly and specifically*, it caught its own mutation, and the fix is a scoping change rather than a missing guard. Recorded here as a scoped note rather than a numbered finding; recommended fix is to assert against a per-test `TMPDIR` instead of `/tmp`.

## Tests run

| Command | Result |
|---|---|
| `bun test` (clean target clone) | exit 0 — 262 pass, 1 skip, 0 fail, 263 tests / 21 files, 66.2 s |
| `bun test tests/serve.test.ts tests/process-lock.test.ts` | exit 0 — 23 pass, 0 fail, 4.62 s |
| `bun test tests/packaging.test.ts` | exit 0 — 35 pass, 0 fail, 53.4 s |
| `bun test tests/packaging.test.ts -t "bad checksum"` (control, clean `/tmp`) | exit 0 — 1 pass |
| same, with `/tmp/tmp.swarmforge-probe` present | exit 1 — 1 fail (the `/tmp` coupling above) |
| same, mutant with README `trap` removed | exit 1 — 1 fail (guard works) |
| 5 mutations (F1-F5) | each exit 0 with the full suite green — see each finding |

## Limitations

- Mutation testing is a coverage proxy, not proof of a production bug. F2-F5 are latent gaps; only F1's reachability was independently confirmed against a compiled binary.
- No test was run against a real Freestyle, OpenCode or model endpoint. `serve` reachability was established with a local double and a loopback-unroutable provider URL.
- I did not read every test file line by line; findings are concentrated in the delta's new surfaces (`src/cli.ts`, `src/serve*.ts`, `src/settings/*`, `scripts/*`) and the suites that cover them.
- Reviewer experiments live only in `/tmp/opencode/sf48/{target,mutant,probe}` and are disclosed here. `/workspace/repo` is untouched at the assigned baseline with a clean `git status`.
