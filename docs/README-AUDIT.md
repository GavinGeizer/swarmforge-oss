# Public README and onboarding verification

The README, contributor guide, and worker snapshot checklist were adapted from documentation commit `fec66971536cb117b36c85faabd98883d6491cb2`. Integration starts at public master `9f2953e73a5ebc2c0af20bb6e166c5980fb0a089`; development-only cloud code, internal worker reviews, and cloud documentation were excluded.

## Changes

- Explain self-hosted coordination, isolated remote OpenCode/Freestyle workers, durable state, artifact preservation, and verified Git branch handoff in the opening flow.
- Separate lead-client compatibility from worker harness/model/provider support. Document the actual Linux x64/glibc target and OpenAI-compatible tool-calling endpoint requirement.
- Provide explicit installation, initialization, configuration selection, MCP connection, first-task, and cleanup steps.
- Add a credential-free [contributor workflow](../CONTRIBUTING.md) and [guest snapshot checks](WORKER-SNAPSHOT.md).
- Preserve existing operational guidance and correct stale retention, tool-count, and artifact-path descriptions.
- State the existing PolyForm Small Business license accurately, including commercial eligibility. [LICENSE](../LICENSE) is unchanged.

## Verification

The initial documentation audit verified the published v0.1.2 installer and a fresh public-master source build on Linux x64 with glibc 2.35 and Bun 1.4.2. Both passed real terminal initialization, private configuration permissions, local readiness, server startup, status, MCP tool discovery, and clean shutdown using a local Freestyle inventory fixture. A dedicated `--config` selection also passed with an unrelated broken global configuration present. The 66 focused onboarding/packaging/CLI tests passed. These checks created no real worker VMs and made no inference requests.

Each new release repeats checks against its own source and generated artifacts and records the scope in its release notes. Tests exercise runtime behavior with injected providers/agents and disposable local fixtures; they do not certify your particular Freestyle snapshot, inference endpoint, or repository credentials.

The application and website repositories, release assets, and homepage contained no recorded GIF/video demo at the time of the audit, so none was added. The website's illustrative task view is not a recording.

Real remote task execution, guest network reachability, live model tool calls, Git authorization/push, and safe VM cleanup must still be checked for each deployment. Use the [snapshot checklist](WORKER-SNAPSHOT.md) and [first-task workflow](../README.md#run-a-first-task-and-collect-the-result).
