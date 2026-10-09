# Preparing a worker snapshot

The CLI installer installs the **coordinator**. It does not create a Freestyle snapshot or install the coding tools inside workers. Each `spawn_worker` starts a Freestyle VM from the snapshot identified by `FREESTYLE_SNAPSHOT_ID`.

Prepare the snapshot through your Freestyle environment before running a task. The checks below match [`FreestyleProvider.prepare`](../src/providers/freestyle.ts) and the [live readiness probe](../src/cli/live-doctor.ts); they are not a snapshot provisioning script.

## Guest requirements

| Requirement | Why it is needed |
| --- | --- |
| OpenCode compatible with SDK **1.18.31** | SwarmForge uses the v2 session/status/prompt APIs. This is the pinned and tested integration; another server version needs compatibility testing. |
| Python 3 | The embedded artifact helper captures files without involving the model. |
| Git and repository credentials when needed | The worker clones the source tree and optionally pushes a verified branch. |
| Bash at `/bin/bash` | The coordinator writes a Bash launcher for OpenCode. |
| Running systemd and journald | OpenCode runs as `swarmforge-opencode.service`; logs come from journald. Merely having `systemctl` installed is insufficient. |
| Writable `/workspace` (or `SWARMFORGE_WORKSPACE`) | Task workspaces and `.swarmforge` metadata/output live here. |
| Root execution through the provider | Preparation writes `/opt/swarmforge` and `/etc/systemd/system`, installs the launcher, and manages the service. |
| Task-specific toolchain | Install the compiler/runtime/package manager and other tools that your repository actually needs. The coordinator does not install them. |

Run these checks **inside a prepared guest**, with the same root execution context used by the provider, before saving its snapshot:

```sh
opencode --version
python3 --version
git --version
command -v opencode python3 git systemctl
test -x /bin/bash
test -d /run/systemd/system
test -d /workspace && test -w /workspace
```

Use your configured workspace path instead of `/workspace` if it differs. Tools must be available to a noninteractive systemd service; a command available only through an interactive shell alias or profile will not work. Keep the source-clone destination `/workspace/repo` absent or an appropriate existing Git checkout: preparation refuses an existing non-Git directory there.

## Network and credentials

The coordinator needs Freestyle API access and access to the provider's worker TLS route. Workers need to reach your configured model API, Git host, and any dependency registries required by their tasks. A `127.0.0.1` model URL inside a VM points at that VM; use a VM-reachable endpoint or deliberately prepare a model service inside the guest. Private networks and mounts must already be available through your infrastructure.

Use a worker-scoped model key. SwarmForge supplies the model key and a unique OpenCode server password to the worker. Provider-management and coordinator MCP tokens are not passed as worker model configuration. Optional Git handoff credentials are supplied for repository operations; [GitHub OAuth uses broad `repo` scope](GITHUB-OAUTH.md), while GitHub App permissions can be narrower. Do not bake unrelated account credentials or coordinator configuration into the snapshot.

For a public repository, a reachable HTTPS clone URL can work without Git authorization. For private repositories and verified push, configure [GitHub OAuth](GITHUB-OAUTH.md), a GitHub App, or SSH as described in [ENVIRONMENT.md](ENVIRONMENT.md). A local Git path means a path **inside the worker VM**, not on your coordinator laptop. Use `none:/prepared/path` only when that tree is already available in the guest; it does not mount or copy a coordinator directory.

## Validate the deployment

After setting `FREESTYLE_SNAPSHOT_ID`, run on the coordinator:

```sh
swarmforge doctor --env-file /absolute/path/to/.env
swarmforge doctor --env-file /absolute/path/to/.env --live
```

The first command is local. The second checks snapshot metadata access and makes a small model tool-call request, which may incur inference charges. Neither creates a VM or proves a full remote task works. With an **existing running VM based on that snapshot**, you can also inspect guest prerequisites:

```sh
swarmforge doctor --env-file /absolute/path/to/.env --live --vm YOUR_VM_ID
```

Then follow the [first-task workflow](../README.md#run-a-first-task-and-collect-the-result) to verify boot, clone, OpenCode execution, structured result collection, preservation, and safe cleanup together. Inspect the worker error and `get_worker_logs` if it fails. VMs are billable and retained by default until cleanup; do not create repeated replacement workers without inspecting the failed one.
