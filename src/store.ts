import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  Dispatch,
  EventType,
  SpawnRequest,
  Worker,
  WorkerEvent,
  WorkerFinalization,
  WorkerResult,
  WorkerState,
} from "./domain";
import { retainedSql, type WorkerQuery, workerWhere } from "./worker-query";

// Object key order must not change a request fingerprint; array order still must.
const canonicalKeys = (_key: string, value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        ),
      )
    : value;
const emptyFinalization = (): WorkerFinalization => ({
  state: "pending",
  run_id: null,
  attempts: 0,
  error: null,
  next_retry_at: null,
  started_at: null,
  completed_at: null,
});
export class Store {
  readonly db: Database;
  private watchers = new Set<() => void>();
  private readonly epoch = randomUUID();
  private cachedPasswords: { revision: string; values: string[] } | undefined;
  private cachedSummary:
    | { revision: string; value: ReturnType<Store["computeSummary"]> }
    | undefined;
  constructor(path: string) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true });
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS teams(team_id TEXT PRIMARY KEY,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(team_id TEXT NOT NULL,task_id TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(team_id,task_id));
      CREATE TABLE IF NOT EXISTS workers(worker_id TEXT PRIMARY KEY,team_id TEXT NOT NULL,task_id TEXT NOT NULL,state TEXT NOT NULL,request_id TEXT,body TEXT NOT NULL,UNIQUE(team_id,request_id));
      CREATE INDEX IF NOT EXISTS workers_state ON workers(state);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,worker_id TEXT NOT NULL,type TEXT NOT NULL,at INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dispatches(run_id TEXT PRIMARY KEY,worker_id TEXT NOT NULL,message_id TEXT NOT NULL UNIQUE,state TEXT NOT NULL,body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS dispatch_worker ON dispatches(worker_id);
      CREATE TABLE IF NOT EXISTS usage(worker_id TEXT NOT NULL,message_id TEXT NOT NULL,model TEXT NOT NULL,input INTEGER NOT NULL,output INTEGER NOT NULL,reasoning INTEGER NOT NULL,cache_read INTEGER NOT NULL,cache_write INTEGER NOT NULL,PRIMARY KEY(worker_id,message_id));
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS workers_team_task ON workers(team_id,task_id);
      CREATE INDEX IF NOT EXISTS workers_activity ON workers(json_extract(body,'$.last_activity_at'),worker_id);
      CREATE INDEX IF NOT EXISTS workers_age ON workers(json_extract(body,'$.created_at'),worker_id);
      CREATE INDEX IF NOT EXISTS workers_preservation ON workers(json_extract(body,'$.finalization.state'));
      CREATE INDEX IF NOT EXISTS dispatch_worker_state ON dispatches(worker_id,state);`);
  }
  revision() {
    const row = this.db.query("SELECT total_changes() changes").get() as {
      changes: number;
    };
    const external = this.db.query("PRAGMA data_version").get() as {
      data_version: number;
    };
    return `${this.epoch}:${row.changes}:${external.data_version}:${this.db.inTransaction ? "transaction" : "committed"}`;
  }
  credentials() {
    const read = () =>
      (
        this.db
          .query(
            "SELECT json_extract(body,'$.server_password') password FROM workers",
          )
          .all() as { password: string | null }[]
      )
        .map((row) => row.password)
        .filter((value): value is string => !!value);
    if (this.db.inTransaction) return read();
    const revision = this.revision();
    if (this.cachedPasswords?.revision !== revision)
      this.cachedPasswords = { revision, values: read() };
    return this.cachedPasswords!.values;
  }
  pendingMessages(id: string) {
    return (
      this.db
        .query(
          "SELECT count(*) count FROM dispatches WHERE worker_id=? AND state IN ('pending','sending','sent')",
        )
        .get(id) as { count: number }
    ).count;
  }
  queryWorkers(input: WorkerQuery = {}) {
    const { sql, args } = workerWhere(input);
    const limit = input.limit ?? 20;
    const offset = input.offset ?? 0;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    )
      throw new Error("Invalid worker page");
    const total = (
      this.db
        .query(`SELECT count(*) total FROM workers WHERE ${sql}`)
        .get(...args) as { total: number }
    ).total;
    const order =
      input.sort === "age"
        ? "json_extract(body,'$.created_at') ASC,worker_id ASC"
        : input.sort === "idle"
          ? "json_extract(body,'$.last_activity_at') ASC,worker_id ASC"
          : input.sort === "recent"
            ? "json_extract(body,'$.last_activity_at') DESC,worker_id ASC"
            : "rowid ASC";
    const rows = this.db
      .query(
        `SELECT body FROM workers WHERE ${sql} ORDER BY ${order} LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, offset) as { body: string }[];
    return {
      workers: rows.map((row) => JSON.parse(row.body) as Worker),
      total,
      next_offset: offset + limit < total ? offset + limit : null,
    };
  }
  private computeSummary() {
    const grouped = this.db
      .query("SELECT state,count(*) count FROM workers GROUP BY state")
      .all() as { state: string; count: number }[];
    const retention = this.db
      .query(
        `SELECT count(DISTINCT json_extract(body,'$.vm_id')) count,min(json_extract(body,'$.created_at')) oldest_created_at FROM workers WHERE ${retainedSql}`,
      )
      .get() as { count: number; oldest_created_at: number | null };
    const candidates = (
      this.db
        .query(
          `SELECT count(*) count FROM workers WHERE ${retainedSql} AND state IN ('completed','failed','cancelled','recovery_required') AND json_extract(body,'$.finalization.state')='preserved' AND json_extract(body,'$.intent') IS NULL AND NOT EXISTS (SELECT 1 FROM dispatches d WHERE d.worker_id=workers.worker_id AND d.state IN ('pending','sending','sent'))`,
        )
        .get() as { count: number }
    ).count;
    const attention = (
      this.db
        .query(
          "SELECT count(*) count FROM workers WHERE json_extract(body,'$.finalization.state') IN ('pending','collecting','failed')",
        )
        .get() as { count: number }
    ).count;
    return {
      states: Object.fromEntries(grouped.map((row) => [row.state, row.count])),
      tokens: this.tokens(),
      total: grouped.reduce((sum, row) => sum + row.count, 0),
      retention: { ...retention, candidates },
      preservation_attention: attention,
    };
  }
  summary() {
    if (this.db.inTransaction) return this.computeSummary();
    const revision = this.revision();
    if (this.cachedSummary?.revision !== revision)
      this.cachedSummary = { revision, value: this.computeSummary() };
    return this.cachedSummary!.value;
  }
  close() {
    this.watchers.clear();
    this.db.close();
  }
  get listenerCount() {
    return this.watchers.size;
  }
  // Event-driven waiters attach here; the store owns the fan-out, not any single caller.
  subscribe(listener: () => void) {
    this.watchers.add(listener);
    return () => {
      this.watchers.delete(listener);
    };
  }
  // Deferred so a waiter can never observe rows from the transaction still being written.
  private notify() {
    for (const listener of [...this.watchers])
      queueMicrotask(() => {
        try {
          listener();
        } catch {}
      });
  }
  setting(key: string, value?: string): string | undefined {
    if (value !== undefined)
      this.db
        .query(
          "INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(key, value);
    return (
      this.db.query("SELECT value FROM settings WHERE key=?").get(key) as {
        value: string;
      } | null
    )?.value;
  }
  create(input: SpawnRequest & { timeout_seconds: number }): Worker {
    return this.db.transaction(() => {
      // Fingerprinted over the normalized request with canonical key order, so a retry that
      // spells out the artifact defaults (or reorders keys) still matches the original.
      const request = {
        team_id: input.team_id,
        task_id: input.task_id,
        role: input.role,
        prompt: input.prompt,
        timeout_seconds: input.timeout_seconds,
        request_id: input.request_id,
        artifacts: input.artifacts ?? [],
        snapshot_on_failure: input.snapshot_on_failure ?? false,
      };
      const fingerprint = createHash("sha256")
        .update(JSON.stringify(request, canonicalKeys))
        .digest("hex");
      // A row written before artifact declarations existed carries the digest of its request as
      // it was hashed then: the raw object for a direct create, and the parsed request without the
      // two new fields for one that came through spawnSchema. Retrying either must still resolve
      // to the same worker instead of reporting a conflict.
      const legacyFingerprints = [
        createHash("sha256").update(JSON.stringify(input)).digest("hex"),
        createHash("sha256")
          .update(
            JSON.stringify({
              team_id: request.team_id,
              task_id: request.task_id,
              role: request.role,
              prompt: request.prompt,
              timeout_seconds: request.timeout_seconds,
              request_id: request.request_id,
            }),
          )
          .digest("hex"),
      ];
      if (input.request_id) {
        const old = this.db
          .query("SELECT body FROM workers WHERE team_id=? AND request_id=?")
          .get(input.team_id, input.request_id) as { body: string } | null;
        if (old) {
          const w = JSON.parse(old.body) as Worker;
          if (
            w.request_fingerprint !== fingerprint &&
            !legacyFingerprints.includes(w.request_fingerprint)
          )
            throw new Error("request_id already used with different arguments");
          return w;
        }
      }
      const now = Date.now();
      const w: Worker = {
        ...request,
        worker_id: `w-${randomUUID()}`,
        request_fingerprint: fingerprint,
        state: "queued",
        vm_id: null,
        vm_missing: false,
        opencode_session_id: null,
        endpoint: null,
        server_password: randomUUID() + randomUUID(),
        created_at: now,
        started_at: null,
        last_activity_at: now,
        completed_at: null,
        provision_started_at: null,
        deadline_at: null,
        paused_at: null,
        previous_state: null,
        token_progress_at: null,
        token_progress_total: 0,
        error: null,
        intent: null,
        force_destroy: false,
      };
      this.db
        .query("INSERT OR IGNORE INTO teams VALUES(?,?)")
        .run(w.team_id, now);
      this.db
        .query("INSERT OR IGNORE INTO tasks VALUES(?,?,?)")
        .run(w.team_id, w.task_id, now);
      this.db
        .query("INSERT INTO workers VALUES(?,?,?,?,?,?)")
        .run(
          w.worker_id,
          w.team_id,
          w.task_id,
          w.state,
          w.request_id ?? null,
          JSON.stringify(w),
        );
      this.event(w.worker_id, "worker.requested");
      this.enqueue(w.worker_id, w.prompt);
      return w;
    })();
  }
  get(id: string): Worker {
    const row = this.db
      .query("SELECT body FROM workers WHERE worker_id=?")
      .get(id) as { body: string } | null;
    if (!row) throw new Error("Worker not found");
    return JSON.parse(row.body);
  }
  all(): Worker[] {
    return (
      this.db.query("SELECT body FROM workers ORDER BY rowid").all() as {
        body: string;
      }[]
    ).map((r) => JSON.parse(r.body));
  }
  patch(id: string, fields: Partial<Worker>): Worker {
    const w = { ...this.get(id), ...fields };
    this.db
      .query("UPDATE workers SET state=?,body=? WHERE worker_id=?")
      .run(w.state, JSON.stringify(w), id);
    return w;
  }
  transition(
    id: string,
    state: WorkerState,
    fields: Partial<Worker> = {},
  ): Worker {
    return this.db.transaction(() => {
      const w = this.get(id);
      if (w.state === state) return this.patch(id, fields);
      const updated = this.patch(id, {
        ...fields,
        state,
        last_activity_at: Date.now(),
      });
      this.event(id, `worker.${state}`);
      return updated;
    })();
  }
  event(id: string, type: EventType, data: Record<string, unknown> = {}) {
    this.db
      .query("INSERT INTO events(worker_id,type,at,data) VALUES(?,?,?,?)")
      .run(id, type, Date.now(), JSON.stringify(data));
    this.notify();
  }
  events(id?: string, after = 0, limit = 100): WorkerEvent[] {
    return this.db
      .query(
        "SELECT * FROM events WHERE (? IS NULL OR worker_id=?) AND id>? ORDER BY id LIMIT ?",
      )
      .all(id ?? null, id ?? null, after, limit) as WorkerEvent[];
  }
  latestEventId(): number {
    return (
      this.db.query("SELECT coalesce(max(id),0) id FROM events").get() as {
        id: number;
      }
    ).id;
  }
  // Ownership lives on the worker record, so filtering joins it. Rows stay in event-id order.
  lifecycleEvents(
    after: number,
    filter: { worker_id?: string; team_id?: string; task_id?: string },
    limit: number,
  ) {
    return this.db
      .query(
        `SELECT events.id,events.worker_id,events.type,events.at FROM events JOIN workers ON workers.worker_id=events.worker_id
        WHERE events.id>? AND (? IS NULL OR events.worker_id=?) AND (? IS NULL OR workers.team_id=?) AND (? IS NULL OR workers.task_id=?)
        ORDER BY events.id LIMIT ?`,
      )
      .all(
        after,
        filter.worker_id ?? null,
        filter.worker_id ?? null,
        filter.team_id ?? null,
        filter.team_id ?? null,
        filter.task_id ?? null,
        filter.task_id ?? null,
        limit,
      ) as { id: number; worker_id: string; type: EventType; at: number }[];
  }
  enqueue(id: string, message: string): Dispatch {
    const d: Dispatch = {
      run_id: randomUUID(),
      worker_id: id,
      message_id: `msg_${Date.now().toString(16)}${randomUUID().replaceAll("-", "")}`,
      message,
      state: "pending",
      created_at: Date.now(),
      sent_at: null,
      result: null,
    };
    this.db
      .query("INSERT INTO dispatches VALUES(?,?,?,?,?)")
      .run(d.run_id, id, d.message_id, d.state, JSON.stringify(d));
    return d;
  }
  dispatches(id: string): Dispatch[] {
    return (
      this.db
        .query("SELECT body FROM dispatches WHERE worker_id=? ORDER BY rowid")
        .all(id) as { body: string }[]
    ).map((r) => JSON.parse(r.body));
  }
  dispatch(id: string): Dispatch | undefined {
    return this.dispatches(id).find(
      (d) => !["completed", "cancelled"].includes(d.state),
    );
  }
  saveDispatch(d: Dispatch) {
    this.db
      .query("UPDATE dispatches SET state=?,body=? WHERE run_id=?")
      .run(d.state, JSON.stringify(d), d.run_id);
  }
  cancelDispatches(id: string) {
    for (const d of this.dispatches(id))
      if (!["completed", "cancelled"].includes(d.state))
        this.saveDispatch({ ...d, state: "cancelled" });
  }
  claimDispatch(w: Worker, d: Dispatch) {
    this.db.transaction(() => {
      this.saveDispatch({ ...d, state: "sending", sent_at: Date.now() });
      this.transition(w.worker_id, "running", {
        started_at: w.started_at ?? Date.now(),
        deadline_at: Date.now() + w.timeout_seconds * 1000,
        completed_at: null,
        error: null,
        // The idle clock starts at claim so a zero-token turn is still bounded.
        token_progress_at: Date.now(),
        token_progress_total: this.tokens({ worker_id: w.worker_id }).total,
        // The previous run's preservation settled before this dispatch was allowed, so its
        // record is retired here. Attempt and outcome history stays in the event log.
        finalization: undefined,
      });
    })();
  }
  // The preservation record for a settled outcome is written in the same transaction as that
  // outcome: a crash can never leave a finished run without a preservation intent, and a
  // preservation intent is never durable before the outcome it belongs to.
  settle(
    id: string,
    state: WorkerState,
    fields: Partial<Worker>,
    run_id: string | null,
  ): Worker {
    return this.db.transaction(() => {
      this.transition(id, state, fields);
      this.beginFinalization(id, run_id);
      return this.get(id);
    })();
  }
  beginFinalization(id: string, run_id: string | null): Worker {
    return this.db.transaction(() => {
      const w = this.get(id);
      // One record per run: a repeated settle for the same run never resets its attempts or
      // reopens an exhausted or abandoned record.
      if (w.finalization && w.finalization.run_id === run_id) return w;
      // Record creation is not an attempt, so it announces nothing: only the attempt itself and
      // the settled collection are durable events.
      return this.setFinalization(id, {
        state: "pending",
        run_id,
        attempts: 0,
        error: null,
        next_retry_at: null,
        started_at: null,
        completed_at: null,
      });
    })();
  }
  setFinalization(
    id: string,
    fields: Partial<WorkerFinalization>,
    event?: EventType,
  ): Worker {
    const before = this.get(id);
    const next = { ...emptyFinalization(), ...before.finalization, ...fields };
    const updated = this.patch(id, { finalization: next });
    const payload = {
      run_id: next.run_id,
      attempts: next.attempts,
      ...(next.error ? { error: next.error } : {}),
    };
    if (event) this.event(id, event, payload);
    // A settled collection is announced once; a scheduled retry is not a new outcome.
    else if (
      before.finalization?.state !== next.state &&
      (next.state === "preserved" ||
        next.state === "failed" ||
        next.state === "abandoned")
    )
      this.event(id, `finalization.${next.state}`, payload);
    return updated;
  }
  // Attempts are persisted before any side effect, so an interrupted collection is visible as
  // an attempt that started and can never be replayed for free after a restart.
  claimFinalization(
    id: string,
    maxAttempts: number,
  ): { run_id: string | null; attempts: number } | null {
    return this.db.transaction(() => {
      const w = this.get(id);
      const f = w.finalization;
      if (!f || (f.state !== "pending" && f.state !== "collecting"))
        return null;
      if (
        f.state === "pending" &&
        f.next_retry_at &&
        Date.now() < f.next_retry_at
      )
        return null;
      if (f.attempts >= maxAttempts) return null;
      const attempts = f.attempts + 1;
      // Announced on every attempt, including a restart re-entering an interrupted collecting
      // row, so the durable attempt count always matches the persisted attempts counter.
      this.setFinalization(
        id,
        {
          state: "collecting",
          attempts,
          started_at: f.started_at ?? Date.now(),
          next_retry_at: null,
          error: null,
        },
        "finalization.attempted",
      );
      return { run_id: f.run_id, attempts };
    })();
  }
  finalizationUnsettled(id: string) {
    const f = this.get(id).finalization;
    return Boolean(f && (f.state === "pending" || f.state === "collecting"));
  }
  finalizing(): Worker[] {
    return this.all().filter((w) =>
      w.finalization
        ? w.finalization.state === "pending" ||
          w.finalization.state === "collecting"
        : false,
    );
  }
  // Recorded progress is durable per worker; a restart must not reset the idle clock.
  recordProgress(id: string, total: number): Worker {
    const w = this.get(id);
    const seen = w.token_progress_at ?? null;
    const baseline = w.token_progress_total ?? 0;
    if (seen === null || total > baseline)
      return this.patch(id, {
        token_progress_at: Date.now(),
        token_progress_total: Math.max(total, baseline),
      });
    return w;
  }
  finish(id: string, d: Dispatch, result: WorkerResult) {
    this.db.transaction(() => {
      const current = this.dispatches(id).find((x) => x.run_id === d.run_id);
      if (
        !current ||
        current.state === "completed" ||
        current.state === "cancelled"
      )
        return;
      this.saveDispatch({ ...current, state: "completed", result });
      this.event(id, "result.received", {
        run_id: d.run_id,
        status: result.status,
      });
      this.transition(id, result.status, {
        completed_at: Date.now(),
        deadline_at: null,
        error: result.status === "failed" ? result.summary : null,
      });
      this.beginFinalization(id, d.run_id);
      if (this.dispatch(id))
        this.transition(id, "ready", { completed_at: null });
    })();
  }
  // Persists a validated result against its own run without settling that run, so a Git
  // handoff that fails or times out can never lose the worker's answer or its attribution.
  recordResult(id: string, d: Dispatch, result: WorkerResult) {
    const current = this.dispatches(id).find((x) => x.run_id === d.run_id);
    if (!current) return null;
    this.saveDispatch({ ...current, result });
    return result;
  }
  result(id: string, run?: string) {
    return (
      this.dispatches(id)
        .filter((d) => d.result && (!run || d.run_id === run))
        .at(-1)?.result ?? null
    );
  }
  usage(
    id: string,
    message: string,
    model: string,
    input: number,
    output: number,
    reasoning: number,
    read: number,
    write: number,
  ) {
    this.db
      .query(
        `INSERT INTO usage VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(worker_id,message_id) DO UPDATE SET input=max(input,excluded.input),output=max(output,excluded.output),reasoning=max(reasoning,excluded.reasoning),cache_read=max(cache_read,excluded.cache_read),cache_write=max(cache_write,excluded.cache_write)`,
      )
      .run(id, message, model, input, output, reasoning, read, write);
  }
  tokens(
    filter: { worker_id?: string; team_id?: string; task_id?: string } = {},
  ) {
    const row = this.db
      .query(
        `SELECT coalesce(sum(input),0) input,coalesce(sum(output),0) output,coalesce(sum(reasoning),0) reasoning,coalesce(sum(cache_read),0) cache_read,coalesce(sum(cache_write),0) cache_write FROM usage JOIN workers USING(worker_id) WHERE (? IS NULL OR worker_id=?) AND (? IS NULL OR team_id=?) AND (? IS NULL OR task_id=?)`,
      )
      .get(
        filter.worker_id ?? null,
        filter.worker_id ?? null,
        filter.team_id ?? null,
        filter.team_id ?? null,
        filter.task_id ?? null,
        filter.task_id ?? null,
      ) as {
      input: number;
      output: number;
      reasoning: number;
      cache_read: number;
      cache_write: number;
    };
    return {
      ...row,
      total:
        row.input +
        row.output +
        row.reasoning +
        row.cache_read +
        row.cache_write,
    };
  }
  teams() {
    return this.db
      .query(
        "SELECT teams.*,count(workers.worker_id) workers FROM teams LEFT JOIN workers USING(team_id) GROUP BY team_id",
      )
      .all();
  }
  tasks(team?: string) {
    return this.db
      .query(
        "SELECT tasks.*,count(workers.worker_id) workers FROM tasks LEFT JOIN workers USING(team_id,task_id) WHERE (? IS NULL OR tasks.team_id=?) GROUP BY tasks.team_id,tasks.task_id",
      )
      .all(team ?? null, team ?? null);
  }
}
