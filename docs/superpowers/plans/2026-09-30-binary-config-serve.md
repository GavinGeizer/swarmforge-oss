# Binary, Global Configuration, and Serve Implementation Plan

> **For agentic workers:** Use `using-swarmforge` with parallel implementation for Tasks 1–2, followed by dependency stages for Tasks 3–4. Use `superpowers:executing-plans` when implementing a work package. Steps use checkbox syntax for tracking. Each implementation branch requires a separate read-only reviewer before integration.

**Goal:** Install one standalone `swarmforge` command that reads explicit global configuration, runs the existing client dashboard from any directory, and starts the control plane through foreground `serve`.

**Architecture:** Retain the existing internal `Config`, environment validator, and worker protocol. Add a global configuration loader and an import-safe server lifecycle API, then compose them through a unified CLI. Package that entrypoint with Bun and disable automatic runtime loading of invocation-directory configuration.

**Tech Stack:** Bun 1.4.2 for builds, TypeScript, existing Zod validation, Bun TOML, SQLite, existing MCP/Freestyle/OpenCode SDKs, and the existing advisory process lock.

**Spec:** [Verified research recommendation](../../research/2026-09-30-packaging/RECOMMENDATION.md).

## Global constraints

- Initial supported packaged runtime: Linux x64 glibc. Test additional targets before advertising them.
- One executable exposes `status`, `serve`, configuration diagnostics, help, and version.
- Help, version, and client configuration must not require provider/model credentials or initialize server resources.
- Global configuration and the default database path are independent of the invocation directory.
- No automatic project `.env`, TOML, or `bunfig.toml` discovery. Explicit legacy environment-file input remains supported.
- Config default: `$XDG_CONFIG_HOME/swarmforge/config.toml`, fallback `~/.config/swarmforge/config.toml`.
- Database default: `$XDG_DATA_HOME/swarmforge/swarmforge.sqlite`, fallback `~/.local/share/swarmforge/swarmforge.sqlite`. Preserve the adjacent `.lock` and `.log` arrangement initially.
- Ignore relative XDG overrides. New private directories/files use `0700`/`0600`; do not change unrelated existing directories' permissions.
- Preserve public-host bearer requirements, credential redaction, worker environment allowlist, process locking, durable results, and existing MCP semantics.
- No automatic database relocation, service installation, GitHub release publication, or credential migration. Keep existing database paths and instance IDs through explicit configuration.
- First milestone remains one repository per server. Multi-repository projects, GitHub OAuth, builtin daemonization, automatic updates, and expanded OS support are later work.
- Preserve the current skill refactor, research documents, and unrelated untracked files; implement in isolated worker branches and an isolated integration checkout.

## Review focus

1. Running from a foreign directory must not load its secrets or create a new local database (Tasks 1, 3, 4).
2. An existing relative database override must retain its documented meaning, rather than silently selecting an empty replacement (Tasks 1, 3).
3. Metrics bind failure or SIGTERM during startup must release acquired resources without exposing a half-started service (Task 2).
4. A stop timeout must not close SQLite while an in-flight coordinator operation can still write (Task 2).
5. The installed binary must work without a Bun executable or node_modules and retain lock/restart behavior (Task 4).

## Division of work and ownership

| Package | Owner | Files | Dependency |
| --- | --- | --- | --- |
| A: Configuration | Config coder | New `src/settings/paths.ts`, `src/settings/load.ts`, `src/settings/inspect.ts`; config tests; `docs/CONFIGURATION.md` | Agreed contracts below |
| B: Lifecycle | Server coder | New `src/serve.ts`, `src/serve-command.ts`; `src/main.ts`, targeted `src/coordinator.ts`/`src/runtime.ts` changes; lifecycle tests; `docs/SERVE.md` | Existing internal `Config`; agreed contracts |
| C: Unified CLI | CLI coder | `src/cli.ts`, new `src/cli/arguments.ts`, `src/version.ts`; CLI command tests | Reviewed A and B |
| D: Packaging | Packaging coder | New `scripts/build.ts`, `scripts/package.ts`, `.github/workflows/release.yml`, `tests/packaging.test.ts`; `package.json`, `.gitignore`, `README.md` | Reviewed C plus all prerequisites |
| Review | Independent read-only reviewers | Exact implementation base/head; complementary correctness and security/lifecycle scopes where justified | Settled implementation commit |
| Verification | Read-only verification worker | Run integrated CLI and packaged-runtime acceptance cases in disposable directories; report failures to the owning coder | Approved integrated candidate |
| Integration | Lead | Isolated integration branch, ancestry/conflict handling, combined checks | Approved exact SHAs |

No two coders edit the same file concurrently. `src/config.ts`, `src/http.ts`, `src/store.ts`, and shared test helpers remain unchanged unless a demonstrated need is reassigned to one owner before editing. Dedicated package tests can build their own fixtures using existing doubles.

The user permits up to ten concurrent Swarmforge workers; this is a ceiling, not a target. Start with A and B. As their branches settle, run independent reviews concurrently; add a second reviewer when a separate risk justifies it. Keep capacity for author corrections and a separate integrated verification worker. Typical useful concurrency is four to six workers. C and D remain gated by their prerequisites, so additional slots do not justify speculative implementations. Reuse author sessions for corrections; each new substantive head needs review. Reviewers and verification workers do not implement fixes. No workers are spawned as part of writing this plan.

| Wave | Concurrent work | Expected active workers |
| --- | --- | --- |
| Foundation | A and B implementation | 2 |
| Foundation review | Review A and B independently; retain authors for corrections; add complementary scrutiny of credential handling or lifecycle when warranted | 4–6 |
| CLI | C implementation, then its independent review; finish any prerequisite follow-up first | 2–3 |
| Packaging | D implementation, then package/release review and separate integrated verification | 3–4 |
| Final gate | Whole-change review and independent acceptance verification; retain only authors with unresolved findings | 2–6 |

Counts include retained author VMs, not just running model turns. After reports and source durability are verified, destroy workers that no longer have pending work. Never exceed ten; inspect current capacity and inventory before each new assignment.

## Contracts agreed before dispatch

Task A exports from `src/settings/load.ts`:

```ts
interface SettingsOptions {
  configPath?: string;
  envFiles?: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
  overrides?: Record<string, string | undefined>;
}
interface ResolvedSettings<T> {
  value: T;
  configPath: string | null;
  provenance: Record<string, string>;
}
interface ClientSettings { url: string; token?: string; }
function resolveServerSettings(options?: SettingsOptions): Promise<ResolvedSettings<Config>>;
function resolveClientSettings(options?: SettingsOptions): Promise<ResolvedSettings<ClientSettings>>;
```

`Config` is the existing type from `src/config.ts`. Keep `loadConfig(env)`, `gitTree`, and `workerEnvironment` unchanged for current callers/tests. New default path selection happens in the new loader before calling `loadConfig`.

Task A exports `redactedSettings(settings)` from `src/settings/inspect.ts`: returns a serializable view with sources, never secret values or fragments. Task B consumes an already validated `Config`, not TOML or discovery options. Task C resolves settings and passes the resulting `Config` into Task B; Task B's legacy `main.ts` wrapper explicitly uses Task A's loader after A is integrated, while B can initially consume existing `loadConfig` in that wrapper.

Task B exports from `src/serve.ts`:

```ts
interface ServerHandle {
  url: string;
  stop(): Promise<void>;
}
function startServer(config: Config, options?: {
  signal?: AbortSignal;
  provider?: WorkerProvider;
  agent?: CodingAgent;
}): Promise<ServerHandle>;
```

Existing `WorkerProvider` and `CodingAgent` types allow deterministic lifecycle tests. This module never calls `process.exit` or installs global signal handlers at import. `src/serve-command.ts` exports `runServe(config: Config): Promise<number>`, which owns signal registration, command logging, graceful stop, and exit policy. Startup abort and repeated stop semantics are part of this contract, not left to CLI integration.

Task C exports `VERSION` from `src/version.ts`, using package version for source execution and a compile-time override for releases. Task D builds `src/cli.ts`, the final unified entrypoint.

## Task 1: Global configuration and diagnostics

**Produces:** Package A, independently tested settings APIs and configuration documentation. It does not switch CLI or server entrypoints yet.

- [ ] Write failing tests in `tests/settings.test.ts` for XDG defaults/relative overrides; identical resolution across two CWDs; selected `--config`; missing explicit files versus missing optional default; invalid TOML/version/unknown keys; precedence; empty environment values; client-only settings; redaction; existing public-host validation; private file creation; and path anchoring.
- [ ] Run `bun test tests/settings.test.ts` and confirm failures describe absent new behavior.
- [ ] Implement path discovery and strict `schema_version = 1` TOML mapping. Accept the spec's `[client]`, `[server]`, `[git]` shape plus documented nested sections mapping current supported infrastructure settings. Unknown TOML keys fail; unrelated environment keys are ignored.
- [ ] Implement precedence: defaults → selected TOML → its optional `env_file` → explicit environment files in order → process environment → flags. `--config` replaces discovery. `SWARMFORGE_CONFIG` selects a config only when no explicit path is supplied. Real credentials can remain in selected protected env files initially.
- [ ] Resolve TOML paths against the file directory and explicit CLI paths against CWD. Explicit legacy relative `SWARMFORGE_DB_PATH` resolves against invocation CWD, becomes absolute, and is documented; changing to global defaults never rewrites that override. No ambient files or upward project search.
- [ ] Parse environment-file data without shell execution; document supported quoting and interpolation behavior. Redaction uses known resolved credentials as well as key classification so unusual names cannot leak secrets through diagnostics/errors. Keep provenance non-secret.
- [ ] Add fixture assertions such as `expect(serverA.value.SWARMFORGE_DB_PATH).toBe(serverB.value.SWARMFORGE_DB_PATH)` under different CWDs, and `expect(resolveClientSettings(...)).resolves.toMatchObject({ value: { url: endpoint } })` without infrastructure keys. Assert diagnostics leave the filesystem unchanged.
- [ ] Run `bun test tests/settings.test.ts tests/core.test.ts` and `bun run check`; document actual results. Commit only owned files and obtain independent review of the exact branch/head.

## Task 2: Import-safe server lifecycle

**Produces:** Package B, an explicit server API and foreground command runner. Can proceed alongside Task 1 using the existing `Config` type.

- [ ] Write failing tests in `tests/serve.test.ts` and child-process signal fixtures under `tests/fixtures/` for import safety, API/metrics bind failure rollback, DB-owner mismatch rollback, startup abort, repeated signals/stop calls, normal stop, and bounded shutdown with an in-flight write.
- [ ] Run `bun test tests/serve.test.ts` and confirm each new failure is meaningful.
- [ ] Extract startup from `src/main.ts` into `startServer`; acquire resources explicitly with reverse cleanup. Reserve required listeners before permitting periodic provisioning; return not-ready/reject mutations until recovery succeeds. Register command signal handling before entering startup.
- [ ] Implement one shared stop promise and startup abort path. Stop admission first, then drain coordination; do not close the store while outstanding operations may write. If an operation cannot drain by the command deadline, terminate with durable state retained and a documented nonzero exit, rather than continuing against closed SQLite.
- [ ] Add one environment-configured command timeout, `SWARMFORGE_SHUTDOWN_TIMEOUT_MS`, parsed by the command runner (default `60000`, positive integer). Keep provider API timeouts bounded. Recommend supervisor `TimeoutStopSec` longer than this value and report unresolved drain on expiry. Avoid expanding the internal `Config` schema merely for command control.
- [ ] Make `src/main.ts` a thin import-guarded foreground wrapper. During B's independent work it may use existing `loadConfig`; after reviewed A is integrated, the lead/CLI owner replaces that wrapper's resolution with `resolveServerSettings`. This is an explicit one-file dependent delta requiring review, not concurrent ownership.
- [ ] Assert `await import('../src/serve')` takes no lock/listener; API is no longer bound after metrics startup fails; a second start can acquire the released DB; and a blocked operation's test write cannot race `store.close()`.
- [ ] Run `bun test tests/serve.test.ts tests/process-lock.test.ts tests/restart.test.ts tests/http.test.ts` and `bun run check`. Commit only owned files; independent review must examine cleanup and cancellation semantics, not merely the happy path.

## Task 3: Unified command interface

**Produces:** Package C, working source CLI with global settings and foreground serve. Base it on the integrated, approved A+B commits.

- [ ] Write failing tests in `tests/commands.test.ts` for help/version without credentials, client-only status configuration, `serve --check-config`, global config inspection/path/validation, preserved status flags, unknown commands/options, missing flag values, and legacy env-file input.
- [ ] Run `bun test tests/commands.test.ts` to demonstrate missing commands and configuration behavior.
- [ ] Introduce a command parser preserving `status --url --json --no-interactive`, plus `serve [--config PATH] [--env-file PATH] [--check-config]`, `config path|show|validate`, global `--help`, and `--version`. Help/version return before configuration reads and server imports.
- [ ] Wire `status` to the client loader and `serve` to server settings followed by lazy import of `runServe`. `serve --check-config` and `config validate` use server validation and exit before database/provider initialization; `config show` is a redacted client/general inspection path that can explain incomplete server configuration.
- [ ] Own the dependent update to `src/main.ts` only after B has settled: use `resolveServerSettings` and `runServe`. Freeze B's ownership of that file first and include the exact delta in C's review scope.
- [ ] Add version metadata in `src/version.ts`. Keep existing SDK/client version identifiers coherent where surfaced, without unrelated protocol refactors.
- [ ] Verify the CLI from two unrelated directories with contradictory local `.env` files under a source launcher with Bun autoload disabled. Explicit `--env-file` still works and preserves the selected legacy DB path. A fake MCP server supports real status calls; no real cloud credentials or VMs are needed.
- [ ] Run `bun test tests/commands.test.ts tests/cli.test.ts tests/overview.test.ts` and `bun run check`. Commit the exact owned files and obtain independent review before packaging starts.

## Task 4: Build, package, and installation

**Produces:** Package D, repeatable Linux x64 artifact production, manual install instructions, and a release-draft workflow. Base it on approved C and its prerequisites.

- [ ] Write a packaged-executable test in `tests/packaging.test.ts`: build into a temporary directory, invoke help/version/config inspection with no Bun/node_modules on PATH, confirm ambient `.env`/`bunfig.toml` are ignored, and compare version metadata. Compile once per test run; do not repeatedly rebuild for every assertion.
- [ ] Add packaged lock/SQLite/restart coverage with test doubles via an isolated harness built using the same flags as production. Use existing process-lock and restart fixtures as behavior references; never add a production bypass flag for provider credentials.
- [ ] Implement `scripts/build.ts` using Bun compile with `autoloadDotenv: false`, `autoloadBunfig: false`, `autoloadTsconfig: false`, and `autoloadPackageJson: false`. Embed version/commit through explicit compile-time metadata. Start with Linux x64 glibc only; do not enable unmeasured bytecode optimizations.
- [ ] Implement `scripts/package.ts` producing a versioned archive and SHA-256 manifest. Verify archive extraction, executable mode, and checksum integrity. Add build/package scripts and pin the documented Bun floor/build toolchain to 1.4.2 after a clean frozen install succeeds.
- [ ] Update source `start`, `dev`, and `status` scripts to disable Bun's automatic dotenv loading. Document the explicit legacy alternative (`--env-file .env`) and retain `src/main.ts` as the server wrapper. Add generated `dist/` to `.gitignore`.
- [ ] Add `.github/workflows/release.yml` with tests/static checks, the pinned toolchain, Linux artifact checks, and version/tag consistency. Manual runs upload artifacts; version-tag runs create a draft release. No implementation worker pushes tags or publishes releases. Coordinate the workflow before any authorized tag is pushed.
- [ ] Update README with manual download/checksum/install instructions for `~/.local/bin`, PATH setup, global configuration, serve/status examples, explicit legacy DB guidance, and external systemd supervision. Document `Type=exec` versus readiness and a supervisor stop timeout greater than 60 seconds. No service install command is added.
- [ ] Run a clean frozen install in an isolated checkout, `bun test`, `bun run check`, build/package, archive checksum checks, and installed-command probes from another CWD. Independent review checks actual release assets/workflow behavior as well as code.

## Swarmforge execution and integration

1. Lead checks current branch/remote and records the source baseline at execution time; preserve existing uncommitted docs in the user's checkout. Read both this plan and the research recommendation before dispatch.
2. Create one team for the implementation, distinct task IDs, separate assigned branches, and explicit file ownership. Spawn A and B concurrently with stable request IDs and bounded task deadlines.
3. Review each exact author SHA using read-only reviewer workers. A and B reviews can proceed concurrently; add complementary reviewers only for distinct risks. Fetch the branch, verify each reviewer checked the intended base/head, and reject integration on demonstrated substantive findings. Send fixes only to the assigned author and re-review corrected commits.
4. Integrate approved A+B into an isolated checkout and run their combined checks. Resolve ownership of B's wrapper before starting C. Spawn C from that exact approved integrated SHA, then review it.
5. Spawn D from approved C, then review it. Keep packaging assertions and workflow changes attached to that work package.
6. Lead runs the full integrated suite/static checks plus compiled artifact gates. In parallel, a separate read-only verification worker exercises installed-command, foreign-CWD, lock/restart, and shutdown acceptance cases against that exact candidate; an independent final reviewer inspects the integrated head and any substantive conflict resolution. These are different assignments: verification supplies execution evidence, review assesses the change. Route findings to their owners and recheck changed behavior. Merge/publication follows the user's existing authority; this plan alone does not authorize publishing releases.
7. Collect reports/artifacts, verify Git durability, and destroy workers when their assignments and pending review are complete. Use event waits of at most 25 seconds, carry cursors, match run IDs, and verify final scoped cleanup.

Require every author report to name the exact commands/results, branch/base/head, dirty state, persistence, warnings, and remaining work. A worker saying it is finished is not acceptance evidence.

## Acceptance of the milestone

- [ ] `swarmforge --help`, `--version`, and client status run without server credentials from any directory.
- [ ] Global configuration inspection is redacted, source-aware, and creates no runtime resources.
- [ ] `swarmforge serve` starts with explicit global settings; foreground signals and startup failures behave predictably.
- [ ] Legacy deployments retain their selected database/instance and use an explicit env-file invocation.
- [ ] Packaged Linux x64 execution needs no separate Bun installation and retains SQLite/lock/restart correctness.
- [ ] Build archives and checksum manifests are verified; release publication remains a separate step.
- [ ] All integrated tests/static checks and exact-head independent reviews pass, and all workers are accounted for.

## Plan self-review

The five review-focus conditions are covered in their owning tasks. Core `Config` and provider interfaces remain stable for the first parallel wave. The only planned ownership transfer is `src/main.ts` from B to C after B settles. Packaging owns package metadata, release workflow, and README; earlier owners write dedicated docs to prevent overlap. Tasks each produce an independently reviewable deliverable, and the final packaged-runtime gates distinguish compilation from actual runtime support.
