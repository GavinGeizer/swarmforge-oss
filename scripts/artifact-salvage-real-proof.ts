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
//   2. A non-sensitive findings document is written into the retained VM through
//      the Freestyle native SDK filesystem transport (raw bytes, never exec output,
//      never base64, never printed).
//   3. A malformed handoff is simulated as a CodingAgent completion. No LLM is
//      called; the agent double returns an idle session carrying a completed but
//      unparseable assistant result.
//   4. A fresh private Store adopts the VM id with a REQUIRED declared artifact,
//      and the coordinator's own tick/finalize performs the capture.
//   5. The preserved SHA-256 is verified against the bytes the runner generated,
//      and the bytes are re-read through the raw private path.
//   6. The existing Git durability gate runs against the real workspace, and the
//      original owner's handoff provenance is read from a read-only snapshot.
//   7. ONLY with --destroy-proven-fixture, --execute AND a provenance snapshot, the
//      coordinator's normal (non-force) destroy control runs. That path enforces
//      the existing Git durability checks, so a dirty or unpushed primary source
//      refuses and the VM is retained.
//   8. After the VM is actually deleted, the record and its bytes are re-read and
//      re-verified from private storage.
//   9. The report carries metadata checks only: sizes, digests, states, flags.
//
// SAFETY
//
//   - The only addressable VM is the constant above, the existing DATA-plane owner
//     fixture. There is no --vm and no --worker at all, so no argument can
//     retarget this runner, and there is no force delete anywhere in this file.
//   - Destruction needs --execute AND --destroy-proven-fixture AND a read-only
//     provenance snapshot, and it always goes through the coordinator's normal
//     (non-forced) destroy control.
//   - Every failure path records the retained state and exits non-zero. Nothing
//     here destroys anything it has not proven.
//   - Host credentials are never printed. Errors are passed through the project's
//     own Redactor BEFORE they are truncated, so a secret that straddles the
//     truncation boundary cannot be partially revealed.
//   - The private database path is FORCED under an explicit private evidence
//     directory (mode 0700, files 0600). It is never inherited from the host
//     environment, so this runner cannot open the live Swarmforge database.
//   - The report is written under the evidence directory with mode 0600. An
//     existing report is preserved to an immutable backup that this run never
//     rewrites, and this run's own report is a separate file, so no run can
//     destroy another's evidence.
//
// GIT DURABILITY PROVENANCE
//
//   Ownership of the guest stays with its original worker. This runner never
//   claims authorship, never fabricates a verified result and never bypasses an
//   existing Git guard. `branchFor` derives a branch from team/task/worker, so a
//   private record minted with a fresh worker id would name a branch that does not
//   exist on the guest. Instead the real identity and the real handoff are read
//   from a read-only snapshot the lead captured, and the branch computed from that
//   identity is cross-checked against the branch the real result reported; a
//   mismatch refuses the run. `inspectPersistence` is branch-agnostic by design and
//   checks the real workspace either way.
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
//
// RE-RUNS
//
// A second run is safe and independent. It adopts the same retained VM, spawns a
// FRESH worker with a fresh private database and artifact store, writes its own
// report, and preserves the previous report into an immutable backup. The only
// thing two runs share is the target VM, and a run that finds the VM already gone
// refuses rather than inventing a new one.

import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  constants,
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
import { branchFor } from "../src/git-handoff";
import { FreestyleProvider } from "../src/providers/freestyle";
import { inspectPersistence } from "../src/safety";
import { redactorFor } from "../src/security";
import { Store } from "../src/store";

// The single VM this runner may address, and the worker that owns it.
//
// The earlier retained research VM (vm-f5291240e51a4432a1556387bb9ab20b) and the
// older validation VM have both been destroyed externally, so neither can be
// targeted any more. The target is now the existing DATA-plane owner fixture, whose
// owner must have finished all of its code, source and reports durably before the
// lead executes this runner against it.
const PROOF_VM = "vm-debbc6d8e4cf4705ba96574c8f1ac519";
const PROOF_WORKER = "w-c6875611-3237-4c55-aa4b-8e5c047e6efb";
/** The workspace-relative findings document this task is expected to produce. */
const FIXTURE_PATH = ".swarmforge/artifacts/findings.json";
const LARGE_FIXTURE_PATH = ".swarmforge/artifacts/findings-large.bin";
const LARGE_MIB = 32;
/** Comfortably larger than any MCP inline read, which is bounded at 32 KiB. */
const LARGE_BYTES = LARGE_MIB * 1024 * 1024;

interface Options {
  execute: boolean;
  evidenceDir?: string;
  destroy: boolean;
  large: boolean;
  /** Read-only, already-captured snapshot of the live database, or absent. */
  provenanceDb?: string;
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
    else if (flag === "--provenance-db") out.provenanceDb = value(i++, flag);
    // There is deliberately no --vm and no --worker: the target is a constant, not
    // an option, so no argument can retarget this runner at any other guest.
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
      "       bun scripts/artifact-salvage-real-proof.ts --execute --evidence-dir <dir> --provenance-db <snapshot.sqlite> [--destroy-proven-fixture]",
      "",
      "Plan mode is the default and touches no credential and no guest.",
      `VM ${PROOF_VM} is a constant; there is no --vm and no --worker.`,
      "Destruction is never forced.",
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

export function privateDir(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {}
  return dir;
}

/**
 * Preserve, never clobber. An earlier report is copied ONCE into its own backup
 * and that backup is then immutable: nothing in this run ever writes to the
 * returned path, so the bytes that were on disk when the run started are still
 * readable afterwards.
 *
 * The backup name carries the run's unique stamp, so two runs in the same
 * millisecond get distinct backups rather than one overwriting the other, and
 * COPYFILE_EXCL turns any remaining collision into a refusal instead of a silent
 * overwrite.
 */
export function preserveExisting(report: string, stamp: string): string | null {
  if (!existsSync(report)) return null;
  const kept = `${report}.${stamp}.bak`;
  try {
    copyFileSync(report, kept, constants.COPYFILE_EXCL);
    chmodSync(kept, 0o600);
    return kept;
  } catch {
    return null;
  }
}

/**
 * This run's own report file, plus the newest-report pointer. The run's report is
 * a DISTINCT file, so a later run cannot overwrite an earlier run's report, and
 * the pointer is only ever written after the previous report has been preserved
 * to an immutable backup. Neither write touches `keptReport`.
 */
export function writeRunReports(reports: {
  pointer: string;
  run: string;
  body: string;
}) {
  writeFileSync(reports.run, reports.body, { mode: 0o600 });
  writeFileSync(reports.pointer, reports.body, { mode: 0o600 });
}

/**
 * The private database and artifact-store locations for one run. Both are derived
 * from the evidence directory alone. Nothing here consults the environment, so an
 * inherited SWARMFORGE_DB_PATH pointing at the live Swarmforge database cannot be
 * picked up, and every path is inside the private evidence directory.
 */
export function privateRunPaths(evidenceDir: string, runStamp: string) {
  const dbPath = join(evidenceDir, `proof-${runStamp}.sqlite`);
  const artifactDir = join(evidenceDir, `artifacts-${runStamp}`);
  const snapshot = join(evidenceDir, `proof-${runStamp}.sqlite.snapshot`);
  if (!dbPath.startsWith(`${evidenceDir}/`))
    throw new ProofFailure(
      `refusing a private database outside the evidence directory: ${dbPath}`,
    );
  if (!artifactDir.startsWith(`${evidenceDir}/`))
    throw new ProofFailure(
      `refusing a private artifact store outside the evidence directory: ${artifactDir}`,
    );
  return { dbPath, artifactDir, snapshot };
}

/**
 * Drain a byte stream and finalize its digest EXACTLY ONCE.
 *
 * `Hash.digest()` finalizes the hash; a second call throws
 * ERR_CRYPTO_HASH_FINALIZED. Finalizing once here and returning the single value
 * means callers assert against a real string instead of accidentally digesting
 * again, which is the defect this helper exists to prevent.
 */
export async function digestStream(
  stream: AsyncIterable<Uint8Array>,
  hash: ReturnType<typeof createHash> = createHash("sha256"),
): Promise<{ bytes: number; sha256: string }> {
  let bytes = 0;
  for await (const part of stream) {
    hash.update(part);
    bytes += part.byteLength;
  }
  return { bytes, sha256: hash.digest("hex") };
}

/**
 * The Git durability provenance this run will rely on, read from a read-only
 * snapshot of the live database that the lead captured beforehand.
 */
export interface Provenance {
  /** team_id / task_id / worker_id exactly as the original owner recorded them. */
  team_id: string;
  task_id: string;
  worker_id: string;
  /** The branch `branchFor` computes from that identity. */
  branch: string;
  /** The branch the real run reports, as recorded in the real result. */
  reported_branch: string | null;
  /** The real result's git block, or null when the snapshot has no result. */
  git: Record<string, unknown> | null;
  /** run_id of the real worker's newest dispatch, when the snapshot has one. */
  latest_run_id: string | null;
  latest_state: string | null;
  latest_persisted: boolean;
  /** The vm_id the snapshot records for that worker. */
  vm_id: string | null;
}

/**
 * Read the ORIGINAL owner's Git durability provenance from an already-captured
 * snapshot, read-only.
 *
 * Nothing here writes to, migrates or checkpoints the snapshot: it is opened
 * `readonly: true`, so the live database is neither read under a mutating
 * connection nor modified. Every value is copied verbatim from the snapshot; this
 * function never invents, defaults or upgrades a value. In particular
 * `git.persisted` is reported exactly as stored: if the original owner's handoff
 * was never verified, `latest_persisted` is false and the destroy phase must
 * refuse rather than proceed.
 *
 * The identity matters because `branchFor` derives the branch from
 * team/task/worker. A private record minted with a fresh worker id would compute a
 * branch that does not exist on the guest, so `pushBranch`'s
 * `git branch --show-current = branchFor(w)` assertion could not be about the
 * branch the real work actually published. Reading the real identity keeps the
 * destroy path pointed at the actual published branch.
 */
export function readProvenance(
  snapshotPath: string,
  expectedWorker: string,
  expectedVm: string,
): Provenance {
  if (!existsSync(snapshotPath))
    throw new ProofFailure(`provenance snapshot not found: ${snapshotPath}`);
  let db: Database;
  try {
    db = new Database(snapshotPath, { readonly: true });
  } catch (error) {
    throw new ProofFailure(
      `cannot open the provenance snapshot read-only: ${identityError(error)}`,
    );
  }
  try {
    const row = db
      .query("SELECT body FROM workers WHERE worker_id=?")
      .get(expectedWorker) as { body: string } | null;
    if (!row)
      throw new ProofFailure(
        `the snapshot has no record for ${expectedWorker}; refusing to invent one`,
      );
    const worker = JSON.parse(row.body) as Worker;
    if (worker.vm_id !== expectedVm)
      throw new ProofFailure(
        `snapshot records ${worker.worker_id} on ${String(worker.vm_id)}, not ${expectedVm}`,
      );
    // A WorkerResult is not its own table: it rides on the dispatch row. Read the
    // dispatches newest-first, exactly as `Store.result` does, so the value here is
    // the same one the production handoff gate would see.
    const dispatchRows = db
      .query(
        "SELECT body FROM dispatches WHERE worker_id=? ORDER BY rowid DESC",
      )
      .all(expectedWorker) as { body: string }[];
    const parsed = dispatchRows
      .map((r) => JSON.parse(r.body) as Dispatch)
      .find((d) => d.result !== null);
    const latest = dispatchRows[0]
      ? (JSON.parse(dispatchRows[0].body) as Dispatch)
      : null;
    const result = parsed?.result ?? null;
    const provenance: Provenance = {
      team_id: worker.team_id,
      task_id: worker.task_id,
      worker_id: worker.worker_id,
      branch: branchFor(worker),
      reported_branch:
        typeof result?.git?.branch === "string" ? result.git.branch : null,
      git: (result?.git as Record<string, unknown> | undefined) ?? null,
      latest_run_id: latest?.run_id ?? null,
      latest_state: latest?.state ?? null,
      latest_persisted: result?.git?.persisted === true,
      vm_id: worker.vm_id,
    };
    // Truthfulness cross-check. The branch this run would act on must be the
    // branch the real run actually reported, or the durability proof would be
    // about some other branch and is refused instead of being run.
    if (
      provenance.reported_branch !== null &&
      provenance.reported_branch !== provenance.branch
    )
      throw new ProofFailure(
        `provenance branch mismatch: identity computes ${provenance.branch} but the real result reports ${provenance.reported_branch}`,
      );
    return provenance;
  } finally {
    db.close();
  }
}
/** Errors about record identity carry no host data, so they need no redaction. */
const identityError = (value: unknown) =>
  (value instanceof Error ? value.message : String(value)).slice(0, 200);
async function main(opts: Options) {
  // There is no --vm and no --worker, so the target cannot be chosen by a caller.
  // These asserts only guard against a future edit that reintroduces a target.
  if (PROOF_VM !== "vm-debbc6d8e4cf4705ba96574c8f1ac519")
    throw new ProofFailure(`unexpected proof VM constant ${PROOF_VM}`);
  if (PROOF_WORKER !== "w-c6875611-3237-4c55-aa4b-8e5c047e6efb")
    throw new ProofFailure(`unexpected proof worker constant ${PROOF_WORKER}`);
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
            "read the original owner's handoff from a read-only provenance snapshot",
            "normal (never forced) destroy only with --destroy-proven-fixture and a snapshot",
            "re-read and re-verify the bytes after the VM is actually deleted",
          ],
          target_is_constant: "there is no --vm and no --worker",
          new_guest: "none; the retained VM is adopted, never provisioned",
          provenance:
            "read-only snapshot only; no live database is opened or written",
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
  // Each run owns a distinct report, so a re-run never overwrites an earlier
  // report's file. The canonical name is preserved to an immutable backup and
  // then used only as a pointer at the newest report.
  const runStamp = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const runReport = join(
    evidenceDir,
    `artifact-salvage-real-proof.${runStamp}.json`,
  );
  const keptReport = preserveExisting(report, runStamp);
  const evidence = new Evidence(join(evidenceDir, "real-proof.jsonl"));
  evidence.event("run_started", {
    vm: PROOF_VM,
    worker: PROOF_WORKER,
    destroy_proven_fixture: opts.destroy,
    large_binary: opts.large,
    run_stamp: runStamp,
    report: basename(runReport),
    preserved_previous_report: keptReport ? basename(keptReport) : null,
  });

  // The private database and private artifact store live under the explicit
  // evidence directory. The database path is FORCED: it is never inherited from
  // the environment, because SWARMFORGE_DB_PATH in the host environment points at
  // the live SwarmForge database and this runner must never open, migrate or
  // write it.
  const { dbPath, artifactDir, snapshot } = privateRunPaths(
    evidenceDir,
    runStamp,
  );
  const config = loadConfig({
    // `loadConfig`'s env argument defaults to `process.env` ONLY when it is omitted
    // entirely. Passing a partial object therefore does not fall back to the host
    // environment, it just fails validation, because FREESTYLE_API_TOKEN,
    // FREESTYLE_SNAPSHOT_ID, SWARMFORGE_MODEL_API_KEY and SWARMFORGE_MODEL_NAME are
    // mandatory with no default. So the whole host environment is spread in first
    // and the two private paths are FORCED over it afterwards.
    ...process.env,
    SWARMFORGE_DB_PATH: dbPath,
    SWARMFORGE_ARTIFACT_DIR: artifactDir,
  });
  if (config.SWARMFORGE_DB_PATH !== dbPath)
    throw new ProofFailure(
      `private database path was not honoured: ${config.SWARMFORGE_DB_PATH}`,
    );
  if (config.SWARMFORGE_ARTIFACT_DIR !== artifactDir)
    throw new ProofFailure(
      `private artifact directory was not honoured: ${config.SWARMFORGE_ARTIFACT_DIR}`,
    );
  privateDir(artifactDir);
  const provider = new FreestyleProvider(config);
  const store = new Store(config.SWARMFORGE_DB_PATH);
  const agent = new MalformedHandoffAgent();
  const coordinator = new Coordinator(config, store, provider, agent);
  const redact = (text: string) => redactorFor(coordinator).text(text);
  const finished: Record<string, unknown> = {
    mode: "real",
    vm: PROOF_VM,
    worker: PROOF_WORKER,
    run_stamp: runStamp,
    report: basename(runReport),
    preserved_previous_report: keptReport ? basename(keptReport) : null,
  };

  try {
    const vm: VmInfo | null = await provider.getWorker(PROOF_VM);
    if (!vm) throw new ProofFailure(`VM ${PROOF_VM} is not reachable`);
    if (vm.id !== PROOF_VM)
      throw new ProofFailure(`provider answered a different VM (${vm.id})`);
    evidence.event("vm_reachable", { vm_state: vm.state });

    // 1. OpenCode is stopped through the provider, using the coordinator's own
    //    command, and its absence is confirmed rather than assumed.
    const stop = await provider.exec(
      PROOF_VM,
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
      .ref(PROOF_VM)
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
        .ref(PROOF_VM)
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
      task_id: `real-proof-${runStamp}`,
      role: "coder",
      prompt: "salvage proof: the workspace must survive this worker",
      timeout_seconds: 300,
      artifacts: [{ path: FIXTURE_PATH, required: true }],
    });
    // Adopt the retained VM instead of provisioning one: the record is patched
    // straight to ready, so no new guest is ever created.
    store.patch(spawned.worker_id, {
      state: "ready",
      vm_id: PROOF_VM,
      opencode_session_id: `ses-${PROOF_WORKER}`,
      started_at: Date.now(),
    });
    evidence.event("worker_adopted_vm", {
      worker_id: spawned.worker_id,
      vm_id: PROOF_VM,
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
    //
    //    `inspectPersistence` is branch-agnostic on purpose: it walks every
    //    repository under the roots and requires a clean tree plus every local
    //    branch tip reachable from a remote ref. It therefore checks the REAL
    //    workspace no matter which record is passed, which is why passing this
    //    run's private adopted worker does not weaken it.
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
        { retained_vm: PROOF_VM, state: settled.state },
      );

    // 6b. Provenance. Destroying a guest is a real act, so it may only proceed
    //     against a handoff that was REALLY verified. The snapshot is read-only
    //     and only ever supplies values it already holds; if the original owner's
    //     newest dispatch is not a completed run carrying git.persisted === true,
    //     this refuses. Nothing here fabricates a verified result, and the
    //     production handoff gate inside the coordinator still runs unchanged on
    //     top of this.
    if (opts.provenanceDb) {
      const provenance = readProvenance(
        opts.provenanceDb,
        PROOF_WORKER,
        PROOF_VM,
      );
      evidence.event("provenance_read", {
        source: "read-only snapshot",
        worker_id: provenance.worker_id,
        team_id: provenance.team_id,
        task_id: provenance.task_id,
        branch: provenance.branch,
        reported_branch: provenance.reported_branch,
        latest_run_id: provenance.latest_run_id,
        latest_state: provenance.latest_state,
        latest_persisted: provenance.latest_persisted,
      });
      finished.provenance = {
        worker_id: provenance.worker_id,
        branch: provenance.branch,
        reported_branch: provenance.reported_branch,
        latest_state: provenance.latest_state,
        latest_persisted: provenance.latest_persisted,
      };
      if (!opts.destroy) return;
      if (
        provenance.latest_state !== "completed" ||
        !provenance.latest_persisted
      )
        throw new ProofFailure(
          `refusing to destroy: ${PROOF_WORKER}'s newest dispatch is ${String(provenance.latest_state)} with git.persisted=${provenance.latest_persisted}, so no verified handoff exists`,
          { retained_vm: PROOF_VM, state: settled.state },
        );
    } else if (opts.destroy) {
      throw new ProofFailure(
        "--destroy-proven-fixture requires --provenance-db <read-only snapshot>, so the handoff is checked against the original owner's real record",
        { retained_vm: PROOF_VM, state: settled.state },
      );
    }

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
        { retained_vm: PROOF_VM, state: destroyed.state },
      );
    const gone = await provider.getWorker(PROOF_VM);
    evidence.event("vm_deleted", { provider_still_reports_vm: Boolean(gone) });
    if (gone)
      throw new ProofFailure(
        "the VM is still reported after destruction; the proof is incomplete",
        { retained_vm: PROOF_VM },
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
      // Exactly one digest. A Hash is finalized by its first digest() call, so a
      // second call to compare would throw ERR_CRYPTO_HASH_FINALIZED; the value is
      // finalized once, then asserted and emitted from that single result.
      const { bytes, sha256: streamedDigest } = await digestStream(
        streamed as unknown as AsyncIterable<Uint8Array>,
      );
      if (streamedDigest !== largeDigest)
        throw new ProofFailure(
          "the large streamed artifact does not match the bytes uploaded",
          { artifact_id: largeRecord.artifact_id, bytes },
        );
      evidence.event("large_artifact_verified_after_destroy", {
        artifact_id: largeRecord.artifact_id,
        bytes,
        sha256: streamedDigest,
        matches: true,
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
      vm_id: PROOF_VM,
      worker_id: PROOF_WORKER,
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
    // Written last. This run gets its OWN report file, so a second run never
    // overwrites the first run's report; the previous canonical report has already
    // been preserved to an immutable backup above and is not touched again here.
    try {
      const body = `${JSON.stringify(
        {
          ...finished,
          run_stamp: runStamp,
          at: Date.now(),
          evidence: basename(evidence.jsonl),
          private_db: basename(dbPath),
        },
        null,
        2,
      )}\n`;
      writeRunReports({ pointer: report, run: runReport, body });
    } catch {}
    // The private store runs in WAL mode, so an abrupt exit could leave committed
    // work in the -wal file rather than in the database the lead reads. Fold the
    // WAL back in, then take one consistent private snapshot.
    try {
      store.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } catch {}
    try {
      if (existsSync(dbPath)) {
        copyFileSync(dbPath, snapshot, constants.COPYFILE_EXCL);
        chmodSync(snapshot, 0o600);
      }
    } catch {}
    store.close();
  }
}

// Only run the proof when this file is the entry point. Importing it exposes the
// helpers above for tests without touching a credential, a VM or the filesystem.
if (import.meta.main) {
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
}
