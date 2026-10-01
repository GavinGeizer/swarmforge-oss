#!/usr/bin/env bun
// End-to-end artifact salvage smoke.
//
// Local mode (default) runs the production capture contract against a real local guest
// filesystem through the package 1 local transport fixture: a worker writes findings.json,
// its OpenCode service dies, the coordinator collects the file into private storage through
// a real byte stream with a verified checksum, the worker workspace is destroyed, and the
// bytes are re-read and re-verified from storage afterwards.
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
import { join } from "node:path";
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
import { Store } from "../src/store";
import { LocalArtifactProvider } from "../tests/local-artifact-provider";

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
type ArtifactRecord = Awaited<ReturnType<Coordinator["artifacts"]["preserve"]>>;
function note(event: string, detail: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ event, ...detail }));
}
// Thrown rather than exiting so temporary guest databases and workspaces are still removed.
function fail(message: string): never {
  throw new SmokeFailure(message);
}
// A smoke report never carries credentials or unbounded provider output.
function safeMessage(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .replace(/(bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
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
  const guests = join(root, "guests");
  const state = join(root, "state");
  mkdirSync(guests, { recursive: true });
  mkdirSync(state, { recursive: true });
  const dbPath = join(state, "swarmforge.sqlite");
  // Placeholder infrastructure values only: the local fixture never contacts any of them.
  const config = loadConfig({
    FREESTYLE_API_TOKEN: "local-fixture-not-a-credential",
    FREESTYLE_SNAPSHOT_ID: "local-fixture",
    SWARMFORGE_MODEL_BASE_URL: "https://model.invalid/v1",
    SWARMFORGE_MODEL_API_KEY: "local-fixture-not-a-credential",
    SWARMFORGE_MODEL_NAME: "local-fixture",
    SWARMFORGE_GIT_TREE: "none:local-fixture",
    SWARMFORGE_DB_PATH: dbPath,
    SWARMFORGE_POLL_INTERVAL_MS: "10",
    SWARMFORGE_TOKEN_IDLE_TIMEOUT_SECONDS: "1",
    SWARMFORGE_API_TOKEN: "salvage-smoke-token-with-enough-characters",
    SWARMFORGE_METRICS_ENABLED: "false",
  });
  const provider = new LocalArtifactProvider(config, guests);
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
    // The worker's own output, written to the guest filesystem before its agent died.
    const workspace = config.SWARMFORGE_WORKSPACE;
    const guest = (path: string) =>
      join(guests, vmId, workspace.slice(1), path);
    mkdirSync(guest(".swarmforge/artifacts"), { recursive: true });
    mkdirSync(guest(".swarmforge/logs"), { recursive: true });
    writeFileSync(guest("findings.json"), findings);
    writeFileSync(guest(".swarmforge/artifacts/notes.md"), "# notes\n");
    writeFileSync(guest(".swarmforge/logs/run.log"), "worker log line\n");
    if (!existsSync(guest("findings.json")))
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
    let finalization: string | null = settled.finalization?.state ?? null;
    if (finalization !== "preserved") {
      const retried = await client.callTool({
        name: "retry_worker_finalization",
        arguments: { worker_id: settled.worker_id },
      });
      if (retried.isError)
        fail("retry_worker_finalization reported a tool error");
      finalization =
        (
          retried.structuredContent as {
            finalization?: { state?: string } | null;
          }
        ).finalization?.state ?? null;
      note("finalization_retried", { state: finalization });
    }
    if (finalization !== "preserved")
      fail(`artifact finalization did not settle (state ${finalization})`);
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
    if (existsSync(guest("findings.json")))
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
    if (opts.keep) note("kept", { root });
    else rmSync(root, { recursive: true, force: true });
  }
}

async function freestyleSmoke(opts: Options) {
  if (!opts.freestyle) fail("--freestyle requires a VM identifier");
  const config = loadConfig();
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
        error: safeMessage(error),
        ...(error instanceof SmokeFailure ? {} : { kind: "unexpected" }),
      }),
    );
    process.exitCode = 1;
  }
}
