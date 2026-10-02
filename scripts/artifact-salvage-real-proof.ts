#!/usr/bin/env bun

// Real coordinator-host proof runner for durable artifact retrieval and worker salvage.
//
// This is the only file this worker owns. It changes no production code and no
// other worker's script or test.
//
// WHAT IT PROVES, ON A REAL FREESTYLE VM, WITH NO MODEL INVOLVED
//
//   0. The ORIGINAL owner's newest dispatch is read from a read-only provenance
//      snapshot and gated on BEFORE the first byte of guest mutation: exact target,
//      owner finished, source verified, clean published branch, and a FRESH actual
//      provider status. A plain `--execute` used to stop OpenCode and write the
//      fixture with no snapshot at all, and only a destroy run read provenance, and
//      only after those mutations.
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
//      and the bytes are re-read as ONE bounded, streamed digest through the raw
//      private path.
//   6. The existing Git durability gate runs against the real workspace.
//   7. ONLY with --destroy-proven-fixture, --execute AND a provenance snapshot AND
//      every gate in step 0, the ORIGINAL OWNER's record is destroyed through the
//      coordinator's normal (non-force) destroy control, on a private copy of the
//      snapshot, on the SAME fixed VM. That path enforces the existing Git
//      durability checks, so a dirty or unpushed primary source refuses and the VM
//      is retained.
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
//     provenance snapshot AND the step-0 gates, and it always goes through the
//     coordinator's normal (non-forced) destroy control against the original
//     owner's own record.
//   - Every failure path records the retained state and exits non-zero. Nothing
//     here destroys anything it has not proven, and an evidence-write, checkpoint
//     or snapshot failure is reported and forced to a non-zero exit rather than
//     being swallowed.
//   - Host credentials are never printed. Errors are passed through the project's
//     own Redactor BEFORE they are truncated, so a secret that straddles the
//     truncation boundary cannot be partially revealed.
//   - The private database path is FORCED under an explicit private evidence
//     directory (mode 0700, files 0600). It is never inherited from the host
//     environment, so this runner cannot open the live Swarmforge database, and the
//     destruction phase opens only its own private COPY of the snapshot.
//   - The default evidence directory is a private temporary directory, not a path
//     inside the working tree, so no run scatters a private database or an audit
//     trail into a checkout that does not ignore it.
//   - The report is written under the evidence directory with mode 0600. An
//     existing report is preserved to an immutable backup that this run never
//     rewrites, and this run's own report and evidence file are per-run, so no run
//     can destroy another's evidence.
//
// GIT DURABILITY PROVENANCE
//
//   Ownership of the guest stays with its original worker. This runner never
//   claims authorship, never fabricates a verified result and never bypasses an
//   existing Git guard. `branchFor` derives a branch from team/task/worker, so a
//   private record minted with a fresh worker id would name a branch that does not
//   exist on the guest. Instead the real identity and the real handoff are read
//   from a read-only snapshot the lead captured, and the branch computed from that
//   identity is cross-checked against the branch the owner's NEWEST dispatch
//   reported; a mismatch refuses the run. The result is read from that newest
//   dispatch alone, never from an older one that happened to be verified.
//   `inspectPersistence` is branch-agnostic by design and checks the real workspace
//   either way.
//
// USAGE
//
//   bun scripts/artifact-salvage-real-proof.ts                              # plan only
//   bun scripts/artifact-salvage-real-proof.ts --execute \
//     --provenance-db /private/path/snapshot.sqlite
//   bun scripts/artifact-salvage-real-proof.ts --execute \
//     --provenance-db /private/path/snapshot.sqlite --destroy-proven-fixture
//
// Plan mode is the default and touches no credential, no network and no guest.
// Real mode needs the host environment already configured for SwarmForge; this
// script never requests, sends or logs host infrastructure secrets.
//
// RE-RUNS
//
// A second run is safe and independent. It adopts the same retained VM, spawns a
// FRESH worker with a fresh private database and artifact store, writes its own
// report and its own evidence file, and preserves the previous report into an
// immutable backup. The only thing two runs share is the target VM, and a run that
// finds the VM already gone refuses rather than inventing a new one.

import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openAsBlob,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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
      "       bun scripts/artifact-salvage-real-proof.ts --execute --provenance-db <snapshot.sqlite> --evidence-dir <dir> [--with-large-binary]",
      "       bun scripts/artifact-salvage-real-proof.ts --execute --provenance-db <snapshot.sqlite> --evidence-dir <dir> --destroy-proven-fixture",
      "",
      "Plan mode is the default and touches no credential and no guest.",
      `VM ${PROOF_VM} is a constant; there is no --vm and no --worker.`,
      "--execute REQUIRES --provenance-db: the owner's finished, source-verified record is read before any guest mutation.",
      "Destruction is never forced, and acts on the ORIGINAL owner's copied record, not on this run's salvage record.",
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

/**
 * One redacted, bounded evidence line, in a PER-RUN private file.
 *
 * The file name carries the run stamp, so two runs never append to one another's
 * evidence, and it is created 0600. An append failure is recorded and re-raised
 * on the next `assertHealthy`, rather than swallowed: silently losing the audit
 * trail while the run reports success is exactly the failure mode this replaces.
 */
export class Evidence {
  private readonly lines: string[] = [];
  /** Append failures, reported instead of being swallowed. */
  readonly writeFailures: string[] = [];
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
    } catch (error) {
      this.writeFailures.push(
        `${name}: ${(error instanceof Error ? error.message : String(error)).slice(0, 160)}`,
      );
    }
  }
  /**
   * Evidence that could not be written makes the run a failure. A missing line is
   * not a cosmetic problem when the line is the only record of what was done to a
   * guest.
   */
  assertHealthy() {
    if (this.writeFailures.length)
      throw new ProofFailure(
        `evidence could not be written to ${this.path}: ${this.writeFailures.join("; ")}`,
      );
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

/**
 * The narrow slice of the data plane and finalization surface this runner uses.
 *
 * It is declared here, not reimplemented here. The concrete `Coordinator` in the
 * combined disposable (data plane `c5cfff6d`, life `3244def1`, manager APIs
 * `2fdf8139`) really provides every member below; on a checkout without those
 * packages the type simply adds nothing the class does not have, and
 * `assertDataPlane` refuses at run time rather than pretending. Nothing is
 * `any`, nothing is re-derived, and no production guard is bypassed by declaring
 * the surface.
 */
export interface FinalizationState {
  state?: string | null;
  attempts?: number | null;
  error?: string | null;
  run_id?: string | null;
}
export interface ArtifactListEntry {
  artifact_id: string;
  original_path: string;
  state: string;
  sha256: string | null;
  size: number;
  error?: string | null;
}
export interface DataPlane {
  artifacts: {
    list(query: { worker_id: string; limit: number }): {
      artifacts: ArtifactListEntry[];
    };
    metadata(id: string): ArtifactListEntry;
    download(id: string): Promise<ReadableStream<Uint8Array>>;
  };
  finalize(id: string): Promise<{ finalization?: FinalizationState | null }>;
}
export type ProofCoordinator = Coordinator & DataPlane;

/**
 * Refuse rather than half-run. `finalize` and `artifacts` live in the data plane
 * and lifecycle packages; if the checkout under this runner does not carry them,
 * the salvage phase is simply unavailable and the run says so instead of
 * reporting a proof it did not produce.
 */
export function assertDataPlane(
  coordinator: Coordinator,
): asserts coordinator is Coordinator & DataPlane {
  const candidate = coordinator as Partial<DataPlane>;
  const missing = [
    ["artifacts", candidate.artifacts],
    ["finalize", candidate.finalize],
  ]
    .filter(([, value]) => value === undefined)
    .map(([name]) => name);
  if (missing.length)
    throw new ProofFailure(
      `this checkout does not provide the data plane (${missing.join(", ")}); run the salvage proof against the combined disposable`,
    );
}

export function privateDir(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {}
  return dir;
}

/**
 * The coordinator-private artifact storage root, which the data plane owns. It is
 * read through a declared lookup rather than a direct property so this runner
 * typechecks on a checkout that does not carry the data plane's config schema,
 * and it REFUSES when the key is absent rather than inventing a location.
 */
export function privateArtifactDir(config: unknown): string {
  const value = (config as Record<string, unknown>).SWARMFORGE_ARTIFACT_DIR;
  if (typeof value !== "string" || value.length === 0)
    throw new ProofFailure(
      "SWARMFORGE_ARTIFACT_DIR is not configured; the private artifact store cannot be located",
    );
  return value;
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
 * The private database, artifact-store and owner-copy locations for one run. All
 * are derived from the evidence directory alone. Nothing here consults the
 * environment, so an inherited SWARMFORGE_DB_PATH pointing at the live Swarmforge
 * database cannot be picked up, and every path is inside the private evidence
 * directory.
 *
 * `destructionDb` is the private COPY the owner destruction phase opens. It is a
 * separate file from `dbPath`, so the proof's own salvage record and the
 * original owner's record never share a database.
 */
export function privateRunPaths(evidenceDir: string, runStamp: string) {
  const dbPath = join(evidenceDir, `proof-${runStamp}.sqlite`);
  const artifactDir = join(evidenceDir, `artifacts-${runStamp}`);
  const snapshot = join(evidenceDir, `proof-${runStamp}.sqlite.snapshot`);
  const destructionDb = join(evidenceDir, `owner-${runStamp}.sqlite`);
  for (const [label, path] of [
    ["database", dbPath],
    ["artifact store", artifactDir],
    ["snapshot", snapshot],
    ["owner copy", destructionDb],
  ] as const) {
    if (!path.startsWith(`${evidenceDir}/`))
      throw new ProofFailure(
        `refusing a private ${label} outside the evidence directory: ${path}`,
      );
  }
  return { dbPath, artifactDir, snapshot, destructionDb };
}

/**
 * The default evidence directory: a private `mkdtemp` under the system temp
 * directory. It is deliberately NOT `<repo>/.swarmforge/artifacts`: this
 * repository does not ignore `.swarmforge`, so a default inside the working tree
 * would scatter untracked evidence and a private database into a working
 * checkout. Nothing is created in plan mode.
 */
export function defaultEvidenceDir(): string {
  return privateDir(mkdtempSync(join(tmpdir(), "swarmforge-real-proof-")));
}

/**
 * One bounded, streamed digest of a whole stored artifact.
 *
 * `ArtifactService.read` refuses any length over its 32 KiB cap, and it would
 * allocate the whole object even below it. The proof only ever needs the digest
 * of the bytes it generated, so the whole-object stream is drained and finalized
 * once. This is the ONLY place a stored artifact is turned into a hash, which is
 * why a second `digest()` call can never appear.
 */
export async function streamedArtifactDigest(
  artifacts: { download(id: string): Promise<ReadableStream<Uint8Array>> },
  artifactId: string,
): Promise<{ bytes: number; sha256: string }> {
  return digestStream(await artifacts.download(artifactId));
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
 *
 * Every field describes the owner's NEWEST dispatch, and nothing else. There is
 * deliberately no "most recent verified result" field: that is the value this
 * read used to compute by walking backwards, and mixing it with the newest
 * dispatch's state is what let an unverified latest run inherit an older
 * verified handoff.
 */
export interface Provenance {
  /** team_id / task_id / worker_id exactly as the original owner recorded them. */
  team_id: string;
  task_id: string;
  worker_id: string;
  /** The branch `branchFor` computes from that identity. */
  branch: string;
  /** The branch the newest dispatch's result reported, or null when it has none. */
  reported_branch: string | null;
  /** The newest dispatch's git block, or null when that dispatch has no result. */
  git: Record<string, unknown> | null;
  /** run_id of the newest dispatch, when the snapshot has one. */
  latest_run_id: string | null;
  /** state of the NEWEST dispatch. Never an older dispatch's state. */
  latest_state: string | null;
  /** git.persisted of the NEWEST dispatch, verbatim. Never upgraded. */
  latest_persisted: boolean;
  /** How many dispatch rows the snapshot holds for this worker. */
  dispatch_count: number;
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
    // dispatches newest-first, exactly as `Store.dispatch` does, so the newest row
    // here is the one the production handoff gate looks at.
    //
    // The result is derived from that ONE row and from no other. The defect this
    // replaces searched backwards for the newest row that happened to carry a
    // result, so a newest dispatch with `result: null` sitting next to an OLDER
    // verified dispatch produced `latest_state: "completed"` and
    // `latest_persisted: true` out of two different rows, and the destroy phase
    // acted on a verified handoff that was not the owner's latest one. Nothing is
    // searched, defaulted or upgraded here.
    const dispatchRows = db
      .query(
        "SELECT body FROM dispatches WHERE worker_id=? ORDER BY rowid DESC",
      )
      .all(expectedWorker) as { body: string }[];
    const latest = dispatchRows[0]
      ? (JSON.parse(dispatchRows[0].body) as Dispatch)
      : null;
    const result = latest?.result ?? null;
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
      dispatch_count: dispatchRows.length,
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

/**
 * The authoritative owner gate. It runs BEFORE any guest mutation, and every
 * check here is about the ORIGINAL owner's real record, never this run's own
 * private record.
 *
 * Each condition is separately reported, so a refusal names the one fact that was
 * not true instead of a generic "unsafe". Nothing is defaulted, inferred or
 * upgraded: `latest_persisted` is the newest dispatch's stored value, full stop.
 */
export interface OwnerGate {
  ok: boolean;
  /** Machine-readable precondition that failed, or null when the gate passed. */
  failed: string | null;
  detail: string | null;
}

export function ownerGate(provenance: Provenance): OwnerGate {
  if (provenance.worker_id !== PROOF_WORKER) {
    return {
      ok: false,
      failed: "identity",
      detail: `snapshot identity is ${provenance.worker_id}, not ${PROOF_WORKER}`,
    };
  }
  if (provenance.vm_id !== PROOF_VM) {
    return {
      ok: false,
      failed: "target",
      detail: `snapshot records the owner on ${String(provenance.vm_id)}, not ${PROOF_VM}`,
    };
  }
  if (provenance.latest_state !== "completed") {
    return {
      ok: false,
      failed: "owner_finished",
      detail: `the owner's newest dispatch (${String(provenance.latest_run_id)}) is ${String(provenance.latest_state)}, not completed`,
    };
  }
  if (!provenance.latest_persisted) {
    return {
      ok: false,
      failed: "source_unverified",
      detail: `the owner's newest dispatch carries git.persisted=${provenance.latest_persisted}, so no verified handoff exists`,
    };
  }
  if (provenance.reported_branch !== provenance.branch) {
    return {
      ok: false,
      failed: "branch_mismatch",
      detail: `identity computes ${provenance.branch} but the newest result reports ${String(provenance.reported_branch)}`,
    };
  }
  if (provenance.dispatch_count < 1) {
    return {
      ok: false,
      failed: "no_dispatch",
      detail: "the snapshot holds no dispatch for the owner",
    };
  }
  return { ok: true, failed: null, detail: null };
}

/** Throw the gate's own refusal, so one message shape reaches the report. */
export function assertOwnerGate(provenance: Provenance): void {
  const gate = ownerGate(provenance);
  if (gate.ok) return;
  throw new ProofFailure(
    `refusing before any guest mutation: ${String(gate.failed)}: ${String(gate.detail)}`,
    { retained_vm: PROOF_VM, gate: gate.failed },
  );
}

/**
 * A FRESH provider observation, taken immediately before the first guest
 * mutation. The snapshot only says what was true when the lead captured it; this
 * says what is true now, from the real provider, and refuses on an id mismatch
 * rather than proceeding against whatever answered.
 */
export function assertProviderTarget(vm: VmInfo | null): VmInfo {
  if (!vm) throw new ProofFailure(`VM ${PROOF_VM} is not reachable`);
  if (vm.id !== PROOF_VM)
    throw new ProofFailure(`provider answered a different VM (${vm.id})`);
  return vm;
}

/**
 * A private, per-run COPY of the read-only provenance snapshot. The snapshot
 * itself is only ever opened `readonly: true`, and this copy is the sole database
 * the destruction phase opens, so the live Swarmforge database is never opened,
 * migrated or written. `COPYFILE_EXCL` turns a name collision into a refusal
 * instead of a silent overwrite of a previous run's copy.
 */
export function privateOwnerCopy(snapshotPath: string, destPath: string): string {
  if (!existsSync(snapshotPath))
    throw new ProofFailure(`provenance snapshot not found: ${snapshotPath}`);
  try {
    copyFileSync(snapshotPath, destPath, constants.COPYFILE_EXCL);
  } catch (error) {
    throw new ProofFailure(
      `cannot make the private owner copy: ${identityError(error)}`,
    );
  }
  try {
    chmodSync(destPath, 0o600);
  } catch (error) {
    throw new ProofFailure(
      `cannot make the private owner copy private: ${identityError(error)}`,
    );
  }
  return destPath;
}

/**
 * Re-verify the private copy AFTER it has been opened, so the destruction phase
 * cannot act on a copy that is not byte-for-byte the same record the gate just
 * approved. A stale or doctored copy is refused, never repaired.
 */
export function assertOwnerCopyUnchanged(
  copied: Provenance,
  approved: Provenance,
): void {
  const same = (field: keyof Provenance) =>
    JSON.stringify(copied[field]) === JSON.stringify(approved[field]);
  for (const field of [
    "worker_id",
    "team_id",
    "task_id",
    "vm_id",
    "branch",
    "reported_branch",
    "latest_run_id",
    "latest_state",
    "latest_persisted",
    "dispatch_count",
  ] as const) {
    if (!same(field))
      throw new ProofFailure(
        `the private owner copy does not match the approved provenance: ${field} is ${JSON.stringify(copied[field])}, approved ${JSON.stringify(approved[field])}`,
        { retained_vm: PROOF_VM, field },
      );
  }
}

async function main(opts: Options) {
  // There is no --vm and no --worker, so the target cannot be chosen by a caller.
  // These asserts only guard against a future edit that reintroduces a target.
  if (PROOF_VM !== "vm-debbc6d8e4cf4705ba96574c8f1ac519")
    throw new ProofFailure(`unexpected proof VM constant ${PROOF_VM}`);
  if (PROOF_WORKER !== "w-c6875611-3237-4c55-aa4b-8e5c047e6efb")
    throw new ProofFailure(`unexpected proof worker constant ${PROOF_WORKER}`);
  if (opts.destroy && !opts.execute)
    throw new ProofFailure("--destroy-proven-fixture requires --execute");
  // H2: the authoritative owner gate is not a destroy-only extra. ANY real run
  // mutates the guest, so ANY real run needs the truthful read-only provenance
  // snapshot first. Previously a plain `--execute` stopped OpenCode and wrote
  // bytes with no snapshot at all, and the snapshot was only consulted when
  // destruction had been asked for.
  if (opts.execute && !opts.provenanceDb)
    throw new ProofFailure(
      "--execute requires --provenance-db <read-only snapshot>, so the original owner's finished and source-verified record is read before any guest mutation",
    );
  if (!opts.execute) {
    console.log(
      JSON.stringify(
        {
          mode: "plan",
          note: "no credential, no network and no guest were touched",
          vm: PROOF_VM,
          worker: PROOF_WORKER,
          steps: [
            "read the original owner's newest dispatch from a read-only provenance snapshot",
            "gate: exact target, owner finished, source verified, clean published branch",
            "take a FRESH provider status for the fixed VM before the first mutation",
            "stop OpenCode through the provider",
            `write ${FIXTURE_PATH} over the native SDK filesystem transport`,
            "simulate a malformed handoff as a CodingAgent completion (no LLM)",
            "fresh private Store adopts the VM with a REQUIRED declared artifact",
            "coordinator.tick() then coordinator.finalize()",
            "verify the preserved SHA-256 with a bounded streamed hash",
            "gate on the existing Git durability check; refuse and retain on failure",
            "private COPY of the snapshot; normal (never forced) destroy of the OWNER record",
            "re-read and re-verify the bytes after the VM is actually deleted",
          ],
          target_is_constant: "there is no --vm and no --worker",
          new_guest: "none; the retained VM is adopted, never provisioned",
          provenance:
            "read-only snapshot only; no live database is opened or written",
          destruction:
            "a private copy of the snapshot, the original owner record unchanged, coordinator.control(owner, destroy) with force=false",
          large_binary: `${LARGE_MIB} MiB streamed upload with --with-large-binary`,
        },
        null,
        2,
      ),
    );
    return;
  }

  const evidenceDir = privateDir(opts.evidenceDir ?? defaultEvidenceDir());
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
  // Per run, not one shared file: two concurrent runs used to interleave their
  // lines into a single `real-proof.jsonl` that neither could own afterwards.
  const evidence = new Evidence(
    join(evidenceDir, `real-proof.${runStamp}.jsonl`),
  );
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
  const { dbPath, artifactDir, snapshot, destructionDb } = privateRunPaths(
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
  if (privateArtifactDir(config) !== artifactDir)
    throw new ProofFailure(
      `private artifact directory was not honoured: ${privateArtifactDir(config)}`,
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
  /** IO problems that must not be swallowed, collected and reported at the end. */
  const ioFailures: string[] = [];

  try {
    // 0. THE GATE, before the first guest mutation. Read the ORIGINAL owner's
    //    newest dispatch out of a read-only snapshot and prove that the real work
    //    finished, that its source really is verified, that the branch we would
    //    act on is the branch it published, and that the guest is the fixed one.
    //
    //    This is deliberately step 0. Stopping the service and writing the fixture
    //    are both real mutations of a real guest, and doing either of them before
    //    this gate is exactly what the review flagged.
    const snapshotPath = opts.provenanceDb!;
    const provenance = readProvenance(snapshotPath, PROOF_WORKER, PROOF_VM);
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
      dispatch_count: provenance.dispatch_count,
    });
    finished.provenance = {
      worker_id: provenance.worker_id,
      branch: provenance.branch,
      reported_branch: provenance.reported_branch,
      latest_run_id: provenance.latest_run_id,
      latest_state: provenance.latest_state,
      latest_persisted: provenance.latest_persisted,
      dispatch_count: provenance.dispatch_count,
    };
    const gate = ownerGate(provenance);
    evidence.event("owner_gate", {
      ok: gate.ok,
      failed: gate.failed,
      detail: gate.detail,
    });
    assertOwnerGate(provenance);

    // A FRESH observation from the real provider, not the snapshot's belief about
    // the world, taken immediately before the first mutation.
    const vm: VmInfo = assertProviderTarget(await provider.getWorker(PROOF_VM));
    evidence.event("provider_status_fresh", {
      vm: vm.id,
      vm_state: vm.state,
    });
    finished.provider_status_before_mutation = { vm: vm.id, state: vm.state };

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
        { state: settled.state },
      );
    if (!settled.vm_id || settled.vm_missing)
      throw new ProofFailure(
        "worker VM is not retained; refusing to continue",
        {
          state: settled.state,
        },
      );

    // 5. Finalize, then verify the preserved digest against the bytes generated.
    assertDataPlane(coordinator);
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

    // Re-verify the raw private bytes with ONE bounded, streamed digest. This is
    // not `artifacts.read(id, 0, record.size)`: the data plane caps `read` at
    // 32 KiB and would refuse, and below the cap it would still assemble the whole
    // object in memory. The stream is drained and finalized exactly once.
    const beforeDestroy = await streamedArtifactDigest(
      coordinator.artifacts,
      record.artifact_id,
    );
    if (beforeDestroy.sha256 !== findingsDigest)
      throw new ProofFailure("raw private re-read does not match the fixture");
    if (beforeDestroy.bytes !== record.size)
      throw new ProofFailure(
        `raw private re-read is ${beforeDestroy.bytes} bytes, record says ${record.size}`,
      );
    evidence.event("sha_verified_before_destroy", {
      artifact_id: record.artifact_id,
      bytes: beforeDestroy.bytes,
      sha256: beforeDestroy.sha256,
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

    if (!opts.destroy) {
      finished.result = "proven";
      finished.note = "VM retained; destruction is an explicit operator action";
      evidence.event("proof_complete", finished);
      return;
    }

    // 7. TRUE owner-provenance destruction, on the SAME fixed VM.
    //
    //    The act being justified is deleting a guest the ORIGINAL owner built, so
    //    the record that authorizes it must be the original owner's. The previous
    //    version called `control(spawned.worker_id, "destroy")` on this run's own
    //    private record for the malformed salvage worker, which has no verified
    //    handoff at all: under `SWARMFORGE_GIT_PUSH_MODE=ssh` the production guard
    //    refused and the proof could never complete, and under the host default
    //    `none` the guard is skipped so the run destroyed a record that had never
    //    proven anything. Both are wrong, so this phase acts on the owner.
    //
    //    A private COPY of the read-only snapshot becomes its own database. The
    //    copy holds the real worker and its newest completed verified dispatch
    //    UNCHANGED: no result is fabricated, no dispatch is rewritten, no worker is
    //    minted, and the live database is never opened. A second Coordinator over
    //    that copy runs the normal, never-forced destroy, so the production handoff
    //    guard and `inspectPersistence` both run unchanged.
    const ownerDb = privateOwnerCopy(snapshotPath, destructionDb);
    const ownerStore = new Store(ownerDb);
    let ownerDestroyed: Worker | null = null;
    try {
      const ownerCoordinator = new Coordinator(
        config,
        ownerStore,
        provider,
        new MalformedHandoffAgent(),
      );
      // Re-read the copy through the same read-only reader and require it to be
      // the very record the gate approved. A stale, truncated or doctored copy
      // refuses here instead of being repaired.
      const copiedProvenance = readProvenance(
        ownerDb,
        PROOF_WORKER,
        PROOF_VM,
      );
      assertOwnerCopyUnchanged(copiedProvenance, provenance);
      evidence.event("owner_copy_verified", {
        path: basename(ownerDb),
        mode: "0o600",
        latest_run_id: copiedProvenance.latest_run_id,
        latest_state: copiedProvenance.latest_state,
        latest_persisted: copiedProvenance.latest_persisted,
        unchanged: true,
      });
      // `force` is never passed: the third argument stays false, so the production
      // refusal paths stay reachable and a dirty or unhanded-off guest is kept.
      ownerDestroyed = await ownerCoordinator.control(PROOF_WORKER, "destroy");
      evidence.event("owner_destroy_requested", {
        worker_id: PROOF_WORKER,
        state: ownerDestroyed.state,
        force: false,
        record: "original owner, copied unchanged from the read-only snapshot",
      });
    } finally {
      ownerStore.close();
    }
    if (ownerDestroyed.state !== "destroyed")
      throw new ProofFailure(
        `owner destruction refused (state ${ownerDestroyed.state}): ${bounded(redact, ownerDestroyed.error ?? "")}`,
        { retained_vm: PROOF_VM, state: ownerDestroyed.state },
      );
    const gone = await provider.getWorker(PROOF_VM);
    evidence.event("vm_deleted", { provider_still_reports_vm: Boolean(gone) });
    if (gone)
      throw new ProofFailure(
        "the VM is still reported after destruction; the proof is incomplete",
        { retained_vm: PROOF_VM },
      );

    // 8. The record and its bytes outlive the VM. Re-read and re-verify after the
    //    guest is actually gone, again with one bounded streamed digest.
    const after = coordinator.artifacts.metadata(record.artifact_id);
    const afterStream = await streamedArtifactDigest(
      coordinator.artifacts,
      after.artifact_id,
    );
    if (after.state !== "preserved" || afterStream.sha256 !== findingsDigest)
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
      // Exactly one digest. A Hash is finalized by its first digest() call, so a
      // second call to compare would throw ERR_CRYPTO_HASH_FINALIZED; the value is
      // finalized once, then asserted and emitted from that single result.
      const { bytes, sha256: streamedDigest } = await streamedArtifactDigest(
        coordinator.artifacts,
        largeRecord.artifact_id,
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
      bytes: afterStream.bytes,
      sha256: afterStream.sha256,
    });
    finished.result = "proven";
    finished.destroyed = true;
    finished.destruction = {
      record: "original owner",
      worker_id: PROOF_WORKER,
      vm: PROOF_VM,
      force: false,
      private_copy: basename(ownerDb),
      live_database: "never opened",
      gates: [
        "--execute",
        "--destroy-proven-fixture",
        "--provenance-db read-only snapshot",
        "owner gate: exact target, newest dispatch completed, git.persisted true, clean published branch",
        "fresh provider status before the first mutation",
        "private copy re-verified against the approved provenance",
        "coordinator Git durability gate",
      ],
    };
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
    // The private store runs in WAL mode, so an abrupt exit could leave committed
    // work in the -wal file rather than in the database the lead reads. Fold the
    // WAL back in, then take one consistent private snapshot.
    //
    // Neither step is allowed to fail silently. A swallowed checkpoint or copy
    // error produced a report that claimed a durable private record while the
    // bytes were still only in a WAL file the reader never opens, so a failure
    // here is collected, named in the report and turned into a non-zero exit.
    try {
      store.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } catch (error) {
      ioFailures.push(
        `wal_checkpoint: ${bounded(redact, error)}`,
      );
    }
    if (existsSync(dbPath)) {
      try {
        copyFileSync(dbPath, snapshot, constants.COPYFILE_EXCL);
        chmodSync(snapshot, 0o600);
      } catch (error) {
        ioFailures.push(`private_snapshot: ${bounded(redact, error)}`);
      }
    } else {
      ioFailures.push("private_snapshot: the private database does not exist");
    }
    try {
      store.close();
    } catch (error) {
      ioFailures.push(`store_close: ${bounded(redact, error)}`);
    }
    if (ioFailures.length) {
      finished.io_failures = ioFailures;
      evidence.event("io_failures", { failures: ioFailures });
    }
    try {
      evidence.assertHealthy();
    } catch (error) {
      const message = bounded(redact, error);
      finished.evidence_failure = message;
      ioFailures.push(message);
    }
    if (ioFailures.length) {
      // A run whose own record or audit trail could not be written is not a
      // successful run, whatever the salvage phase concluded.
      process.exitCode = 1;
    }
    // Written last. This run gets its OWN report file, so a second run never
    // overwrites the first run's report; the previous canonical report has already
    // been preserved to an immutable backup above and is not touched again here.
    const body = `${JSON.stringify(
      {
        ...finished,
        io_failures: ioFailures.length ? ioFailures : undefined,
        run_stamp: runStamp,
        at: Date.now(),
        evidence: basename(evidence.jsonl),
        private_db: basename(dbPath),
        // An IO failure means this run's own record is not trustworthy, so the
        // process must not exit 0 no matter what the salvage phase concluded.
        exit_nonzero: ioFailures.length > 0,
      },
      null,
      2,
    )}\n`;
    try {
      writeRunReports({ pointer: report, run: runReport, body });
    } catch (error) {
      // The report itself could not be written. That is the last honest thing this
      // process can do about it: say so on the console and fail the exit code.
      process.exitCode = 1;
      console.log(
        JSON.stringify({
          event: "report_write_failed",
          error: bounded(redact, error),
        }),
      );
    }
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
