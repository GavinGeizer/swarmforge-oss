import { readFile } from "node:fs/promises";

export type FixtureSchema = "phase2b1" | "phase2b2";

const phase2b1 = ["0001_identity.sql", "0002_machine_identity.sql"];
const phase2b2 = [...phase2b1, "0003_hosted_execution.sql"];

// Reuse the actual committed cf migration scripts; never process-source fakes.
export function migrationFiles(schema: FixtureSchema = "phase2b2") {
  return schema === "phase2b1" ? [...phase2b1] : [...phase2b2];
}

export async function migrationStatements(schema: FixtureSchema = "phase2b2") {
  const out: string[] = [];
  for (const file of migrationFiles(schema)) {
    const sql = await readFile(
      new URL(`../migrations/${file}`, import.meta.url),
      "utf8",
    );
    for (const stmt of sql
      .replace(/--[^\n]*/g, "")
      .split(";")
      .map((x) => x.trim())
      .filter(Boolean))
      out.push(stmt);
  }
  return out;
}

interface RunnableDb {
  prepare(sql: string): {
    run(): Promise<unknown>;
    bind(...args: unknown[]): { run(): Promise<unknown> };
  };
}

export async function applyMigrations(
  db: RunnableDb,
  schema: FixtureSchema = "phase2b2",
) {
  for (const stmt of await migrationStatements(schema))
    await db.prepare(stmt).run();
}
