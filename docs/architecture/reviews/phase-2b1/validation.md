# Phase 2B.1 validation evidence

Executable implementation: `e4c6b94c33a00b3da7d29f8fad175ed1101ae2cd`. CI subsequently installs root CLI dependencies in the cloud job, since the real CLI integration test launches the root entry point. Documentation commits do not change executable behavior. Local toolchain: Bun **1.4.2**, Node **v24.19.0**. No remote resources or deployments were used.

| Check | Result |
| --- | --- |
| Baseline root `bun test`, `e158702` | 589 pass, 2 skip, 0 fail; 3,685 assertions / 43 files; 86.96 seconds |
| Baseline cloud `bun run test` | 25 pass, 0 fail |
| Final root `bun --no-env-file --config=/dev/null test` | 610 pass, 2 skip, 0 fail; 3,771 assertions / 45 files; 104.56 seconds |
| Final cloud `cd apps/cloud && bun run test` | 52 pass, 0 fail; 14.60 seconds |
| Root `bun run check` | TypeScript and Biome pass; 116 files checked |
| Cloud `bun run check` | TypeScript and Biome pass; 32 files checked |
| Root `bun run build`, `bun run package`, `bun run package:verify` | Linux x64 executable and archive verified; embedded source commit `e4c6b94` |
| Cloud `bun run types`, `bun run build` | Binding generation and local cf build pass |
| Local `bun run migrate:local`, repeated | Additive migration applied; repeated run reports `[]` |
| Isolated D1 tests | Both migrations applied by every fixture; SQL constraints, concurrency and atomic rollback exercised under workerd |
| Local `GET /ready` | 200, `{ "status": "ready" }` |
| Existing diagnostics/listeners | Observed metrics 9090, local API 8788 and local inspector 9229 bound to 127.0.0.1; no new public metrics route |
| `git diff e158702..27846bc --check` | Implementation diff passes; original reviewer Markdown hard breaks are retained unchanged |
| Fresh detached checkout at `27846bc`: both frozen installs, cloud check/test/types/build | Pass; 52 tests / 0 failed, 16.15 seconds; confirms cloud CI has the root CLI dependencies |
| GitHub Actions on implementation/CI commit `27846bc` | [Root CI](https://github.com/GavinGeizer/swarmforge-oss/actions/runs/37824059018) and [cloud CI](https://github.com/GavinGeizer/swarmforge-oss/actions/runs/37824058965) completed successfully; verified after final review |

The root skips are the opt-in live Freestyle/OpenCode/model smoke test (`SWARMFORGE_RUN_SMOKE` unset) and the alternate fallback finalization test skipped when the real lifecycle package exists. The actual lifecycle regression runs. No live VM/model exercise, live Phase 2B.1 browser pairing, remote preview sign-in, edge CPU/load result or production deployment is claimed.

The cloud build prints a nonfatal Docker socket permission probe before reporting build completion and exit zero. This Workers metadata API requires no container runtime.

## Regression diagnosis

At `d284bf3`, the complete root suite failed with 607 pass / 2 skip / 1 fail. The dashboard test passed alone but failed reproducibly alongside GitHub authentication tests: credential discovery adds SQLite redaction metadata after the dashboard captured its revision. This was a deterministic ordering defect, not a flaky test. `b93e64f` synchronizes the existing redactor first and adds an explicit private-credential/dashboard regression. The combined tests then passed 14 / 0; the complete suite passed 609 / 0. `e4c6b94` adds an actual MCP diagnostic test for previously unknown machine-token redaction; the complete suite passes 610 / 0.

## Evidence boundaries

Cloud tests use the bundled default Worker, local D1/workerd, and simulated GitHub provider replies. The CLI integration launches the actual Bun CLI against a loopback bridge to the Worker, with real private file persistence and revocation. Root HTTP fixtures exercise the production CLI/client/storage, but do not independently prove server cryptography or tenant authority. Those properties require the D1/workerd adversarial suites and source review.

The cloud runner is **Node**, selected by `bun run test`; invoking these fixtures directly under `bun test` produces invalid mock-fetch/outbound errors. Some early worker reports used that incorrect runner or the VM snapshot's old Bun 1.3.14. Those failed attempts do not supersede validation on the pinned toolchain. Review reports retain their original claims and limitations; the review index records corrections.

Full local execution logs were retained during implementation under `/tmp/phase2b1-*.log`, including `root-release-validation`, `cloud-integrated-final`, `root-check-redaction`, `cloud-check-final`, `package-release-validation` and `cloud-build-complete`. This checked-in record captures the relevant results without publishing verbose diagnostics.

Reproducible setup, CLI commands, local maintenance, private secrets and preview gates are in [identity operations](../../../cloud/IDENTITY.md). Cloudflare deployment commands use the project's `cf` configuration and wrappers; no production mode exists in this configuration.
