# Public README and onboarding audit

Audit date: **2026-10-08**. Repository: [GavinGeizer/swarmforge-oss](https://github.com/GavinGeizer/swarmforge-oss). Website: [getswarmforge.tech](https://getswarmforge.tech).

The audit uses the checked-out implementation, the public `master` branch, the published v0.1.2 release, and the live website/installer. It does not treat planned architecture or marketing metadata as shipped support.

## Changes

| Finding | Change |
| --- | --- |
| The introduction named operations but did not foreground distributed coding-agent execution. | Lead with a self-hosted coordinator and isolated remote workers; explain compute isolation, durable task state, artifact preservation, and verified Git handoff. |
| The README's shortest installation path required Bun despite an available standalone release. | Add a pinned v0.1.2 release quickstart with explicit installation, PATH, initialization, dedicated configuration selection, and server/client steps. Preserve source and manual archive installation. |
| Lead clients, worker harnesses, model APIs, and compute providers could be confused. | Add a support matrix grounded in `src/serve.ts`, `src/providers/`, `src/domain.ts`, and package pins. Distinguish extension interfaces from delivered adapters and hosted plans. |
| Snapshot and network requirements were easy to overlook. | Add [WORKER-SNAPSHOT.md](WORKER-SNAPSHOT.md), including systemd, guest toolchain, filesystem, model reachability, and Git access checks. |
| New contributors had no distinct path that avoided real deployment setup. | Add [CONTRIBUTING.md](../CONTRIBUTING.md) with frozen dependencies, credential-free tests, compiled build checks, explicit development configuration, and a code map. |
| Common install failures had little diagnostic guidance. | Expand troubleshooting for toolchain/platform/root/PATH/download/checksum/configuration/storage/lock/MCP/guest/model failures. |
| Architecture was linked but not visible in the main README. | Add a Mermaid diagram and assignment, follow-up, review, preservation, and cleanup workflow. |
| Licensing appeared before the product/setup flow and included obsolete draft history. | Keep an early source-available disclosure and a full license section with the actual business thresholds, inflation basis, company scope, and distribution obligations. Existing licensing notes retain historical context. |

The README naturally includes technical terms such as distributed coding agents, MCP, OpenCode, remote VMs, SQLite, tool calling, Git handoff, and artifact preservation. No performance or adoption claims were added. Existing dashboard, recovery, artifact, configuration, service, and cleanup instructions remain available.

## Verification

Verification host: **Linux x86_64, glibc 2.35, Bun 1.4.2**. The application checkout started at `474544d`; the separately cloned public `master` was `9f2953e73a5ebc2c0af20bb6e166c5980fb0a089`. Those revisions differ because the local branch includes development cloud-linking work.

| Check | Evidence / scope |
| --- | --- |
| Live installer | Downloaded `https://getswarmforge.tech/install`, inspected it, and passed `bash -n`. Installed the published release with `bash install-swarmforge.sh --version 0.1.2 --install-only --no-modify-path`, using `SWARMFORGE_INSTALL_DIR` pointing at a temporary directory. Archive and executable SHA-256 verification passed; no existing installation or shell profile was changed. |
| Installed release without Bun | Invoked the installed binary with `PATH=/usr/bin:/bin`; `--version` returned `0.1.2` and `--help` exposed the documented commands. |
| Fresh public source | Cloned the public default branch into a temporary directory; `bun install --frozen-lockfile` and `bun run build` passed with Bun 1.4.2. The executable reported the public source commit. |
| Initialization and configuration | Used real pseudo-terminals to answer all six `init` prompts in disposable directories with fixture credentials and isolated XDG configuration paths. Both released and freshly built executables wrote `.env` and registered config files with `0600` permissions. Explicit `init --config` and subsequent config selection passed too. |
| Local readiness | Both executables passed `doctor --env-file .env --json` and `serve --env-file .env --check-config`. Remote snapshot/model checks remained warnings, as documented. |
| Server and MCP connection | Started each executable with a local HTTP stub returning an empty Freestyle VM inventory. `/health`, `status --env-file .env --json`, and MCP `tools/list` passed, including discovery of `spawn_worker`, `get_worker_result`, and `destroy_worker`. Ctrl+C shutdown exited cleanly. No worker or model was invoked. |
| Final quickstart configuration selection | Both executables passed `doctor`, `config show`, `serve`, and `status --json` with `--config ./config.toml`, including when an unrelated registered global configuration pointed at a missing environment file. The global configuration was preserved. |
| Contributor source commands | The checkout's `bun run doctor`, `bun run serve`, and `bun run status -- --config /absolute/path/config.toml` passed using disposable configuration and the local provider stub. Source `serve` shut down cleanly. |
| Onboarding coverage | Both before edits and after the final quickstart corrections, 66 tests across onboarding, packaging, CLI, and commands passed (0 failures, 493 assertions). Existing packaging tests execute the README's manual archive install block and reject bad checksums. |
| Final regression suite | `bun --no-env-file --config=/dev/null test`: **610 pass, 2 skip, 0 fail**, 3,771 assertions across 45 files. Skips are the optional real-provider smoke flow and an absence-only lifecycle placeholder; the integrated finalization regression ran. |
| Static checks | `bun run check` passed TypeScript and Biome checks. |
| Documentation checks | All 84 local Markdown file links/anchors and 24 shell/JSON blocks passed validation. All 10 distinct external Markdown link targets returned HTTP 200 at audit time. |

Ordinary runtime tests use injected providers/agents and local fixtures. The installation checks above establish the download/build/configuration/startup path, **not a full task on real Freestyle/model infrastructure**. No real VM was provisioned, no live inference probe was run, and no remote Git push or OAuth authorization was attempted during this audit. The snapshot checklist and first-task instructions identify the remaining deployment checks.

The license summary was checked against repository [LICENSE](../LICENSE), package metadata, and the [official PolyForm Small Business 1.0.0 text](https://polyformproject.org/licenses/small-business/1.0.0). The live website's setup/architecture/workflow links and published [v0.1.2 assets](https://github.com/GavinGeizer/swarmforge-oss/releases/tag/v0.1.2) were inspected. No GIF/video asset was found in tracked application files, release assets, the website repository, or the live homepage. The homepage labels its illustrated task view as illustrative; it was not represented as a recorded demo.

## Public launch follow-ups

1. **Integrate the documentation into public `master`.** This work is committed locally on the existing development branch. Publishing or merging is a separate authorized action; the public README will not change until then.
2. **Correct GitHub's About description.** At audit time it says “Harness-agnostic execution across local and remote workers.” The shipped default supports OpenCode/Freestyle; local worker compute and other harness adapters are absent. Suggested replacement: “Self-hosted MCP orchestration for parallel AI coding agents. Run OpenCode workers in isolated Freestyle VMs with durable task state, verified Git handoffs, and preserved artifacts.” No remote metadata was edited.
3. **Exercise a first task with fresh user infrastructure.** Prepare a snapshot, validate model tool calls and VM networking, run the documented read-only task, inspect its result and preserved outputs, and safely clean up the VM. Record the actual versions and settings needed. A reproducible snapshot recipe or maintained image would reduce the largest remaining setup burden; the repository currently requires an externally prepared snapshot.
4. **Keep the website and release setup instructions synchronized.** The website already links the released installer, but new onboarding guidance and the snapshot checklist should be linked when these docs become public. Maintain the pinned quickstart version when releasing a replacement.
5. **Add a recorded demo when one is available.** A real spawn → progress → result/artifact → cleanup recording would help visitors assess the workflow. No synthetic or placeholder demo was added.

For discoverability, the existing repository topics already cover agent orchestration, AI/coding agents, distributed systems/computing, multi-agent, and self-hosted tooling. Consider adding accurate `mcp`, `opencode`, `bun`, `typescript`, and `sqlite` topics alongside the corrected description. These are recommendations, not remote changes made by this audit.

This is readiness for the **self-hosted OpenCode/Freestyle product**. A hosted execution or multi-tenant service launch has separate unimplemented boundaries described in the [architecture work](architecture/phase-1-summary.md) and [Cloud account API](../apps/cloud/README.md).
