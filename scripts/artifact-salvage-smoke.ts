#!/usr/bin/env bun
// End-to-end artifact salvage smoke.
//
// Local mode (default) drives the capture contract end to end: a worker writes findings.json
// into a real filesystem, its OpenCode service dies for the rest of the turn, the coordinator
// collects the declared paths through the capture transport into private storage, the bytes are
// verified over the authenticated download before the worker is destroyed normally, the
// workspace is then gone, and the same bytes and checksum are read back from storage.
//
// The capture path itself is the package 1 local transport fixture
// (tests/local-artifact-provider.ts). Every run prints which implementation it used, so a local
// filesystem run is never reported as a VM run or as a production-helper run: the guest helper's
// descriptor-relative O_NOFOLLOW capture is proven by package 1's own tests and by the
// --freestyle mode below, which targets a retained VM through the real provider.
//
//   bun scripts/artifact-salvage-smoke.ts
//   bun scripts/artifact-salvage-smoke.ts --keep
//   bun scripts/artifact-salvage-smoke.ts --freestyle <vm-id> [--worker <id>] [--path <p>]
//   bun scripts/artifact-salvage-smoke.ts --freestyle <vm-id> --snapshot
//
// Freestyle mode targets one retained VM through the real Freestyle provider and the real
// environment configuration. It never needs a worker model, never destroys the VM and never
// writes to the live database: it works on a private copy of it.
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config";
import { Coordinator } from "../src/coordinator";
import type {
  AgentSnapshot,
  CodingAgent,
  Dispatch,
  VmInfo,
  Worker,
  WorkerProvider,
} from "../src/domain";
import { createHttpHandler } from "../src/http";
import { createMcpServer } from "../src/mcp";
import { FreestyleProvider } from "../src/providers/freestyle";
import { Redactor } from "../src/security";
import { Store } from "../src/store";
import {
  LocalWorkerProvider,
  localWorkspace,
} from "../tests/local-artifact-provider";

// The worker's OpenCode service is gone: the session exists, the turn was submitted and
// every later poll fails. Preservation must still work, because capture never depends on
// the model, on the worker or on its cooperation.
class DeadOpenCode implements CodingAgent {
  polls = 0;
  async ensureSession(w: Worker) {
    return `ses-${w.worker_id}`;
  }
  async submit(_w: Worker, _d: Dispatch) {}
  async inspect(_w: Worker): Promise<AgentSnapshot> {
    this.polls++;
    throw new Error("OpenCode service is unavailable");
  }
  async abort() {}
}

interface Options {
  freestyle?: string;
  worker?: string;
  paths: string[];
  snapshot: boolean;
  keep: boolean;
}
function options(argv: string[]): Options {
  const out: Options = { paths: [], snapshot: false, keep: false };
  const value = (index: number, flag: string) => {
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--"))
      throw new SmokeFailure(`${flag} requires a value`);
    return next;
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    if (flag === "--freestyle") out.freestyle = value(index++, flag);
    else if (flag === "--worker") out.worker = value(index++, flag);
    else if (flag === "--path") out.paths.push(value(index++, flag));
    else if (flag === "--snapshot") out.snapshot = true;
    else if (flag === "--keep") out.keep = true;
    else if (flag === "--help" || flag === "-h") usage();
    else throw new SmokeFailure(`unknown argument: ${flag}`);
  }
  return out;
}
function usage() {
  console.log(
    [
      "usage: bun scripts/artifact-salvage-smoke.ts [--keep]",
      "       bun scripts/artifact-salvage-smoke.ts --freestyle <vm-id> [--worker <id>] [--path <relative-path>]... [--snapshot]",
      "",
      "Local mode proves salvage with a broken OpenCode service and a destroyed workspace.",
      "Freestyle mode salvages one retained VM without a worker model and never destroys it.",
    ].join("\n"),
  );
  process.exit(0);
}
const digest = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
class SmokeFailure extends Error {}
// Known secrets for the run, so every reported message is scrubbed before it is printed.
const known: string[] = [];
function report(error: unknown) {
  return safeMessage(error, ...known);
}
type ArtifactRecord = Awaited<ReturnType<Coordinator["artifacts"]["preserve"]>>;
function note(event: string, detail: Record<string, unknown> = {}) {
  const scrubbed = Object.fromEntries(
    Object.entries(detail).map(([k, v]) => [
      k,
      typeof v === "string" ? report(v) : v,
    ]),
  );
  console.log(JSON.stringify({ event, ...scrubbed }));
}
// Thrown rather than exiting so temporary guest databases and workspaces are still removed.
function fail(message: string): never {
  throw new SmokeFailure(message);
}
// A smoke report never carries credentials or unbounded provider output. The same Redactor the
// MCP surface uses scrubs the configured secrets, so a bare token inside a provider message
// cannot be echoed here; credential-shaped query parameters are removed as well.
export function safeMessage(error: unknown, ...secrets: string[]) {
  const text = error instanceof Error ? error.message : String(error);
  return new Redactor((): string[] => secrets)
    .text(text)
    .replace(
      /((?:token|api[_-]?key|password|secret)=)[^\s&"']+/gi,
      "$1[REDACTED]",
    )
    .slice(0, 500);
}

// Reads a preserved artifact back over the authenticated HTTP download, the same route a
// lead uses, and returns the bytes plus the verified checksum.
async function downloadVerified(
  c: Coordinator,
  record: ArtifactRecord,
): Promise<{ bytes: Uint8Array; sha256: string }> {
  const token = c.config.SWARMFORGE_API_TOKEN;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createHttpHandler(c),
  });
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.port}/artifacts/${record.artifact_id}/download`,
      token ? { headers: { authorization: `Bearer ${token}` } } : {},
    );
    if (!response.ok) throw new Error(`download returned ${response.status}`);
    if ((response.headers.get("x-content-type-options") ?? "") !== "nosniff")
      throw new Error("download response is not marked nosniff");
    const bytes = new Uint8Array(await response.arrayBuffer());
    const sha256 = digest(bytes);
    if (bytes.length !== record.size)
      throw new Error("downloaded length does not match the preserved record");
    if (!record.sha256 || sha256 !== record.sha256)
      throw new Error(
        "downloaded checksum does not match the preserved record",
      );
    return { bytes, sha256 };
  } finally {
    await server.stop(true);
  }
}

async function localSmoke(opts: Options) {
  const root = mkdtempSync(join(tmpdir(), "swarmforge-salvage-smoke-"));
  const state = join(root, "state");
  mkdirSync(state, { recursive: true });
  const dbPath = join(state, "swarmforge.sqlite");
  // The real package 1 fixture: a temporary guest whose captures run the production Python
  // helper as a subprocess, over the real raw byte streaming transport.
  const guest = await localWorkspace();
  // Placeholder infrastructure values only: nothing here contacts a real service.
  const config = loadConfig({
    FREESTYLE_API_TOKEN: "local-fixture-not-a-credential",
    FREESTYLE_SNAPSHOT_ID: "local-fixture",
    SWARMFORGE_MODEL_BASE_URL: "https://model.invalid/v1",
    SWARMFORGE_MODEL_API_KEY: "local-fixture-not-a-credential",
    SWARMFORGE_MODEL_NAME: "local-fixture",
    SWARMFORGE_GIT_TREE: "none:local-fixture",
    SWARMFORGE_DB_PATH: dbPath,
    SWARMFORGE_WORKSPACE: guest.root,
    SWARMFORGE_POLL_INTERVAL_MS: "10",
    SWARMFORGE_TOKEN_IDLE_TIMEOUT_SECONDS: "1",
    SWARMFORGE_API_TOKEN: "salvage-smoke-token-with-enough-characters",
    SWARMFORGE_METRICS_ENABLED: "false",
  });
  known.push(
    config.FREESTYLE_API_TOKEN,
    config.SWARMFORGE_MODEL_API_KEY,
    config.SWARMFORGE_API_TOKEN ?? "",
  );
  const provider = new LocalWorkerProvider(guest, config);
  if (!provider.artifactTransport)
    throw new SmokeFailure(
      "capture fixture exposes no artifact transport; salvage cannot be proven",
    );
  const store = new Store(dbPath);
  const agent = new DeadOpenCode();
  const coordinator = new Coordinator(config, store, provider, agent);
  const findings = `${JSON.stringify(
    {
      run: "artifact-salvage-smoke",
      verdict: "workspace output recovered after OpenCode died",
      items: [{ file: "src/example.ts", note: "bounded finding" }],
    },
    null,
    2,
  )}\n`;
  const findingsDigest = digest(findings);
  let server: ReturnType<typeof createMcpServer> | undefined;
  try {
    const spawned = coordinator.spawn({
      team_id: "salvage-smoke",
      task_id: `salvage-${Date.now()}`,
      role: "tester",
      prompt:
        "Write findings.json and stop. The coordinator preserves the workspace independently.",
      // A short deadline bounds the smoke: with OpenCode dead, the turn can only settle by
      // running out of time, and the VM is retained for salvage.
      timeout_seconds: 5,
      artifacts: [
        { path: "findings.json", required: true },
        { path: ".swarmforge/artifacts/**" },
        { path: ".swarmforge/logs/**" },
      ],
    });
    note("worker_requested", { worker_id: spawned.worker_id });
    let worker: Worker | undefined;
    for (let attempt = 0; attempt < 40; attempt++) {
      await coordinator.tick();
      worker = store.get(spawned.worker_id);
      if (worker.state === "running") break;
      if (["failed", "recovery_required", "cancelled"].includes(worker.state))
        break;
      await Bun.sleep(10);
    }
    if (worker?.state !== "running")
      fail(`worker never started (state ${worker?.state ?? "unknown"})`);
    const vmId = worker.vm_id!;
    note("worker_running", { worker_id: worker.worker_id, vm_id: vmId });
    // The worker's own output, written into the real guest filesystem before its agent died.
    const write = (path: string, content: string) => {
      const target = join(guest.root, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    };
    write("findings.json", findings);
    write(".swarmforge/artifacts/notes.md", "# notes\n");
    write(".swarmforge/logs/run.log", "worker log line\n");
    // The rest of the default collection set, so preservation settles on its first attempt
    // instead of retrying: this simulated worker plays a worker that produced its normal output.
    write(
      ".swarmforge/result.json",
      JSON.stringify({
        worker_id: worker.worker_id,
        task_id: worker.task_id,
        run_id: store.dispatch(worker.worker_id)?.run_id,
        status: "failed",
        summary:
          "local salvage smoke worker wrote findings.json and then lost OpenCode",
      }),
    );
    write(".swarmforge/task.json", JSON.stringify({ task: worker.task_id }));
    write(".swarmforge/metadata.json", JSON.stringify({ role: "tester" }));
    if (!existsSync(join(guest.root, "findings.json")))
      fail("guest findings.json is missing");
    // OpenCode stays down; the turn must settle as a failure with the VM retained.
    let settled: Worker | undefined;
    for (let attempt = 0; attempt < 600; attempt++) {
      await coordinator.tick();
      settled = store.get(worker.worker_id);
      if (
        ["failed", "recovery_required", "cancelled", "completed"].includes(
          settled.state,
        )
      )
        break;
      await Bun.sleep(10);
    }
    if (!settled || settled.state === "running" || settled.state === "waiting")
      fail(`worker did not settle without OpenCode (state ${settled?.state})`);
    if (settled.state !== "failed")
      fail(
        `expected a failed worker, got ${settled.state}: ${settled.error ?? ""}`,
      );
    note("opencode_dead", {
      worker_id: settled.worker_id,
      state: settled.state,
      error: settled.error,
      polls: agent.polls,
      vm_retained: Boolean(settled.vm_id) && !settled.vm_missing,
    });
    server = createMcpServer(coordinator);
    const client = new Client({ name: "salvage-smoke", version: "1" });
    const [clientToServer, serverToClient] =
      InMemoryTransport.createLinkedPair();
    await server.connect(clientToServer);
    await client.connect(serverToClient);
    // Collection is a lifecycle stage of its own: let the coordinator drive it to a terminal
    // state first, then ask for one deliberate retry if it has not preserved. A refusal is
    // acceptable only while the record still settles preserved.
    const settledStates = new Set(["preserved", "failed", "abandoned"]);
    let finalization = settled.finalization?.state ?? null;
    for (let attempt = 0; attempt < 300; attempt++) {
      if (finalization && settledStates.has(finalization)) break;
      await coordinator.tick();
      finalization = store.get(settled.worker_id).finalization?.state ?? null;
      await Bun.sleep(10);
    }
    if (finalization !== "preserved") {
      const retried = await client.callTool({
        name: "retry_worker_finalization",
        arguments: { worker_id: settled.worker_id },
      });
      finalization = store.get(settled.worker_id).finalization?.state ?? null;
      note("finalization_retried", {
        state: finalization,
        refused: retried.isError === true,
      });
    }
    if (finalization !== "preserved")
      fail(
        `artifact finalization did not settle (state ${finalization}): ` +
          `${store.get(settled.worker_id).finalization?.error ?? "no recorded error"}`,
      );
    const listed = await client.callTool({
      name: "list_artifacts",
      arguments: { worker_id: settled.worker_id },
    });
    if (listed.isError) fail("list_artifacts reported a tool error");
    const artifacts = (
      listed.structuredContent as { artifacts: ArtifactRecord[] }
    ).artifacts;
    const record = artifacts.find((a) => a.original_path === "findings.json");
    if (!record) fail("findings.json was not preserved");
    if (record.state !== "preserved" || !record.sha256)
      fail(`findings.json is not preserved (state ${record.state})`);
    if (record.sha256 !== findingsDigest)
      fail("preserved checksum does not match the worker output");
    if (record.size !== Buffer.byteLength(findings))
      fail("preserved size does not match the worker output");
    note("artifact_preserved", {
      artifact_id: record.artifact_id,
      original_path: record.original_path,
      size: record.size,
      sha256: record.sha256,
    });
    // Prove the production helper actually ran: the fixture records every helper command it
    // executed in the guest, and staging must be empty once capture is done.
    const helperCommands = guest.host.commands.filter((command) =>
      command.includes("artifact-helper.py"),
    );
    if (!helperCommands.length)
      fail(
        "no guest helper command was executed; capture did not use the helper",
      );
    if (guest.stagingEntries().length)
      fail(
        "guest staging is not empty after capture; private copies were left behind",
      );
    note("guest_helper_used", {
      helper: "src/providers/artifact-helper.py",
      commands: helperCommands.length,
      staging_entries_after_capture: 0,
    });
    // Model-facing read: a bounded, screened excerpt, never the whole file.
    const read = await client.callTool({
      name: "read_artifact",
      arguments: { artifact_id: record.artifact_id, length: 256 },
    });
    if (read.isError) fail("read_artifact reported a tool error");
    const view = read.structuredContent as {
      binary: boolean;
      returned_bytes: number;
      text: string | null;
      download_path: string;
    };
    if (view.binary || view.text !== findings.slice(0, 256))
      fail("read_artifact did not return the expected screened excerpt");
    // Raw bytes over the authenticated download, before the workspace is gone.
    const before = await downloadVerified(coordinator, record);
    note("download_verified", {
      stage: "pre-destruction",
      bytes: before.bytes.length,
      sha256: before.sha256,
    });
    await coordinator.control(settled.worker_id, "destroy");
    const destroyed = store.get(settled.worker_id);
    if (destroyed.state !== "destroyed")
      fail(`destruction refused: ${destroyed.state}: ${destroyed.error ?? ""}`);
    if (existsSync(join(guest.root, "findings.json")))
      fail("guest workspace still exists after destruction");
    note("worker_destroyed", {
      worker_id: destroyed.worker_id,
      workspace_removed: true,
    });
    // The record and its bytes outlive the worker and its workspace.
    const after = await coordinator.artifacts.metadata(record.artifact_id);
    const reread = await downloadVerified(coordinator, after);
    if (reread.sha256 !== findingsDigest)
      fail("post-destruction checksum mismatch");
    const listedAfter = await client.callTool({
      name: "list_artifacts",
      arguments: { worker_id: destroyed.worker_id },
    });
    if (listedAfter.isError) fail("list_artifacts failed after destruction");
    const surviving = (
      listedAfter.structuredContent as { artifacts: ArtifactRecord[] }
    ).artifacts.find((a) => a.artifact_id === record.artifact_id);
    if (surviving?.state !== "preserved")
      fail("artifact metadata did not survive worker destruction");
    note("download_verified", {
      stage: "post-destruction",
      bytes: reread.bytes.length,
      sha256: reread.sha256,
    });
    note("smoke_passed", {
      mode: "local",
      capture:
        "local-filesystem fixture (package 1 local transport); not a VM run",
      worker_id: destroyed.worker_id,
      artifacts_preserved: (
        listedAfter.structuredContent as { artifacts: unknown[] }
      ).artifacts.length,
      checksum_verified: reread.sha256 === findingsDigest,
    });
    await client.close();
    await server.close();
    server = undefined;
  } finally {
    await server?.close().catch(() => {});
    store.close();
    await guest.cleanup().catch(() => {});
    if (opts.keep) note("kept", { root });
    else rmSync(root, { recursive: true, force: true });
  }
}

async function freestyleSmoke(opts: Options) {
  if (!opts.freestyle) fail("--freestyle requires a VM identifier");
  const config = loadConfig();
  known.push(
    config.FREESTYLE_API_TOKEN,
    config.SWARMFORGE_MODEL_API_KEY,
    config.SWARMFORGE_API_TOKEN ?? "",
  );
  if (!config.SWARMFORGE_API_TOKEN)
    fail("freestyle mode requires SWARMFORGE_API_TOKEN for the download check");
  // Work on a private copy of the database and a private storage root: a retained VM must
  // never be disturbed by a salvage probe.
  const root = mkdtempSync(join(tmpdir(), "swarmforge-salvage-vm-"));
  const dbPath = join(root, "swarmforge.sqlite");
  copyFileSync(config.SWARMFORGE_DB_PATH, dbPath);
  const store = new Store(dbPath);
  const provider: WorkerProvider = new FreestyleProvider(config);
  const coordinator = new Coordinator(
    config,
    store,
    provider,
    new DeadOpenCode(),
  );
  try {
    const vm: VmInfo | null = await provider.getWorker(opts.freestyle);
    if (!vm) fail(`VM ${opts.freestyle} is not reachable`);
    const workers = store.all().filter((w) => w.vm_id === opts.freestyle);
    const workerId =
      opts.worker ??
      workers.find((w) => w.state !== "destroyed")?.worker_id ??
      workers[0]?.worker_id;
    if (!workerId)
      fail(
        `no worker record owns VM ${opts.freestyle}; pass --worker <worker-id>`,
      );
    const worker = store.get(workerId);
    note("vm_target", {
      worker_id: workerId,
      vm_id: vm.id,
      vm_state: vm.state,
    });
    const preserved: ArtifactRecord[] = [];
    if (opts.snapshot) {
      preserved.push(await coordinator.artifacts.snapshot(workerId, {}));
    } else {
      const paths = opts.paths.length
        ? opts.paths
        : (
            await coordinator.artifacts.listWorkerFiles(workerId, "", {
              limit: 50,
            })
          ).entries
            .filter((e) => e.kind === "file")
            .map((e) => e.name)
            .slice(0, 10);
      for (const path of paths) {
        try {
          preserved.push(
            await coordinator.artifacts.preserve(workerId, path, {}),
          );
        } catch (error) {
          note("preserve_failed", {
            path,
            error: error instanceof Error ? error.message : "unknown error",
          });
        }
      }
    }
    if (!preserved.length)
      fail("nothing could be preserved from the retained VM");
    const checked: Record<string, unknown>[] = [];
    for (const record of preserved) {
      const { bytes, sha256 } = await downloadVerified(coordinator, record);
      checked.push({
        artifact_id: record.artifact_id,
        original_path: record.original_path,
        size: record.size,
        sha256,
        verified: sha256 === record.sha256 && bytes.length === record.size,
      });
    }
    note("vm_salvaged", {
      mode: "freestyle",
      capture: "Freestyle provider artifact transport (real VM)",
      worker_id: workerId,
      vm_id: vm.id,
      artifacts: checked,
      worker_state: worker.state,
      note: "retained VM left running; destruction is an explicit operator action",
    });
  } finally {
    store.close();
    if (opts.keep) note("kept", { root });
    else rmSync(root, { recursive: true, force: true });
  }
}

export async function smoke(argv = process.argv.slice(2)) {
  const opts = options(argv);
  await (opts.freestyle ? freestyleSmoke(opts) : localSmoke(opts));
}

if (import.meta.main) {
  try {
    await smoke();
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "failed",
        error: report(error),
        ...(error instanceof SmokeFailure ? {} : { kind: "unexpected" }),
      }),
    );
    process.exitCode = 1;
  }
}
