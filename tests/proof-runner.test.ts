// Regression tests for the two independent-review HIGH findings against the proof
// runner and the scale probe, plus live-database isolation.
//
// These exercise the runners' own helpers directly. Nothing here touches a
// credential, a real VM, or the live Swarmforge database, and no test runs the
// credentialed real mode.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  digestStream,
  preserveExisting,
  privateDir,
  privateRunPaths,
  writeRunReports,
} from "../scripts/artifact-salvage-real-proof";
import { duplicateFindings } from "../scripts/artifact-salvage-scale";

let root = "";
beforeEach(() => {
  root = privateDir(
    join(tmpdir(), `proof-runner-test-${process.pid}-${Date.now()}`),
  );
});
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("HIGH: a preserved report backup is immutable and runs stay separate", () => {
  // The defect: `preserveExisting` copied the previous report to `<report>.bak` and
  // the run's `finally` block then wrote the NEW report back over that same `.bak`,
  // so the "preserved" backup ended up holding the new run's bytes and every earlier
  // report was lost.
  test("the backup keeps the earlier report's bytes after a later run writes", () => {
    const report = join(root, "artifact-salvage-real-proof.json");
    const first = `${JSON.stringify({ result: "proven", run: 1 })}\n`;
    writeFileSync(report, first, { mode: 0o600 });

    // First run preserves what is on disk.
    const kept = preserveExisting(report, "stamp-1");
    expect(kept).not.toBeNull();
    expect(readFileSync(kept!, "utf8")).toBe(first);

    // Second run writes its own report file plus the newest-report pointer. This is
    // the step that used to overwrite the backup.
    const body = `${JSON.stringify({ result: "refused", run: 2 })}\n`;
    writeRunReports({
      pointer: report,
      run: join(root, "artifact-salvage-real-proof.2.json"),
      body,
    });

    // The backup still holds run 1, byte for byte.
    expect(readFileSync(kept!, "utf8")).toBe(first);
    expect(readFileSync(kept!, "utf8")).not.toContain("refused");
    // The pointer holds the newest report.
    expect(readFileSync(report, "utf8")).toBe(body);
  });

  test("two runs leave two intact run reports side by side", () => {
    const report = join(root, "artifact-salvage-real-proof.json");
    writeFileSync(report, `${JSON.stringify({ run: 1 })}\n`, { mode: 0o600 });
    const kept1 = preserveExisting(report, "stamp-1");

    const run1Body = `${JSON.stringify({ run: 1, result: "proven" })}\n`;
    const run1File = join(root, "artifact-salvage-real-proof.1.json");
    writeRunReports({ pointer: report, run: run1File, body: run1Body });

    // Second run: preserves run 1's pointer, then writes its own report.
    const kept2 = preserveExisting(report, "stamp-2");
    const run2Body = `${JSON.stringify({ run: 2, result: "refused" })}\n`;
    const run2File = join(root, "artifact-salvage-real-proof.2.json");
    writeRunReports({ pointer: report, run: run2File, body: run2Body });

    // Neither run's own report was destroyed by the other.
    expect(readFileSync(run1File, "utf8")).toBe(run1Body);
    expect(readFileSync(run2File, "utf8")).toBe(run2Body);
    expect(kept1).not.toBeNull();
    expect(kept2).not.toBeNull();
    expect(kept1).not.toBe(kept2);
    expect(readFileSync(kept1!, "utf8")).toContain('"run":1');
    expect(readFileSync(kept2!, "utf8")).toBe(run1Body);
    // The two backups are distinct files.
    expect(new Set([kept1, kept2]).size).toBe(2);
  });

  test("preserved backups are private files and preserveExisting reports absence", () => {
    expect(
      preserveExisting(join(root, "nothing-here.json"), "stamp-1"),
    ).toBeNull();
    const report = join(root, "artifact-salvage-real-proof.json");
    writeFileSync(report, "{}\n", { mode: 0o600 });
    const kept = preserveExisting(report, "stamp-1")!;
    expect(statSync(kept).mode & 0o777).toBe(0o600);
    expect(existsSync(kept)).toBe(true);
  });

  test("two runs in the same millisecond still get distinct backups", () => {
    // Backup names are keyed on the run's unique stamp, not on the clock, so two
    // quick runs cannot collide and silently drop the earlier report.
    const report = join(root, "artifact-salvage-real-proof.json");
    writeFileSync(report, `${JSON.stringify({ run: 1 })}\n`, { mode: 0o600 });
    const first = preserveExisting(report, "stamp-a");
    // The pointer is rewritten, then preserved again a microsecond later.
    writeFileSync(report, `${JSON.stringify({ run: 2 })}\n`, { mode: 0o600 });
    const second = preserveExisting(report, "stamp-b");
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first).not.toBe(second);
    expect(readFileSync(first!, "utf8")).toContain('"run":1');
    expect(readFileSync(second!, "utf8")).toContain('"run":2');
  });

  test("a colliding backup name is refused rather than overwritten", () => {
    const report = join(root, "artifact-salvage-real-proof.json");
    writeFileSync(report, `${JSON.stringify({ run: 1 })}\n`, { mode: 0o600 });
    const first = preserveExisting(report, "same-stamp")!;
    const original = readFileSync(first, "utf8");
    // The same stamp again would target the same path; the exclusive copy refuses.
    expect(preserveExisting(report, "same-stamp")).toBeNull();
    expect(readFileSync(first, "utf8")).toBe(original);
  });
});

describe("HIGH: a hash is digested exactly once", () => {
  // The defect: the post-destruction evidence for the large streamed artifact read
  // `hash.digest("hex")` and then called `hash.digest("hex")` again to compare. A Hash
  // is finalized by its first digest(), so the second call throws
  // ERR_CRYPTO_HASH_FINALIZED, which aborted the proof after the VM was already gone.
  test("digesting twice throws, which is the defect being regression-tested", () => {
    const hash = createHash("sha256");
    hash.update("payload");
    expect(hash.digest("hex")).toHaveLength(64);
    expect(() => hash.digest("hex")).toThrow();
  });

  test("digestStream returns one usable digest for a multi-chunk stream", async () => {
    const chunks = [Buffer.from("abc"), Buffer.from("def"), Buffer.from("ghi")];
    async function* stream() {
      for (const chunk of chunks) yield new Uint8Array(chunk);
    }
    const expected = createHash("sha256").update("abcdefghi").digest("hex");
    const result = await digestStream(stream());
    expect(result.sha256).toBe(expected);
    expect(result.bytes).toBe(9);
    // The returned value is a plain string, so comparing it cannot finalize a second
    // time and throw.
    expect(result.sha256 === expected).toBe(true);
    expect(result.sha256 === expected).toBe(true);
  });

  test("digestStream matches a single-shot digest over the same bytes", async () => {
    const payload = Buffer.alloc(64 * 1024, 0x7);
    async function* chunked() {
      for (let i = 0; i < payload.length; i += 4096)
        yield new Uint8Array(payload.subarray(i, i + 4096));
    }
    const expected = createHash("sha256").update(payload).digest("hex");
    const result = await digestStream(chunked());
    expect(result.sha256).toBe(expected);
    expect(result.bytes).toBe(payload.byteLength);
  });
});

describe("MEDIUM: the private database never inherits the live one", () => {
  // The defect: the private store path was only supplied when
  // `process.env.SWARMFORGE_DB_PATH` was unset, so on a host that has the live
  // Swarmforge database configured the runner would open, migrate and write it.
  test("private paths are derived from the evidence directory, not the environment", () => {
    const before = process.env.SWARMFORGE_DB_PATH;
    // Point the environment at what a live host would have.
    process.env.SWARMFORGE_DB_PATH = "/var/lib/swarmforge/live.sqlite";
    try {
      const paths = privateRunPaths(root, "stamp-1");
      expect(paths.dbPath).toBe(join(root, "proof-stamp-1.sqlite"));
      expect(paths.artifactDir).toBe(join(root, "artifacts-stamp-1"));
      expect(paths.dbPath).not.toContain("live.sqlite");
      expect(paths.dbPath.startsWith(`${root}/`)).toBe(true);
      expect(paths.artifactDir.startsWith(`${root}/`)).toBe(true);
      expect(paths.snapshot.startsWith(`${root}/`)).toBe(true);
    } finally {
      if (before === undefined) delete process.env.SWARMFORGE_DB_PATH;
      else process.env.SWARMFORGE_DB_PATH = before;
    }
  });

  test("two runs never share a private database file", () => {
    const first = privateRunPaths(root, "stamp-1");
    const second = privateRunPaths(root, "stamp-2");
    expect(first.dbPath).not.toBe(second.dbPath);
    expect(first.artifactDir).not.toBe(second.artifactDir);
  });

  test("the evidence directory and its database are private", () => {
    expect(statSync(privateDir(root)).mode & 0o777).toBe(0o700);
    const dbPath = privateRunPaths(root, "stamp-1").dbPath;
    expect(statSync(privateDir(root)).mode & 0o777).toBe(0o700);
    expect(dbPath.startsWith(root)).toBe(true);
    // The parent of the private database is the 0700 evidence directory, so the
    // 0600 database file is not reachable by other users.
    expect(statSync(join(root)).mode & 0o077).toBe(0);
  });
});

describe("MEDIUM: duplicated artifacts fail the scale probe", () => {
  // The defect: duplicate counters were computed and reported while the probe still
  // exited 0, so 12 duplicated paths / 24 duplicated records passed unnoticed.
  test("a file that is both declared and swept is found as a duplicate", () => {
    const records = [
      {
        worker_id: "w-1",
        run_id: "r-1",
        original_path: ".swarmforge/artifacts/w0-report.json",
        kind: "declared",
      },
      {
        worker_id: "w-1",
        run_id: "r-1",
        original_path: ".swarmforge/artifacts/w0-report.json",
        kind: "file",
      },
    ];
    const found = duplicateFindings(records);
    expect(found.paths).toBe(1);
    expect(found.records).toBe(2);
    expect(found.kinds[0]).toEqual(["declared", "file"]);
  });

  test("distinct paths, workers and runs are not duplicates", () => {
    const records = [
      { worker_id: "w-1", run_id: "r-1", original_path: "a", kind: "file" },
      { worker_id: "w-1", run_id: "r-1", original_path: "b", kind: "file" },
      { worker_id: "w-2", run_id: "r-1", original_path: "a", kind: "file" },
      { worker_id: "w-1", run_id: "r-2", original_path: "a", kind: "file" },
    ];
    const found = duplicateFindings(records);
    expect(found.paths).toBe(0);
    expect(found.records).toBe(0);
  });

  test("the shape the review reported is detected: 12 paths / 24 records", () => {
    const records = [];
    for (let i = 0; i < 12; i++)
      for (const kind of ["declared", "file"])
        records.push({
          worker_id: `w-${i}`,
          run_id: "r",
          original_path: `.swarmforge/artifacts/w${i}-report.json`,
          kind,
        });
    const found = duplicateFindings(records);
    expect(found.paths).toBe(12);
    expect(found.records).toBe(24);
  });
});
