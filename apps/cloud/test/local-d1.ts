/// <reference types="bun" />
import { Database, type SQLQueryBindings } from "bun:sqlite";

// Complementary SQL integration adapter. Executes production SQL against real
// SQLite with foreign keys and transactional batches. This is NOT workerd/D1;
// it supplies no edge CPU or D1 scanned-row measurements. Keep live D1 tests.
export class LocalStatement {
  constructor(
    readonly owner: LocalD1,
    readonly sql: string,
    readonly args: SQLQueryBindings[] = [],
  ) {}

  bind(...values: unknown[]): LocalStatement {
    if (values.length > 100)
      throw new Error("D1 bound parameter limit exceeded");
    const args = values.map((value): SQLQueryBindings => {
      if (
        value === null ||
        typeof value === "string" ||
        (typeof value === "number" && Number.isFinite(value)) ||
        value instanceof Uint8Array
      )
        return value;
      throw new Error("Unsupported D1 binding value");
    });
    return new LocalStatement(this.owner, this.sql, args);
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const result = this.owner.execute<Record<string, unknown>>(this);
    const row = result.results[0];
    if (!row) return null;
    return (column === undefined ? row : (row[column] ?? null)) as T | null;
  }

  async all<T = Record<string, unknown>>() {
    return this.owner.execute<T>(this);
  }

  async run<T = Record<string, unknown>>() {
    return this.owner.execute<T>(this);
  }
}

export class LocalD1 {
  readonly sqlite: Database;
  queryCalls = 0;
  beforeBatch?: (statements: readonly LocalStatement[]) => void | Promise<void>;

  constructor(path = ":memory:") {
    this.sqlite = new Database(path);
    this.sqlite.exec("PRAGMA foreign_keys=ON");
  }

  prepare(sql: string) {
    return new LocalStatement(this, sql);
  }

  execute<T>(statement: LocalStatement) {
    this.queryCalls++;
    const before = this.sqlite.query("SELECT total_changes() n").get() as {
      n: number;
    };
    const results = this.sqlite
      .query(statement.sql)
      .all(...statement.args) as T[];
    const after = this.sqlite.query("SELECT total_changes() n").get() as {
      n: number;
    };
    const changes = after.n - before.n;
    return {
      success: true as const,
      results,
      meta: {
        changes,
        changed_db: changes > 0,
        // Returned rows only: deliberately do not invent D1 rows_read/written.
        duration: 0,
        last_row_id: (
          this.sqlite.query("SELECT last_insert_rowid() n").get() as {
            n: number;
          }
        ).n,
      },
    };
  }

  async batch<T = Record<string, unknown>>(statements: LocalStatement[]) {
    await this.beforeBatch?.(statements);
    return this.sqlite.transaction(() =>
      statements.map((statement) => this.execute<T>(statement)),
    )();
  }

  close() {
    this.sqlite.close();
  }
}
