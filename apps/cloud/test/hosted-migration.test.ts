import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { LocalD1 } from "./local-d1.ts";
import { localFixture } from "./local-fixture.ts";

const migration = (name: string) =>
  readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
const hostedTables = [
  "hosted_entitlements",
  "hosted_allowances",
  "hosted_execution_grants",
  "hosted_supervisors",
  "hosted_supervisor_credentials",
  "hosted_supervisor_rotations",
  "hosted_tasks",
  "hosted_reservations",
  "hosted_outbox",
  "hosted_operations",
];

// Complementary SQLite checks execute the complete committed migration SQL.
// Real local workerd/D1 migration coverage remains in hosted-schema.integration.ts.
test("clean database accepts all migrations with foreign keys enforced and no execution grants", () => {
  const db = new LocalD1();
  try {
    for (const name of [
      "0001_identity.sql",
      "0002_machine_identity.sql",
      "0003_hosted_execution.sql",
    ])
      db.sqlite.exec(migration(name));
    for (const table of hostedTables)
      expect(db.sqlite.query(`SELECT count(*) n FROM ${table}`).get()).toEqual({
        n: 0,
      });
    expect(db.sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.sqlite.query("PRAGMA foreign_keys").get()).toEqual({
      foreign_keys: 1,
    });
  } finally {
    db.close();
  }
});

test("Phase 2B.1 database upgrade preserves linked CLI and enrolled worker authority", async () => {
  const h = await localFixture({ schema: "phase2b1" });
  try {
    const a = await h.login();
    const linked = await h.linked(a);
    await h.enrolledWorker(a);
    const tables = [
      "users",
      "organizations",
      "memberships",
      "sessions",
      "cli_installations",
      "cloud_workers",
      "machine_credentials",
    ];
    const before = tables.map((table) =>
      h.db.sqlite.query(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    );
    h.db.sqlite.exec(migration("0003_hosted_execution.sql"));
    const after = tables.map((table) =>
      h.db.sqlite.query(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    );
    expect(after).toEqual(before);
    expect(h.db.sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect((await h.request("/ready")).status).toBe(200);
    expect(
      (
        await h.request("/v1/cli/me", {
          authorization: `Bearer ${linked.credential}`,
        })
      ).status,
    ).toBe(200);
    expect(
      h.db.sqlite.query("SELECT count(*) n FROM hosted_entitlements").get(),
    ).toEqual({ n: 0 });
  } finally {
    h.close();
  }
});
