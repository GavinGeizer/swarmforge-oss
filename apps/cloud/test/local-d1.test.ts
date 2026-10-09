import { expect, test } from "bun:test";
import { LocalD1 } from "./local-d1.ts";

test("SQLite adapter preserves zero-change success inside an atomic batch", async () => {
  const db = new LocalD1();
  try {
    db.sqlite.exec(
      "CREATE TABLE effects(id INTEGER PRIMARY KEY, n INTEGER NOT NULL CHECK(n>=0)); INSERT INTO effects VALUES(1,0)",
    );
    const result = await db.batch([
      db.prepare("UPDATE effects SET n=1 WHERE id=1"),
      db.prepare("UPDATE effects SET n=2 WHERE id=99"),
    ]);
    expect(result[1]!.meta.changes).toBe(0);
    expect(
      await db.prepare("SELECT n FROM effects WHERE id=1").first("n"),
    ).toBe(1);
    await expect(
      db.batch([
        db.prepare("UPDATE effects SET n=3 WHERE id=1"),
        db.prepare("UPDATE effects SET n=-1 WHERE id=1"),
      ]),
    ).rejects.toThrow();
    expect(
      await db.prepare("SELECT n FROM effects WHERE id=1").first("n"),
    ).toBe(1);
  } finally {
    db.close();
  }
});
