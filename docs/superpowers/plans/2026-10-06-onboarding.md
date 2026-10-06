# Init and global installation implementation plan

**Goal:** A fresh download can build and install the global command, run an interactive `init`, and start using SwarmForge from the README.

**Architecture:** Keep the recovered global CLI and its explicit settings loader. `init` creates a private `.env` in the invocation directory and a global config pointing to it when that config is absent. Checkout scripts compile and atomically install the binary into `~/.local/bin`; runtime init works without a checkout or Bun installation.

**Execution:** Implement directly in this session, as authorized by the user. Preserve existing `.env`, databases, global config, and unrelated local work. Do not call the Swarmforge endpoint or create VMs.

- [x] Update the checkout to the installed binary's source revision, preserving local work.
- [x] Add `init` prompts for all six required fields, hidden secret input, schema validation, exclusive private file creation, and explicit next commands.
- [x] Keep `doctor` available with the same config/env-file selection as `serve`.
- [x] Add build/install/setup scripts with an atomic executable replacement and shell-specific PATH/reload guidance.
- [x] Rewrite README around prerequisites, download/setup, init, doctor, serve, client connection, first task, and cleanup. Correct environment documentation for explicit file loading.
- [x] Verify configuration round trips (including secret punctuation), existing-file preservation, global resolution from another directory, CLI command isolation, installation, and build/type/lint checks.
- [x] Back up and replace the actual installed binary after local checks pass; verify its command help and offline diagnostics.
