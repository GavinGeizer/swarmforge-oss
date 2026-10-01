#!/usr/bin/env bun
// Real coordinator-host proof runner for durable artifact retrieval and worker salvage.
//
// This is the only file this worker owns. It changes no production code and no
// other worker's script or test.
//
// WHAT IT PROVES, ON A REAL FREESTYLE VM, WITH NO MODEL INVOLVED
//
//   1. OpenCode is stopped through the provider, so nothing depends on the
//      worker's cooperation.
//   2. A non-sensitive fixture is written into the retained VM through the
//      Freestyle native SDK filesystem transport (raw bytes, never exec output,
//      never base64, never printed).
//   3. A malformed handoff is simulated as a CodingAgent completion. No LLM is
//      called; the agent double returns an idle session carrying a completed but
//      unparseable assistant result.
//   4. A fresh private Store adopts the VM id with a REQUIRED declared artifact,
//      and the coordinator's own tick/finalize performs the capture.
//   5. The preserved SHA-256 is verified against the bytes the runner generated,
//      and the bytes are re-read through the raw private path.
//   6. ONLY with --destroy-proven-fixture, and only for the fixed known VM, the
//      coordinator's normal (non-force) destroy control runs. That path enforces
//      the existing Git durability checks, so a dirty or unpushed primary source
//      refuses and the VM is retained.
//   7. After the VM is actually deleted, the record and its bytes are re-read and
//      re-verified from private storage.
//   8. The report carries metadata checks only: sizes, digests, states, flags.
//
// SAFETY
//
//   - The only addressable VM is the task-retained research VM below. Any other
//     --vm/--worker value is refused. There is no arbitrary target and no force
//     delete anywhere in this file.
//   - Every failure path records the retained state and exits non-zero. Nothing
//     here destroys anything it has not proven.
//   - Host credentials are never printed. Errors are passed through the project's
//     own Redactor BEFORE they are truncated, so a secret that straddles the
//     truncation boundary cannot be partially revealed.
//   - The report is written under an explicit private evidence directory with
//     mode 0700, and an existing report is preserved, never clobbered.
//
// USAGE
//
//   bun scripts/artifact-salvage-real-proof.ts                      # plan only
//   bun scripts/artifact-salvage-real-proof.ts --execute \
//     --evidence-dir /private/path/evidence
//   bun scripts/artifact-salvage-real-proof.ts --execute \
//     --evidence-dir /private/path/evidence --destroy-proven-fixture
//
// Plan mode is the default and touches no credential, no network and no guest.
// Real mode needs the host environment already configured for SwarmForge; this
// script never requests, sends or logs host infrastructure secrets.

import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openAsBlob,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { loadConfig } from "../src/config";
import { Coordinator } from "../src/coordinator";
import type {
  AgentSnapshot,
  CodingAgent,
  Dispatch,
  VmInfo,
  Worker,
} from "../src/domain";
import { FreestyleProvider } from "../src/providers/freestyle";
import { inspectPersistence } from "../src/safety";
import { redactorFor } from "../src/security";
import { Store } from "../src/store";

// The single VM this runner may address. It is the research VM retained for this
// task, still owned by the previous worker. Nothing else is addressable.
const PROOF_VM = "vm-f5291240e51a4432a1556387bb9ab20b";
const PROOF_WORKER = "w-0aa35639-10b7-400e-bc07-e273b6d95e5b";
const FIXTURE_PATH = ".swarmforge/artifacts/e2e-findings.json";
const LARGE_FIXTURE_PATH = ".swarmforge/artifacts/e2e-large.bin";
const LARGE_MIB = 32;
/** Comfortably larger than any MCP inline read, which is bounded at 32 KiB. */
const LARGE_BYTES = LARGE_MIB * 1024 * 1024;

interface Options {
  execute: boolean;
  evidenceDir?: string;
  destroy: boolean;
  large: boolean;
  vm: string;
  worker: string;
}
class ProofFailure extends Error {
  constructor(
    message: string,
    readonly retained?: Record<string, unknown>,
  ) {
    super(message);
  }
}
const digest = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
const defaultOptions = (): Options => ({
  execute: false,
  destroy: false,
  large: false,
  vm: PROOF_VM,
  worker: PROOF_WORKER,
});
function parse(argv: string[]): Options {
  const out = defaultOptions();
  const value = (index: number, flag: string) => {
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--"))
      throw new ProofFailure(`${flag} requires a value`);
    return next;
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === "--execute") out.execute = true;
    else if (flag === "--destroy-proven-fixture") out.destroy = true;
    else if (flag === "--with-large-binary") out.large = true;
    else if (flag === "--evidence-dir") out.evidenceDir = value(i++, flag);
    else if (flag === "--vm") out.vm = value(i++, flag);
    else if (flag === "--worker") out.worker = value(i++, flag);
    else if (flag === "--help" || flag === "-h") usage();
    else throw new ProofFailure(`unknown argument: ${flag}`);
  }
  return out;
}
function usage() {
  console.log(
    [
      "usage: bun scripts/artifact-salvage-real-proof.ts",
      "       bun scripts/artifact-salvage-real-proof.ts --execute --evidence-dir <dir> [--with-large-binary]",
      "       bun scripts/artifact-salvage-real-proof.ts --execute --evidence-dir <dir> --destroy-proven-fixture",
      "",
      "Plan mode is the default and touches no credential and no guest.",
      `Only VM ${PROOF_VM} is addressable. Destruction is never forced.`,
    ].join("\n"),
  );
  process.exit(0);
}

/**
 * The malformed handoff, with no model involved. `submit` records that a prompt
 * went out; `inspect` reports an idle session whose completed assistant message
 * carries a result the coordinator's result schema must reject. The coordinator
 * then falls back to the guest's own result.json, which this runner deliberately
 * does not write, and settles the worker as failed with its VM retained.
 */
class MalformedHandoffAgent implements CodingAgent {
  prompts = 0;
  polls = 0;
  /** The prompt message id the coordinator dispatched, so the reply can be tied to it. */
  private promptId: string | null = null;
  async ensureSession(w: Worker) {
    return `ses-${w.worker_id}`;
  }
  async submit(_w: Worker, d: Dispatch) {
    this.prompts++;
    this.promptId = d.message_id;
  }
  async inspect(w: Worker): Promise<AgentSnapshot> {
    this.polls++;
    return {
      status: "idle",
      inference_active: 0,
      messages: [
        {
          id: `msg-${w.worker_id}`,
          ...(this.promptId === null ? {} : { parent_id: this.promptId }),
          role: "assistant",
          completed: true,
          // Structurally valid JSON that the result schema rejects: the handoff a
          // worker actually leaves behind when its final message is not a result.
          result: { status: "totally-unknown", summary: 12345 },
          input: 0,
          output: 0,
          reasoning: 0,
          cache_read: 0,
          cache_write: 0,
        },
      ],
    };
  }
  async abort() {}
}

/** One redacted, bounded evidence line. Never a credential, never unbounded. */
class Evidence {
  private readonly lines: string[] = [];
  constructor(private readonly path: string) {}
  event(name: string, detail: Record<string, unknown> = {}) {
    const line = JSON.stringify({
      event: name,
      at: Date.now(),
      ...detail,
    });
    this.lines.push(line);
    console.log(line);
    try {
      appendFileSync(this.path, `${line}\n`, { mode: 0o600 });
    } catch {
      // Evidence is best effort; the run's own result is what the lead reads.
    }
  }
  get jsonl() {
    return this.path;
  }
}

/** Redact first, then bound. Never the other way round. */
function bounded(redact: (text: string) => string, value: unknown, max = 400) {
  const raw = value instanceof Error ? value.message : String(value);
  return redact(raw).slice(0, max);
}

function privateDir(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {}
  return dir;
}

/** Preserve, never clobber: an earlier report survives this run. */
function preserveExisting(report: string) {
  if (!existsSync(report)) return null;
  const kept = `${report}.${Date.now()}.bak`;
  try {
    copyFileSync(report, kept);
    chmodSync(kept, 0o600);
    return kept;
  } catch {
    return null;
  }
}

async function main(opts: Options) {
  if (opts.vm !== PROOF_VM)
    throw new ProofFailure(
      `refusing to address ${opts.vm}: this runner may only target ${PROOF_VM}`,
    );
  if (opts.worker !== PROOF_WORKER)
    throw new ProofFailure(
      `refusing worker ${opts.worker}: this runner may only adopt ${PROOF_WORKER}`,
    );
  if (opts.destroy && !opts.execute)
    throw new ProofFailure("--destroy-proven-fixture requires --execute");
  if (!opts.execute) {
    console.log(
      JSON.stringify(
        {
          mode: "plan",
          note: "no credential, no network and no guest were touched",
          vm: PROOF_VM,
          worker: PROOF_WORKER,
          steps: [
            "stop OpenCode through the provider",
            `write ${FIXTURE_PATH} over the native SDK filesystem transport`,
            "simulate a malformed handoff as a CodingAgent completion (no LLM)",
            "fresh private Store adopts the VM with a REQUIRED declared artifact",
            "coordinator.tick() then coordinator.finalize()",
            "verify the preserved SHA-256 and re-read the raw private bytes",
            "gate on the existing Git durability check; refuse and retain on failure",
            "normal (never forced) destroy only with --destroy-proven-fixture",
            "re-read and re-verify the bytes after the VM is actually deleted",
          ],
          large_binary: `${LARGE_MIB} MiB streamed upload with --with-large-binary`,
        },
        null,
        2,
      ),
    );
    return;
  }

  const evidenceDir = privateDir(
    opts.evidenceDir ??
      join(process.cwd(), ".swarmforge", "artifacts", "real-proof"),
  );
  const report = join(evidenceDir, "artifact-salvage-real-proof.json");
  const keptReport = preserveExisting(report);
  const evidence = new Evidence(join(evidenceDir, "real-proof.jsonl"));
  evidence.event("run_started", {
    vm: opts.vm,
    worker: opts.worker,
    destroy_proven_fixture: opts.destroy,
    large_binary: opts.large,
    preserved_previous_report: keptReport ? basename(keptReport) : null,
  });

  // The private database and private artifact store live under the explicit
  // evidence directory, never beside the live ones.
  const config = loadConfig({
    ...(process.env.SWARMFORGE_DB_PATH
      ? {}
      : { SWARMFORGE_DB_PATH: join(evidenceDir, "proof.sqlite") }),
    SWARMFORGE_ARTIFACT_DIR: join(evidenceDir, "artifacts"),
  });
  const provider = new FreestyleProvider(config);
  const store = new Store(config.SWARMFORGE_DB_PATH);
  const agent = new MalformedHandoffAgent();
  const coordinator = new Coordinator(config, store, provider, agent);
  const redact = (text: string) => redactorFor(coordinator).text(text);
  const finished: Record<string, unknown> = {
    mode: "real",
    vm: opts.vm,
    worker: opts.worker,
    preserved_previous_report: keptReport ? basename(keptReport) : null,
  };

  try {
    const vm: VmInfo | null = await provider.getWorker(opts.vm);
    if (!vm) throw new ProofFailure(`VM ${opts.vm} is not reachable`);
    if (vm.id !== opts.vm)
      throw new ProofFailure(`provider answered a different VM (${vm.id})`);
    evidence.event("vm_reachable", { vm_state: vm.state });

    // 1. OpenCode is stopped through the provider, using the coordinator's own
    //    command, and its absence is confirmed rather than assumed.
    const stop = await provider.exec(
      opts.vm,
      "systemctl stop swarmforge-opencode.service && ! systemctl is-active --quiet swarmforge-opencode.service",
    );
    evidence.event("opencode_stopped", { exit_code: stop.code });
    if (stop.code !== 0)
      throw new ProofFailure(
        `could not stop OpenCode (exit ${String(stop.code)}): ${bounded(redact, stop.stderr)}`,
      );

    // 2. A non-sensitive fixture, written as raw bytes over the native SDK
    //    filesystem transport. Outside Git metadata, and the workspace Git check
    //    already excludes .swarmforge.
    const findings = `${JSON.stringify(
      {
        proof: "artifact-salvage-real-proof",
        run: randomUUID(),
        verdict: "fixture written before the handoff went malformed",
        note: "no credentials, no model output, no base64",
        findings: [
          "the guest was retained with no OpenCode service running",
          "the coordinator preserved the workspace without the worker",
        ],
      },
      null,
      2,
    )}\n`;
    const findingsDigest = digest(findings);
    const fixtureAbsolute = join(config.SWARMFORGE_WORKSPACE, FIXTURE_PATH);
    await provider.client.vms
      .ref(opts.vm)
      .fs.writeFile(fixtureAbsolute, findings, { mode: 0o600 });
    evidence.event("fixture_written", {
      path: FIXTURE_PATH,
      bytes: Buffer.byteLength(findings),
      sha256: findingsDigest,
    });

    // Optional: a fixture larger than any MCP inline response, generated in
    // bounded chunks on disk and uploaded as a resumable chunked Blob so the
    // bytes are never assembled whole in this process.
    let largeDigest: string | null = null;
    if (opts.large) {
      const staging = join(evidenceDir, "e2e-large.bin");
      const hash = createHash("sha256");
      const chunk = Buffer.alloc(1024 * 1024, 0x5a);
      const writer = Bun.file(staging).writer();
      for (let i = 0; i < LARGE_MIB; i++) {
        hash.update(chunk);
        await writer.write(chunk);
      }
      await writer.end();
      largeDigest = hash.digest("hex");
      await provider.client.vms
        .ref(opts.vm)
        .fs.writeFile(
          join(config.SWARMFORGE_WORKSPACE, LARGE_FIXTURE_PATH),
          await openAsBlob(staging),
          {
            mode: 0o600,
            chunkSize: 8 * 1024 * 1024,
          },
        );
      evidence.event("large_fixture_written", {
        path: LARGE_FIXTURE_PATH,
        bytes: LARGE_BYTES,
        sha256: largeDigest,
      });
    }

    // 3. A fresh private Store adopts the VM with a REQUIRED declared artifact,
    //    and the malformed handoff is delivered through the coordinator.
    const spawned = coordinator.spawn({
      team_id: "artifact-salvage-real-proof",
      task_id: `real-proof-${Date.now()}`,
      role: "coder",
      prompt: "salvage proof: the workspace must survive this worker",
      timeout_seconds: 300,
      artifacts: [{ path: FIXTURE_PATH, required: true }],
    });
    // Adopt the retained VM instead of provisioning one: the record is patched
    // straight to ready, so no new guest is ever created.
    store.patch(spawned.worker_id, {
      state: "ready",
      vm_id: opts.vm,
      opencode_session_id: `ses-${opts.worker}`,
      started_at: Date.now(),
    });
    evidence.event("worker_adopted_vm", {
      worker_id: spawned.worker_id,
      vm_id: opts.vm,
      required_artifact: FIXTURE_PATH,
    });

    // 4. The coordinator's own tick drives delivery and the malformed settle.
    for (let i = 0; i < 24; i++) {
      await coordinator.tick();
      const w = store.get(spawned.worker_id);
      if (
        ["failed", "completed", "cancelled", "recovery_required"].includes(
          w.state,
        )
      )
        break;
      await Bun.sleep(500);
    }
    const settled = store.get(spawned.worker_id);
    evidence.event("worker_settled", {
      state: settled.state,
      error: settled.error ? bounded(redact, settled.error) : null,
      prompts: agent.prompts,
      polls: agent.polls,
      vm_retained: Boolean(settled.vm_id) && !settled.vm_missing,
    });
    if (settled.state !== "failed")
      throw new ProofFailure(
        `expected a failed worker with a retained VM, got ${settled.state}`,
        { state: settled.state, finalization: settled.finalization ?? null },
      );
    if (!settled.vm_id || settled.vm_missing)
      throw new ProofFailure(
        "worker VM is not retained; refusing to continue",
        {
          state: settled.state,
        },
      );

    // 5. Finalize, then verify the preserved digest against the bytes generated.
    const finalized = await coordinator.finalize(spawned.worker_id);
    const record = coordinator.artifacts
      .list({ worker_id: spawned.worker_id, limit: 100 })
      .artifacts.find((a) => a.original_path === FIXTURE_PATH);
    evidence.event("finalization_settled", {
      state: finalized.finalization?.state ?? null,
      attempts: finalized.finalization?.attempts ?? null,
      error: finalized.finalization?.error
        ? bounded(redact, finalized.finalization.error)
        : null,
      artifact_present: Boolean(record),
    });
    if (!record)
      throw new ProofFailure(
        `required artifact ${FIXTURE_PATH} was not preserved`,
        { finalization: finalized.finalization ?? null },
      );
    if (record.state !== "preserved" || !record.sha256)
      throw new ProofFailure(
        `artifact is ${record.state}: ${bounded(redact, record.error ?? "no bytes")}`,
        { finalization: finalized.finalization ?? null },
      );
    if (record.sha256 !== findingsDigest)
      throw new ProofFailure("preserved checksum does not match the fixture");
    if (record.size !== Buffer.byteLength(findings))
      throw new ProofFailure("preserved size does not match the fixture");

    // Re-read the raw private bytes and hash them again, streamed, never printed.
    const reread = new Uint8Array(
      await coordinator.artifacts.read(record.artifact_id, 0, record.size),
    );
    if (digest(reread) !== findingsDigest)
      throw new ProofFailure("raw private re-read does not match the fixture");
    evidence.event("sha_verified_before_destroy", {
      artifact_id: record.artifact_id,
      bytes: record.size,
      sha256: record.sha256,
    });

    // 6. The existing Git durability gate, checked before anything is destroyed.
    //    A dirty or unpushed primary source refuses here and the VM is retained.
    const safety = await inspectPersistence(
      provider,
      config,
      settled,
      store.result(spawned.worker_id),
    );
    evidence.event("git_durability_gate", {
      safe: safety.safe,
      reason: bounded(redact, safety.reason),
    });
    if (!safety.safe)
      throw new ProofFailure(
        `source durability gate refused: ${bounded(redact, safety.reason)}`,
        { retained_vm: opts.vm, state: settled.state },
      );

    if (!opts.destroy) {
      finished.result = "proven";
      finished.note = "VM retained; destruction is an explicit operator action";
      evidence.event("proof_complete", finished);
      return;
    }

    // 7. Normal, never forced, destruction of the fixed VM only.
    const destroyed = await coordinator.control(spawned.worker_id, "destroy");
    evidence.event("destroy_requested", {
      state: destroyed.state,
      force: false,
    });
    if (destroyed.state !== "destroyed")
      throw new ProofFailure(
        `destruction refused (state ${destroyed.state}): ${bounded(redact, destroyed.error ?? "")}`,
        { retained_vm: opts.vm, state: destroyed.state },
      );
    const gone = await provider.getWorker(opts.vm);
    evidence.event("vm_deleted", { provider_still_reports_vm: Boolean(gone) });
    if (gone)
      throw new ProofFailure(
        "the VM is still reported after destruction; the proof is incomplete",
        { retained_vm: opts.vm },
      );

    // 8. The record and its bytes outlive the VM. Re-read and re-verify after the
    //    guest is actually gone.
    const after = coordinator.artifacts.metadata(record.artifact_id);
    const afterBytes = new Uint8Array(
      await coordinator.artifacts.read(after.artifact_id, 0, after.size),
    );
    if (after.state !== "preserved" || digest(afterBytes) !== findingsDigest)
      throw new ProofFailure("post-destruction verification failed", {
        artifact_id: after.artifact_id,
        state: after.state,
      });
    if (largeDigest) {
      const largeRecord = coordinator.artifacts
        .list({ worker_id: spawned.worker_id, limit: 100 })
        .artifacts.find((a) => a.original_path === LARGE_FIXTURE_PATH);
      if (largeRecord?.state !== "preserved")
        throw new ProofFailure("the large streamed artifact did not survive");
      const streamed = await coordinator.artifacts.download(
        largeRecord.artifact_id,
      );
      const hash = createHash("sha256");
      let bytes = 0;
      for await (const part of streamed as unknown as AsyncIterable<Uint8Array>) {
        hash.update(part);
        bytes += part.byteLength;
      }
      evidence.event("large_artifact_verified", {
        artifact_id: largeRecord.artifact_id,
        bytes,
        sha256: hash.digest("hex"),
        matches: hash.digest("hex") === largeDigest,
      });
    }
    evidence.event("sha_verified_after_destroy", {
      artifact_id: after.artifact_id,
      bytes: after.size,
      sha256: after.sha256,
    });
    finished.result = "proven";
    finished.destroyed = true;
  } catch (error) {
    // A failure records the retained state. Nothing here deletes anything.
    const retained = {
      vm_id: opts.vm,
      worker_id: opts.worker,
      state: "retained",
      ...(error instanceof ProofFailure ? (error.retained ?? {}) : {}),
    };
    finished.result = "refused";
    finished.retained = retained;
    finished.error = bounded(
      (t: string) => redactorFor(coordinator).text(t),
      error,
    );
    evidence.event("proof_failed", {
      error: finished.error,
      retained,
    });
    throw error;
  } finally {
    // The report is written last and never clobbers an earlier one.
    try {
      const body = `${JSON.stringify(
        { ...finished, at: Date.now(), evidence: basename(evidence.jsonl) },
        null,
        2,
      )}\n`;
      writeFileSync(report, body, { mode: 0o600 });
      if (keptReport)
        writeFileSync(keptReport, `${JSON.stringify(finished, null, 2)}\n`, {
          mode: 0o600,
        });
    } catch {}
    store.close();
  }
}

try {
  await main(parse(process.argv.slice(2)));
} catch (error) {
  console.log(
    JSON.stringify({
      event: "runner_failed",
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
}
