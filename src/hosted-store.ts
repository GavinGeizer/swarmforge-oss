import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";

/** performance.now() is comparable only within this actual process lifetime. */
export const HOSTED_MONO_ORIGIN = `process:${process.pid}:${randomUUID()}`;

const settlementIntentSchema = z
  .object({
    task_id: z.uuid(),
    tenant_id: z.uuid(),
    supervisor_id: z.uuid(),
    worker_id: z.uuid(),
    reservation_id: z.uuid(),
    lease_id: z.uuid(),
    fence: z.number().int().nonnegative(),
    outcome: z.enum(["completed", "failed", "cancelled"]),
    stop_confirmed: z.literal(true),
    consumed_runtime_ms: z.number().int().nonnegative().max(3_600_000),
    key: z.uuid(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type SettlementIntent = z.infer<typeof settlementIntentSchema>;

export const hostedMappingSchema = z
  .object({
    task_id: z.uuid(),
    tenant_id: z.uuid(),
    worker_id: z.uuid(),
    local_worker_id: z.string().min(1).max(128),
    lease_id: z.uuid(),
    fence: z.number().int().nonnegative(),
    supervisor_id: z.uuid(),
    reservation_id: z.uuid(),
    state: z.enum([
      "mapped",
      "acknowledged",
      "running",
      "stop_intended",
      "stopped",
      "settled",
      "held",
    ]),
    stop_confirmed: z.boolean(),
    /** Never cleared when visible recovery state becomes held. */
    start_right_granted: z.boolean().default(false),
    consumed_runtime_ms: z.number().int().nonnegative(),
    consumed_runtime_unknown: z.boolean().default(false),
    // D2: cross-process monotonic start is NOT comparable. Only rows whose
    // start was observed in THIS process may carry a monotonic start; after a
    // restart the persisted value is treated as opaque unless the record also
    // carries a proven process/system monotonic origin (never assumed).
    runtime_started_at_mono_ms: z.number().nullable().default(null),
    runtime_mono_origin: z.string().min(1).max(128).default("unknown"),
    runtime_budget_ms: z.number().int().nonnegative().nullable().default(null),
    runtime_duration_ms: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .default(null),
    child_pid: z.number().int().positive().nullable().default(null),
    child_starttime: z.string().nullable().default(null),
    child_exe: z.string().nullable().default(null),
    child_boot_id: z.string().nullable().default(null),
    idempotency_key: z.uuid(),
    rotation_key: z.uuid().nullable(),
    settlement_key: z.uuid().nullable(),
    created_at: z.number().int(),
    updated_at: z.number().int(),
  })
  .strict();
export type HostedMapping = z.infer<typeof hostedMappingSchema>;

/**
 * Isolated durable mapping cloud task/lease/fence -> deterministic local worker.
 * Uses additional isolated SQLite table(s) only; never alters core Store tables.
 * Writes the mapping BEFORE any execution, so a crash between claim and start
 * retries the same task/lease/fence instead of spawning a duplicate runtime.
 */
/** Trusted local journals require the same private-directory boundary as credentials. */
export function ensurePrivateHostedPath(path: string): void {
  const uid = process.getuid?.();
  if (uid === undefined)
    throw new Error("Hosted state requires privately owned POSIX paths.");
  const directory = dirname(resolve(path));
  const chain: string[] = [];
  for (let at = directory; ; ) {
    chain.unshift(at);
    const next = dirname(at);
    if (next === at) break;
    at = next;
  }
  for (const at of chain) {
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(at);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(at, { mode: 0o700 });
      stat = lstatSync(at);
    }
    const rootTemp = stat.uid === 0 && Boolean(stat.mode & 0o1000);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.uid !== 0 && stat.uid !== uid) ||
      (stat.mode & 0o022 && !rootTemp) ||
      (at === directory && (stat.uid !== uid || stat.mode & 0o077))
    )
      throw new Error(
        "Hosted state requires private directory (0700), without symlinks.",
      );
  }
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      const stat = lstatSync(file);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.uid !== uid ||
        stat.nlink !== 1 ||
        stat.mode & 0o077
      )
        throw new Error(
          "Hosted state requires a private regular file (0600), without symlinks.",
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export class HostedStore {
  readonly db: Database;
  constructor(path: string) {
    if (path !== ":memory:") ensurePrivateHostedPath(path);
    this.db = new Database(path, { create: true });
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS hosted_mappings(
        task_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        worker_id TEXT NOT NULL,
        local_worker_id TEXT NOT NULL UNIQUE,
        lease_id TEXT NOT NULL,
        fence INTEGER NOT NULL,
        supervisor_id TEXT NOT NULL,
        reservation_id TEXT NOT NULL,
        state TEXT NOT NULL,
        stop_confirmed INTEGER NOT NULL DEFAULT 0,
        start_right_granted INTEGER NOT NULL DEFAULT 0,
        consumed_runtime_ms INTEGER NOT NULL DEFAULT 0,
        consumed_runtime_unknown INTEGER NOT NULL DEFAULT 0,
        runtime_started_at_mono_ms REAL,
        runtime_mono_origin TEXT NOT NULL DEFAULT 'unknown',
        runtime_duration_ms INTEGER,
        runtime_budget_ms INTEGER,
        child_pid INTEGER,
        child_starttime TEXT,
        child_exe TEXT,
        child_boot_id TEXT,
        idempotency_key TEXT NOT NULL,
        rotation_key TEXT,
        settlement_key TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS hosted_settlement_intents (
        task_id TEXT PRIMARY KEY REFERENCES hosted_mappings(task_id),
        intent TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS hosted_settlement_intents_immutable_update
        BEFORE UPDATE ON hosted_settlement_intents BEGIN
          SELECT RAISE(ABORT, 'Hosted settlement intent is immutable');
        END;
      CREATE TRIGGER IF NOT EXISTS hosted_settlement_intents_immutable_delete
        BEFORE DELETE ON hosted_settlement_intents BEGIN
          SELECT RAISE(ABORT, 'Hosted settlement intent is immutable');
        END;
      CREATE INDEX IF NOT EXISTS hosted_mappings_lease ON hosted_mappings(lease_id);
      CREATE INDEX IF NOT EXISTS hosted_mappings_local ON hosted_mappings(local_worker_id);
      CREATE TABLE IF NOT EXISTS hosted_idempotency(
        key TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        principal TEXT NOT NULL,
        resource TEXT NOT NULL,
        operation TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        response TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );`);
    // Upgrade candidate journals without rewriting an existing process origin.
    const columns = this.db
      .query("PRAGMA table_info(hosted_mappings)")
      .all() as { name: string }[];
    if (!columns.some((column) => column.name === "runtime_budget_ms"))
      this.db.exec(
        "ALTER TABLE hosted_mappings ADD COLUMN runtime_budget_ms INTEGER",
      );
    if (!columns.some((column) => column.name === "child_boot_id"))
      this.db.exec("ALTER TABLE hosted_mappings ADD COLUMN child_boot_id TEXT");
    if (!columns.some((column) => column.name === "start_right_granted")) {
      this.db.exec(
        "ALTER TABLE hosted_mappings ADD COLUMN start_right_granted INTEGER NOT NULL DEFAULT 0",
      );
      // Legacy held rows cannot reveal whether a spawn was in flight. Preserve
      // ambiguity rather than turning an old launch into a zero-use receipt.
      this.db.exec(
        "UPDATE hosted_mappings SET start_right_granted=1 WHERE state <> 'mapped' OR child_pid IS NOT NULL OR runtime_started_at_mono_ms IS NOT NULL",
      );
    }
    if (path !== ":memory:") {
      // SQLite creates sidecars after opening; pin their permissions too.
      for (const sidecar of [`${path}-wal`, `${path}-shm`]) {
        try {
          chmodSync(sidecar, 0o600);
        } catch {}
      }
    }
  }
  close() {
    this.db.close();
  }
  /** Atomic claim-or-reuse: same task retries return the existing mapping. */
  claimMapping(
    mapping: Omit<
      HostedMapping,
      | "created_at"
      | "updated_at"
      | "state"
      | "consumed_runtime_unknown"
      | "start_right_granted"
      | "runtime_started_at_mono_ms"
      | "runtime_mono_origin"
      | "runtime_duration_ms"
      | "runtime_budget_ms"
      | "child_pid"
      | "child_starttime"
      | "child_exe"
      | "child_boot_id"
    > & {
      state?: HostedMapping["state"];
      runtime_budget_ms?: number | null;
    },
  ): { mapping: HostedMapping; created: boolean } {
    const parsed = hostedMappingSchema
      .omit({
        created_at: true,
        updated_at: true,
        consumed_runtime_unknown: true,
        start_right_granted: true,
        runtime_started_at_mono_ms: true,
        runtime_mono_origin: true,
        runtime_duration_ms: true,
        runtime_budget_ms: true,
        child_pid: true,
        child_starttime: true,
        child_exe: true,
        child_boot_id: true,
      })
      .safeParse({
        state: "mapped",
        ...(({ runtime_budget_ms: _budget, ...rest }) => rest)(mapping),
      });
    if (!parsed.success) throw new Error("Hosted mapping is invalid.");
    return this.db.transaction(() => {
      const row = this.db
        .query("SELECT * FROM hosted_mappings WHERE task_id=?")
        .get(parsed.data.task_id) as Record<
        string,
        string | number | null
      > | null;
      if (row) {
        const current = this.fromRow(row);
        // Lost-ACK retry: same task/lease/fence reuses the mapping, never a
        // second local worker. A different fence is a new ownership epoch and
        // must not overwrite the held reservation.
        if (
          current.lease_id !== parsed.data.lease_id ||
          current.fence !== parsed.data.fence ||
          current.tenant_id !== parsed.data.tenant_id ||
          current.worker_id !== parsed.data.worker_id ||
          current.supervisor_id !== parsed.data.supervisor_id ||
          current.reservation_id !== parsed.data.reservation_id
        )
          throw new Error(
            "Hosted mapping fence mismatch: holding existing reservation for trusted stop reconciliation.",
          );
        return { mapping: current, created: false };
      }
      const now = Date.now();
      const full: HostedMapping = {
        ...parsed.data,
        consumed_runtime_unknown: false,
        start_right_granted: false,
        runtime_started_at_mono_ms: null,
        runtime_mono_origin: "unknown",
        runtime_duration_ms: null,
        runtime_budget_ms: mapping.runtime_budget_ms ?? null,
        child_pid: null,
        child_starttime: null,
        child_exe: null,
        child_boot_id: null,
        created_at: now,
        updated_at: now,
      };
      this.db
        .query(
          "INSERT INTO hosted_mappings(task_id,tenant_id,worker_id,local_worker_id,lease_id,fence,supervisor_id,reservation_id,state,stop_confirmed,consumed_runtime_ms,consumed_runtime_unknown,runtime_started_at_mono_ms,runtime_mono_origin,runtime_duration_ms,child_pid,child_starttime,child_exe,idempotency_key,rotation_key,settlement_key,created_at,updated_at,runtime_budget_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          full.task_id,
          full.tenant_id,
          full.worker_id,
          full.local_worker_id,
          full.lease_id,
          full.fence,
          full.supervisor_id,
          full.reservation_id,
          full.state,
          full.stop_confirmed ? 1 : 0,
          full.consumed_runtime_ms,
          full.consumed_runtime_unknown ? 1 : 0,
          full.runtime_started_at_mono_ms,
          full.runtime_mono_origin,
          full.runtime_duration_ms,
          full.child_pid,
          full.child_starttime,
          full.child_exe,
          full.idempotency_key,
          full.rotation_key,
          full.settlement_key,
          full.created_at,
          full.updated_at,
          full.runtime_budget_ms,
        );
      return { mapping: full, created: true };
    })();
  }
  /**
   * Durable start-right-once CAS grant (B duplicate-task fix). Atomically
   * transitions mapped -> acknowledged for ONE caller per task/lease/fence.
   * The grant is a single conditional UPDATE inside the store transaction:
   * it wins only when the row is still in a never-started state (mapped),
   * binds the same lease/fence, and carries NO pid, NO start and NO
   * stop-confirmation. Every other durable state — acknowledged (a launch is
   * already in flight or done), running, stop_intended, stopped, settled,
   * held, any pid-bearing row, any stop-confirmed row, any uncertain-launch
   * row — is REJECTED, even after child exit or restart. Concurrent duplicate
   * ack calls cannot both win: SQLite serializes the transactions and the
   * second conditional UPDATE matches zero rows. Proven-never-started retry
   * after an ambiguous write/network crash is the ONLY safe retry, and it
   * goes through this same gate (mapped + no pid + no start); anything else
   * holds for trusted reconciliation instead of a blind spawn.
   */
  grantStartRight(
    taskId: string,
    lease: { lease_id: string; fence: number },
  ): HostedMapping {
    return this.db.transaction(() => {
      const result = this.db
        .query(
          "UPDATE hosted_mappings SET state='acknowledged',start_right_granted=1,updated_at=? WHERE task_id=? AND state='mapped' AND start_right_granted=0 AND lease_id=? AND fence=? AND stop_confirmed=0 AND child_pid IS NULL AND runtime_started_at_mono_ms IS NULL AND consumed_runtime_unknown=0",
        )
        .run(Date.now(), taskId, lease.lease_id, lease.fence);
      const changed =
        typeof result === "number" ? result : (result.changes ?? 0);
      if (changed === 0) {
        const current = this.get(taskId);
        if (!current)
          throw new Error("Hosted start right denied: no durable mapping row.");
        if (
          current.lease_id !== lease.lease_id ||
          current.fence !== lease.fence
        )
          throw new Error(
            "Hosted start right denied: lease/fence mismatch, holding existing reservation.",
          );
        throw new Error(
          `Hosted start right denied: duplicate launch refused (state=${current.state}, pid=${current.child_pid ?? "none"}, stop_confirmed=${current.stop_confirmed}); start right already granted or consumed.`,
        );
      }
      const granted = this.get(taskId);
      if (!granted)
        throw new Error("Hosted start right denied: row vanished mid-grant.");
      return granted;
    })();
  }
  get(taskId: string): HostedMapping | null {
    const row = this.db
      .query("SELECT * FROM hosted_mappings WHERE task_id=?")
      .get(taskId) as Record<string, string | number | null> | null;
    return row ? this.fromRow(row) : null;
  }
  byLocalWorker(localWorkerId: string): HostedMapping | null {
    const row = this.db
      .query("SELECT * FROM hosted_mappings WHERE local_worker_id=?")
      .get(localWorkerId) as Record<string, string | number | null> | null;
    return row ? this.fromRow(row) : null;
  }
  /**
   * Bind the canonical Store worker id after local staging. The task row
   * stays the same reservation; only the local pointer advances from the
   * claim-time placeholder. Never called before the worker exists.
   */
  rebindLocalWorker(taskId: string, localWorkerId: string): HostedMapping {
    if (!localWorkerId) throw new Error("Hosted local worker id is invalid.");
    return this.db.transaction(() => {
      const current = this.get(taskId);
      if (!current) throw new Error("Hosted mapping not found.");
      if (current.local_worker_id === localWorkerId) return current;
      const clash = this.byLocalWorker(localWorkerId);
      if (clash && clash.task_id !== taskId)
        throw new Error(
          "Hosted local worker is already bound to another task.",
        );
      const updated: HostedMapping = {
        ...current,
        local_worker_id: localWorkerId,
        updated_at: Date.now(),
      };
      hostedMappingSchema.parse(updated);
      this.db
        .query(
          "UPDATE hosted_mappings SET local_worker_id=?,updated_at=? WHERE task_id=?",
        )
        .run(updated.local_worker_id, updated.updated_at, taskId);
      return updated;
    })();
  }
  all(): HostedMapping[] {
    const rows = this.db
      .query("SELECT * FROM hosted_mappings ORDER BY rowid")
      .all() as Record<string, string | number | null>[];
    return rows.map((row) => this.fromRow(row));
  }
  /** Same task/lease/fence only: renew never widens authority. */
  updateLease(
    taskId: string,
    lease: { lease_id: string; fence: number },
    state?: HostedMapping["state"],
  ): HostedMapping {
    return this.db.transaction(() => {
      const current = this.get(taskId);
      if (!current) throw new Error("Hosted mapping not found.");
      if (current.fence !== lease.fence)
        throw new Error(
          "Stale fence: refusing to update a superseded lease epoch.",
        );
      if (current.lease_id !== lease.lease_id)
        throw new Error("Lease mismatch for current fence; holding state.");
      const updated: HostedMapping = {
        ...current,
        state: state ?? current.state,
        updated_at: Date.now(),
      };
      this.write(updated);
      return updated;
    })();
  }
  /** Durable stop intent: heartbeat failure, 401/409, stale fence, cancel race. */
  markStopIntended(taskId: string): HostedMapping {
    return this.db.transaction(() => {
      const current = this.get(taskId);
      if (!current) throw new Error("Hosted mapping not found.");
      const updated: HostedMapping = {
        ...current,
        state: "stop_intended",
        updated_at: Date.now(),
      };
      this.write(updated);
      return updated;
    })();
  }
  /**
   * Persist actual process start + OS start identity at launch. D2: the
   * monotonic start is tagged with its origin process. After a restart the
   * persisted value is opaque (origin unknown) and must NEVER be subtracted
   * from the new process clock — restart accounting uses the conservative
   * reserved budget + unknown flag instead.
   */
  markRuntimeStarted(
    taskId: string,
    start: {
      startedAtMonoMs: number;
      monoOrigin: string;
      durationMs: number;
      pid: number;
      starttime: string;
      exe: string;
      bootId?: string;
    },
  ): HostedMapping {
    return this.db.transaction(() => {
      const current = this.get(taskId);
      if (!current) throw new Error("Hosted mapping not found.");
      const updated: HostedMapping = {
        ...current,
        runtime_started_at_mono_ms: start.startedAtMonoMs,
        runtime_mono_origin: start.monoOrigin,
        runtime_duration_ms: start.durationMs,
        child_pid: start.pid,
        child_starttime: start.starttime,
        child_exe: start.exe,
        child_boot_id: start.bootId ?? null,
        consumed_runtime_unknown: false,
        updated_at: Date.now(),
      };
      this.writeFull(updated);
      return updated;
    })();
  }
  /**
   * Normal stop records measured ELAPSED EXECUTION, bounded by the
   * server-reserved runtime — never the stop-call latency. D2: the elapsed
   * value must come from the SAME process that observed the start (same
   * monotonic origin). A caller passing a persisted start from a prior
   * process must record conservative consumption after OS proof — a foreign clock
   * yields zero/garbage measurement, so markStopped rejects an unknown or
   * foreign origin outright.
   */
  markStopped(
    taskId: string,
    elapsed: { elapsedMs: number; monoOrigin: string },
    settlementKey: string,
  ): HostedMapping {
    return this.db.transaction(() => {
      const current = this.get(taskId);
      if (!current) throw new Error("Hosted mapping not found.");
      if (
        elapsed.monoOrigin !== HOSTED_MONO_ORIGIN ||
        current.runtime_mono_origin !== HOSTED_MONO_ORIGIN ||
        elapsed.monoOrigin !== current.runtime_mono_origin
      )
        throw new Error(
          "Hosted accounting origin mismatch: refuse foreign-clock measurement.",
        );
      const bound = current.runtime_duration_ms ?? Number.MAX_SAFE_INTEGER;
      const consumed = Math.max(
        0,
        Math.min(Math.floor(elapsed.elapsedMs), bound),
      );
      const updated: HostedMapping = {
        ...current,
        state: "stopped",
        stop_confirmed: true,
        consumed_runtime_ms: consumed,
        consumed_runtime_unknown: false,
        settlement_key: settlementKey,
        updated_at: Date.now(),
      };
      this.write(updated);
      return updated;
    })();
  }
  /**
   * After a crash the exit time is unknown: conservatively record the
   * reserved budget as consumed and flag unknown — never under-report stop
   * latency as execution. The row stays held for trusted reconciliation.
   */
  markHeldUnknown(taskId: string): HostedMapping {
    return this.db.transaction(() => {
      const current = this.get(taskId);
      if (!current) throw new Error("Hosted mapping not found.");
      const reserved =
        current.runtime_budget_ms ?? current.runtime_duration_ms ?? 0;
      const updated: HostedMapping = {
        ...current,
        state: "held",
        stop_confirmed: current.stop_confirmed,
        consumed_runtime_ms: current.stop_confirmed
          ? current.consumed_runtime_ms
          : Math.max(current.consumed_runtime_ms, reserved),
        consumed_runtime_unknown: true,
        updated_at: Date.now(),
      };
      this.write(updated);
      return updated;
    })();
  }
  /**
   * Zero-use stop for provably-never-started rows (no pid, no start, unknown
   * origin, still mapped/held). No monotonic measurement exists or is needed.
   */
  markStoppedZeroUse(taskId: string, settlementKey: string): HostedMapping {
    return this.db.transaction(() => {
      const current = this.get(taskId);
      if (!current) throw new Error("Hosted mapping not found.");
      if (
        current.start_right_granted ||
        current.child_pid !== null ||
        current.runtime_started_at_mono_ms !== null ||
        current.runtime_mono_origin !== "unknown"
      )
        throw new Error("Hosted row may have started; refusing zero-use stop.");
      const updated: HostedMapping = {
        ...current,
        state: "stopped",
        stop_confirmed: true,
        consumed_runtime_ms: 0,
        consumed_runtime_unknown: false,
        settlement_key: settlementKey,
        updated_at: Date.now(),
      };
      this.write(updated);
      return updated;
    })();
  }
  /** OS stop is proven even when a foreign clock prevents measuring execution. */
  markStoppedConservative(
    taskId: string,
    settlementKey: string,
  ): HostedMapping {
    return this.db.transaction(() => {
      const current = this.get(taskId);
      if (!current) throw new Error("Hosted mapping not found.");
      const reserved = current.runtime_budget_ms ?? current.runtime_duration_ms;
      if (reserved === null)
        throw new Error("Hosted reserved budget is unknown; holding.");
      const updated: HostedMapping = {
        ...current,
        state: "stopped",
        stop_confirmed: true,
        consumed_runtime_ms: reserved,
        consumed_runtime_unknown: true,
        settlement_key: current.settlement_key ?? settlementKey,
        updated_at: Date.now(),
      };
      this.write(updated);
      return updated;
    })();
  }

  settlementIntent(taskId: string): SettlementIntent | null {
    const row = this.db
      .query("SELECT intent FROM hosted_settlement_intents WHERE task_id=?")
      .get(taskId) as { intent: string } | null;
    return row ? settlementIntentSchema.parse(JSON.parse(row.intent)) : null;
  }

  /** Freeze the entire same-fence request atomically BEFORE any HTTP attempt. */
  freezeSettlement(
    taskId: string,
    outcome: SettlementIntent["outcome"],
    key: string,
  ): SettlementIntent {
    return this.db.transaction(() => {
      const mapping = this.get(taskId);
      if (!mapping?.stop_confirmed)
        throw new Error("Settlement requires independently confirmed stop.");
      const binding = {
        task_id: mapping.task_id,
        tenant_id: mapping.tenant_id,
        supervisor_id: mapping.supervisor_id,
        worker_id: mapping.worker_id,
        reservation_id: mapping.reservation_id,
        lease_id: mapping.lease_id,
        fence: mapping.fence,
        outcome,
        stop_confirmed: true as const,
        consumed_runtime_ms: mapping.consumed_runtime_ms,
        key,
      };
      const intent = settlementIntentSchema.parse({
        ...binding,
        fingerprint: createHash("sha256")
          .update(JSON.stringify(binding))
          .digest("hex"),
      });
      const existing = this.settlementIntent(taskId);
      if (existing) {
        if (existing.fingerprint !== intent.fingerprint)
          throw new Error(
            "Frozen settlement intent conflicts with a different payload or key.",
          );
        return existing;
      }
      this.db
        .query(
          "INSERT INTO hosted_settlement_intents(task_id,intent) VALUES(?,?)",
        )
        .run(taskId, JSON.stringify(intent));
      this.db
        .query(
          "UPDATE hosted_mappings SET settlement_key=?,updated_at=? WHERE task_id=? AND lease_id=? AND fence=?",
        )
        .run(key, Date.now(), taskId, mapping.lease_id, mapping.fence);
      return intent;
    })();
  }

  markSettled(taskId: string): HostedMapping {
    return this.db.transaction(() => {
      const current = this.get(taskId);
      if (!current) throw new Error("Hosted mapping not found.");
      if (!current.stop_confirmed)
        throw new Error(
          "Settlement requires independently confirmed stop, never a Coordinator label.",
        );
      const updated: HostedMapping = {
        ...current,
        state: "settled",
        updated_at: Date.now(),
      };
      this.write(updated);
      return updated;
    })();
  }
  markHeld(taskId: string): HostedMapping {
    return this.db.transaction(() => {
      const current = this.get(taskId);
      if (!current) throw new Error("Hosted mapping not found.");
      const updated: HostedMapping = {
        ...current,
        state: "held",
        updated_at: Date.now(),
      };
      this.write(updated);
      return updated;
    })();
  }
  setRotationKey(taskId: string, key: string): HostedMapping {
    return this.db.transaction(() => {
      const current = this.get(taskId);
      if (!current) throw new Error("Hosted mapping not found.");
      const updated: HostedMapping = {
        ...current,
        rotation_key: key,
        updated_at: Date.now(),
      };
      this.write(updated);
      return updated;
    })();
  }
  rememberIdempotentResponse(
    key: string,
    binding: {
      tenant_id: string;
      principal: string;
      resource: string;
      operation: string;
      fingerprint: string;
    },
    response: unknown,
  ): void {
    this.db
      .query(
        "INSERT OR IGNORE INTO hosted_idempotency(key,tenant_id,principal,resource,operation,fingerprint,response,created_at) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        key,
        binding.tenant_id,
        binding.principal,
        binding.resource,
        binding.operation,
        binding.fingerprint,
        JSON.stringify(response),
        Date.now(),
      );
  }
  readIdempotentResponse<T>(
    key: string,
    binding: {
      tenant_id: string;
      principal: string;
      resource: string;
      operation: string;
      fingerprint: string;
    },
  ): T | null {
    const row = this.db
      .query("SELECT * FROM hosted_idempotency WHERE key=?")
      .get(key) as {
      tenant_id: string;
      principal: string;
      resource: string;
      operation: string;
      fingerprint: string;
      response: string;
    } | null;
    if (!row) return null;
    // A replayed key that binds a different tenant/principal/resource/operation
    // or fingerprint is a conflict, never a cache hit.
    if (
      row.tenant_id !== binding.tenant_id ||
      row.principal !== binding.principal ||
      row.resource !== binding.resource ||
      row.operation !== binding.operation ||
      row.fingerprint !== binding.fingerprint
    )
      throw new Error("Idempotency key conflicts with a different operation.");
    return JSON.parse(row.response) as T;
  }
  private write(mapping: HostedMapping): void {
    hostedMappingSchema.parse(mapping);
    this.db
      .query(
        "UPDATE hosted_mappings SET lease_id=?,fence=?,state=?,stop_confirmed=?,consumed_runtime_ms=?,consumed_runtime_unknown=?,runtime_started_at_mono_ms=?,runtime_mono_origin=?,runtime_duration_ms=?,child_pid=?,child_starttime=?,child_exe=?,child_boot_id=?,rotation_key=?,settlement_key=?,updated_at=? WHERE task_id=?",
      )
      .run(
        mapping.lease_id,
        mapping.fence,
        mapping.state,
        mapping.stop_confirmed ? 1 : 0,
        mapping.consumed_runtime_ms,
        mapping.consumed_runtime_unknown ? 1 : 0,
        mapping.runtime_started_at_mono_ms,
        mapping.runtime_mono_origin,
        mapping.runtime_duration_ms,
        mapping.child_pid,
        mapping.child_starttime,
        mapping.child_exe,
        mapping.child_boot_id,
        mapping.rotation_key,
        mapping.settlement_key,
        mapping.updated_at,
        mapping.task_id,
      );
  }
  /** Full-row write for fields (pid/start) the partial writer does not cover. */
  private writeFull(mapping: HostedMapping): void {
    hostedMappingSchema.parse(mapping);
    const columns = [
      "lease_id",
      "fence",
      "local_worker_id",
      "state",
      "stop_confirmed",
      "consumed_runtime_ms",
      "consumed_runtime_unknown",
      "runtime_started_at_mono_ms",
      "runtime_mono_origin",
      "runtime_duration_ms",
      "child_pid",
      "child_starttime",
      "child_exe",
      "child_boot_id",
      "rotation_key",
      "settlement_key",
      "updated_at",
    ];
    const values: Record<string, unknown> = {
      lease_id: mapping.lease_id,
      fence: mapping.fence,
      local_worker_id: mapping.local_worker_id,
      state: mapping.state,
      stop_confirmed: mapping.stop_confirmed ? 1 : 0,
      consumed_runtime_ms: mapping.consumed_runtime_ms,
      consumed_runtime_unknown: mapping.consumed_runtime_unknown ? 1 : 0,
      runtime_started_at_mono_ms: mapping.runtime_started_at_mono_ms,
      runtime_mono_origin: mapping.runtime_mono_origin,
      runtime_duration_ms: mapping.runtime_duration_ms,
      child_pid: mapping.child_pid,
      child_starttime: mapping.child_starttime,
      child_exe: mapping.child_exe,
      child_boot_id: mapping.child_boot_id,
      rotation_key: mapping.rotation_key,
      settlement_key: mapping.settlement_key,
      updated_at: mapping.updated_at,
    };
    this.db
      .query(
        `UPDATE hosted_mappings SET ${columns.map((c) => `${c}=?`).join(",")} WHERE task_id=?`,
      )
      .run(
        ...(columns.map((c) => values[c]) as (
          | string
          | number
          | bigint
          | boolean
          | null
        )[]),
        mapping.task_id,
      );
  }
  private fromRow(row: Record<string, string | number | null>): HostedMapping {
    return hostedMappingSchema.parse({
      task_id: row.task_id,
      tenant_id: row.tenant_id,
      worker_id: row.worker_id,
      local_worker_id: row.local_worker_id,
      lease_id: row.lease_id,
      fence: row.fence,
      supervisor_id: row.supervisor_id,
      reservation_id: row.reservation_id,
      state: row.state,
      stop_confirmed: row.stop_confirmed === 1,
      start_right_granted: row.start_right_granted === 1,
      consumed_runtime_ms: row.consumed_runtime_ms,
      consumed_runtime_unknown: row.consumed_runtime_unknown === 1,
      runtime_started_at_mono_ms: row.runtime_started_at_mono_ms,
      runtime_mono_origin: row.runtime_mono_origin,
      runtime_duration_ms: row.runtime_duration_ms,
      runtime_budget_ms: row.runtime_budget_ms,
      child_pid: row.child_pid,
      child_starttime: row.child_starttime,
      child_exe: row.child_exe,
      child_boot_id: row.child_boot_id,
      idempotency_key: row.idempotency_key,
      rotation_key: row.rotation_key,
      settlement_key: row.settlement_key,
      created_at: row.created_at,
      updated_at: row.updated_at,
    });
  }
}
