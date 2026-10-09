import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

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
    consumed_runtime_ms: z.number().int().nonnegative(),
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
export class HostedStore {
  readonly db: Database;
  constructor(path: string) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
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
        consumed_runtime_ms INTEGER NOT NULL DEFAULT 0,
        idempotency_key TEXT NOT NULL,
        rotation_key TEXT,
        settlement_key TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
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
  }
  close() {
    this.db.close();
  }
  /** Atomic claim-or-reuse: same task retries return the existing mapping. */
  claimMapping(
    mapping: Omit<HostedMapping, "created_at" | "updated_at" | "state"> & {
      state?: HostedMapping["state"];
    },
  ): { mapping: HostedMapping; created: boolean } {
    const parsed = hostedMappingSchema
      .omit({ created_at: true, updated_at: true })
      .safeParse({ state: "mapped", ...mapping });
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
          current.fence !== parsed.data.fence
        )
          throw new Error(
            "Hosted mapping fence mismatch: holding existing reservation for trusted stop reconciliation.",
          );
        return { mapping: current, created: false };
      }
      const now = Date.now();
      const full: HostedMapping = {
        ...parsed.data,
        created_at: now,
        updated_at: now,
      };
      this.db
        .query(
          "INSERT INTO hosted_mappings(task_id,tenant_id,worker_id,local_worker_id,lease_id,fence,supervisor_id,reservation_id,state,stop_confirmed,consumed_runtime_ms,idempotency_key,rotation_key,settlement_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
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
          full.idempotency_key,
          full.rotation_key,
          full.settlement_key,
          full.created_at,
          full.updated_at,
        );
      return { mapping: full, created: true };
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
  markStopped(
    taskId: string,
    consumedRuntimeMs: number,
    settlementKey: string,
  ): HostedMapping {
    return this.db.transaction(() => {
      const current = this.get(taskId);
      if (!current) throw new Error("Hosted mapping not found.");
      const updated: HostedMapping = {
        ...current,
        state: "stopped",
        stop_confirmed: true,
        consumed_runtime_ms: consumedRuntimeMs,
        settlement_key: settlementKey,
        updated_at: Date.now(),
      };
      this.write(updated);
      return updated;
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
        "UPDATE hosted_mappings SET lease_id=?,fence=?,state=?,stop_confirmed=?,consumed_runtime_ms=?,rotation_key=?,settlement_key=?,updated_at=? WHERE task_id=?",
      )
      .run(
        mapping.lease_id,
        mapping.fence,
        mapping.state,
        mapping.stop_confirmed ? 1 : 0,
        mapping.consumed_runtime_ms,
        mapping.rotation_key,
        mapping.settlement_key,
        mapping.updated_at,
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
      consumed_runtime_ms: row.consumed_runtime_ms,
      idempotency_key: row.idempotency_key,
      rotation_key: row.rotation_key,
      settlement_key: row.settlement_key,
      created_at: row.created_at,
      updated_at: row.updated_at,
    });
  }
}
