// Regression tests for the two independent-review HIGH findings against the proof
// runner and the scale probe, plus live-database isolation.
//
// These exercise the runners' own helpers directly. Nothing here touches a
// credential, a real VM, or the live Swarmforge database, and no test runs the
// credentialed real mode.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertDataPlane,
  assertOwnerCopyUnchanged,
  assertOwnerGate,
  assertProviderTarget,
  defaultEvidenceDir,
  digestStream,
  Evidence,
  ownerGate,
  type Provenance,
  preserveExisting,
  privateArtifactDir,
  privateDir,
  privateOwnerCopy,
  privateRunPaths,
  readProvenance,
  streamedArtifactDigest,
  writeRunReports,
} from "../scripts/artifact-salvage-real-proof";
import { duplicateFindings } from "../scripts/artifact-salvage-scale";
import { loadConfig } from "../src/config";

/**
 * The proof runner's own source with `//` line comments removed, so a statement
 * about what the CODE does is not confused by prose describing the defect it
 * replaces.
 */
function proofCode(): string {
  return readFileSync(
    join(import.meta.dir, "..", "scripts", "artifact-salvage-real-proof.ts"),
    "utf8",
  )
    .split("\n")
    .map((line) => line.replace(/^\s*\/\/.*$/, ""))
    .join("\n");
}
function scaleCode(): string {
  return readFileSync(
    join(import.meta.dir, "..", "scripts", "artifact-salvage-scale.ts"),
    "utf8",
  )
    .split("\n")
    .map((line) => line.replace(/^\s*\/\/.*$/, ""))
    .join("\n");
}

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
      // The destruction phase gets its OWN database file, so the proof's salvage
      // record and the original owner's record never share one database.
      expect(paths.destructionDb).toBe(join(root, "owner-stamp-1.sqlite"));
      expect(paths.destructionDb).not.toBe(paths.dbPath);
      expect(paths.destructionDb.startsWith(`${root}/`)).toBe(true);
    } finally {
      if (before === undefined) delete process.env.SWARMFORGE_DB_PATH;
      else process.env.SWARMFORGE_DB_PATH = before;
    }
  });

  test("a partial loadConfig env fails, so the host environment must be spread in", () => {
    // loadConfig's env argument defaults to process.env ONLY when it is omitted.
    // A partial object therefore does not fall back to the host: it fails
    // validation, because these have no default.
    expect(() =>
      loadConfig({
        SWARMFORGE_DB_PATH: join(root, "proof.sqlite"),
        SWARMFORGE_ARTIFACT_DIR: join(root, "artifacts"),
      }),
    ).toThrow();
    // Spreading the real environment over the forced private paths loads cleanly
    // and still resolves the private database, never a host-configured one.
    // These mandatory values are inert placeholders for validation only; this test
    // holds no credential and opens no connection.
    const env = {
      ...process.env,
      FREESTYLE_API_TOKEN: "test-placeholder",
      FREESTYLE_SNAPSHOT_ID: "test-placeholder",
      SWARMFORGE_MODEL_BASE_URL: "http://127.0.0.1:0",
      SWARMFORGE_MODEL_NAME: "test-placeholder",
      SWARMFORGE_MODEL_API_KEY: "test-placeholder",
      // Mandatory with no default, so it is pinned here rather than inherited:
      // `none:` names a prepared tree and is never cloned, so the fixture does
      // not depend on the host exporting a Swarmforge-only variable.
      SWARMFORGE_GIT_TREE: "none:test",
      SWARMFORGE_DB_PATH: join(root, "proof.sqlite"),
      SWARMFORGE_ARTIFACT_DIR: join(root, "artifacts"),
    };
    const loaded = loadConfig(env);
    expect(loaded.SWARMFORGE_DB_PATH).toBe(join(root, "proof.sqlite"));
    // The artifact-store key is read through the declared lookup, not a direct
    // property: on a checkout without the data plane's config schema the key is
    // simply absent, and the runner's own `privateArtifactDir` refuses rather
    // than inventing a location. The value the runner FORCES is what matters, and
    // it is the env value below.
    expect(privateArtifactDir(env)).toBe(join(root, "artifacts"));
  });

  test("forcing the private path overrides a host that pre-sets a live one", () => {
    // The order matters: the forced keys come last, so a host whose environment
    // already points at the live database cannot redirect this runner.
    const privatePaths = privateRunPaths(root, "stamp-1");
    const host = {
      ...process.env,
      FREESTYLE_API_TOKEN: "test-placeholder",
      FREESTYLE_SNAPSHOT_ID: "test-placeholder",
      SWARMFORGE_MODEL_BASE_URL: "http://127.0.0.1:0",
      SWARMFORGE_MODEL_NAME: "test-placeholder",
      SWARMFORGE_MODEL_API_KEY: "test-placeholder",
      // Pinned for the same reason as above: mandatory, no default, and never
      // present on a clean host.
      SWARMFORGE_GIT_TREE: "none:test",
      // A host that already points at the live database and artifacts.
      SWARMFORGE_DB_PATH: "/var/lib/swarmforge/live.sqlite",
      SWARMFORGE_ARTIFACT_DIR: "/var/lib/swarmforge/live-artifacts",
    };
    // This is the shape the runner uses: the host environment first, then the
    // private paths forced over it.
    const loaded = loadConfig({
      ...host,
      SWARMFORGE_DB_PATH: privatePaths.dbPath,
      SWARMFORGE_ARTIFACT_DIR: privatePaths.artifactDir,
    });
    expect(loaded.SWARMFORGE_DB_PATH).toBe(join(root, "proof-stamp-1.sqlite"));
    // The artifact store resolves to the private directory, never the host's
    // `/var/lib/swarmforge/live-artifacts`. This is asserted on the env the runner
    // builds, because `loadConfig` returns its schema's output and this branch's
    // schema does not carry the data plane's key at all; where the data plane is
    // present the same forced value survives the load and the refusal test below
    // is what catches its absence.
    const forced = {
      ...host,
      SWARMFORGE_DB_PATH: privatePaths.dbPath,
      SWARMFORGE_ARTIFACT_DIR: privatePaths.artifactDir,
    };
    expect(privateArtifactDir(forced)).toBe(join(root, "artifacts-stamp-1"));
    expect(privateArtifactDir(forced)).not.toContain("live-artifacts");
    expect(privateArtifactDir(host)).toBe("/var/lib/swarmforge/live-artifacts");
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

describe("Git durability provenance is truthful, never fabricated", () => {
  const VM = "vm-debbc6d8e4cf4705ba96574c8f1ac519";
  const WORKER = "w-c6875611-3237-4c55-aa4b-8e5c047e6efb";
  const TEAM = "artifact-salvage-20261001";
  const TASK = "harden-data-plane";
  const BRANCH = `swarmforge/${TEAM}/${TASK}/${WORKER}`;

  /** A read-only snapshot shaped exactly like the live store's own schema. */
  function snapshot(overrides?: {
    vmId?: string | null;
    result?: Record<string, unknown> | null;
    dispatchState?: string;
  }) {
    const path = join(root, "provenance.sqlite");
    const db = new Database(path, { create: true });
    // One statement per exec: `exec(sql, ...params)` binds extra arguments, so
    // passing two statements to one call would bind the second as a parameter.
    db.exec(
      "CREATE TABLE workers(worker_id TEXT PRIMARY KEY,team_id TEXT NOT NULL,task_id TEXT NOT NULL,state TEXT NOT NULL,request_id TEXT,body TEXT NOT NULL,UNIQUE(team_id,request_id));",
    );
    db.exec(
      "CREATE TABLE dispatches(run_id TEXT PRIMARY KEY,worker_id TEXT NOT NULL,message_id TEXT NOT NULL UNIQUE,state TEXT NOT NULL,body TEXT NOT NULL);",
    );
    db.query("INSERT INTO workers VALUES (?,?,?,?,?,?)").run(
      WORKER,
      TEAM,
      TASK,
      "failed",
      null,
      JSON.stringify({
        worker_id: WORKER,
        team_id: TEAM,
        task_id: TASK,
        state: "failed",
        vm_id: overrides?.vmId === undefined ? VM : overrides.vmId,
      }),
    );
    if (overrides?.result !== null)
      db.query("INSERT INTO dispatches VALUES (?,?,?,?,?)").run(
        "run-1",
        WORKER,
        "msg-1",
        overrides?.dispatchState ?? "completed",
        JSON.stringify({
          run_id: "run-1",
          worker_id: WORKER,
          message_id: "msg-1",
          message: "",
          state: overrides?.dispatchState ?? "completed",
          created_at: 1,
          sent_at: 1,
          result: overrides?.result ?? {
            status: "completed",
            summary: "real work",
            git: { persisted: true, branch: BRANCH, workspace: "/workspace" },
          },
        }),
      );
    db.close();
    return path;
  }

  test("a verified handoff yields the identity and the real published branch", () => {
    const p = readProvenance(snapshot(), WORKER, VM);
    expect(p.team_id).toBe(TEAM);
    expect(p.task_id).toBe(TASK);
    expect(p.worker_id).toBe(WORKER);
    // The branch comes from the ORIGINAL owner's identity, not a fresh worker id.
    expect(p.branch).toBe(BRANCH);
    expect(p.reported_branch).toBe(BRANCH);
    expect(p.latest_state).toBe("completed");
    // The owner's own state is reported separately from its dispatch's, because
    // the two are not the same fact and a gate needs both.
    expect(p.worker_state).toBe("failed");
    expect(p.latest_persisted).toBe(true);
  });

  test("an unverified handoff is reported unverified, never upgraded", () => {
    const p = readProvenance(
      snapshot({
        result: {
          status: "completed",
          summary: "x",
          git: { persisted: false, branch: BRANCH },
        },
      }),
      WORKER,
      VM,
    );
    expect(p.latest_persisted).toBe(false);
  });

  test("no result at all is reported as no verified handoff", () => {
    const p = readProvenance(snapshot({ result: null }), WORKER, VM);
    expect(p.latest_persisted).toBe(false);
    expect(p.latest_run_id).toBeNull();
    expect(p.reported_branch).toBeNull();
  });

  test("a VM mismatch refuses instead of adopting a different guest", () => {
    expect(() =>
      readProvenance(snapshot({ vmId: "vm-someone-else" }), WORKER, VM),
    ).toThrow(/not vm-debbc6d8e4cf4705ba96574c8f1ac519/);
  });

  test("an unknown worker refuses rather than inventing a record", () => {
    expect(() =>
      readProvenance(snapshot(), "w-not-in-the-snapshot", VM),
    ).toThrow(/refusing to invent one/);
  });

  test("a branch the real result does not report refuses the run", () => {
    // The identity computes BRANCH but the real result claims a different branch;
    // acting on that would be a durability proof about the wrong branch.
    expect(() =>
      readProvenance(
        snapshot({
          result: {
            status: "completed",
            summary: "x",
            git: { persisted: true, branch: "swarmforge/some/other/branch" },
          },
        }),
        WORKER,
        VM,
      ),
    ).toThrow(/provenance branch mismatch/);
  });

  test("a missing snapshot is refused", () => {
    expect(() =>
      readProvenance(join(root, "absent.sqlite"), WORKER, VM),
    ).toThrow(/not found/);
  });
});

// -----------------------------------------------------------------------------
// H1: the provenance read must not mix two different dispatch rows.
// -----------------------------------------------------------------------------

describe("HIGH: the result comes from the newest dispatch only", () => {
  const VM = "vm-debbc6d8e4cf4705ba96574c8f1ac519";
  const WORKER = "w-c6875611-3237-4c55-aa4b-8e5c047e6efb";
  const TEAM = "artifact-salvage-20261001";
  const TASK = "harden-data-plane";
  const BRANCH = `swarmforge/${TEAM}/${TASK}/${WORKER}`;

  /**
   * The exact shape the defect needed: the owner's newest dispatch is `completed`
   * but carries NO result, and an OLDER dispatch carries a fully verified one.
   * Rows are inserted in order, so rowid order is dispatch order.
   */
  function newestNullOlderVerified() {
    const path = join(root, "newest-null.sqlite");
    const db = new Database(path, { create: true });
    db.exec(
      "CREATE TABLE workers(worker_id TEXT PRIMARY KEY,team_id TEXT NOT NULL,task_id TEXT NOT NULL,state TEXT NOT NULL,request_id TEXT,body TEXT NOT NULL,UNIQUE(team_id,request_id));",
    );
    db.exec(
      "CREATE TABLE dispatches(run_id TEXT PRIMARY KEY,worker_id TEXT NOT NULL,message_id TEXT NOT NULL UNIQUE,state TEXT NOT NULL,body TEXT NOT NULL);",
    );
    db.query("INSERT INTO workers VALUES (?,?,?,?,?,?)").run(
      WORKER,
      TEAM,
      TASK,
      "completed",
      null,
      JSON.stringify({
        worker_id: WORKER,
        team_id: TEAM,
        task_id: TASK,
        state: "completed",
        vm_id: VM,
      }),
    );
    // Older, verified.
    db.query("INSERT INTO dispatches VALUES (?,?,?,?,?)").run(
      "run-old-verified",
      WORKER,
      "msg-old",
      "completed",
      JSON.stringify({
        run_id: "run-old-verified",
        worker_id: WORKER,
        message_id: "msg-old",
        message: "",
        state: "completed",
        created_at: 1,
        sent_at: 1,
        result: {
          status: "completed",
          summary: "older real work",
          git: { persisted: true, branch: BRANCH, workspace: "/workspace" },
        },
      }),
    );
    // Newest, completed, NO result: the owner's latest run proved nothing.
    db.query("INSERT INTO dispatches VALUES (?,?,?,?,?)").run(
      "run-new-null",
      WORKER,
      "msg-new",
      "completed",
      JSON.stringify({
        run_id: "run-new-null",
        worker_id: WORKER,
        message_id: "msg-new",
        message: "",
        state: "completed",
        created_at: 2,
        sent_at: 2,
        result: null,
      }),
    );
    db.close();
    return path;
  }

  test("an older verified result is NOT reported for a newest dispatch with no result", () => {
    // The defect: `.find((d) => d.result !== null)` walked backwards and returned
    // the older verified result, so this reported a verified handoff.
    const p = readProvenance(newestNullOlderVerified(), WORKER, VM);
    // Everything now describes the newest row and nothing else.
    expect(p.latest_run_id).toBe("run-new-null");
    expect(p.latest_state).toBe("completed");
    expect(p.latest_persisted).toBe(false);
    expect(p.git).toBeNull();
    expect(p.reported_branch).toBeNull();
    // The row count is reported so a mixed answer is visible rather than silent.
    expect(p.dispatch_count).toBe(2);
  });

  test("that state is refused by the owner gate, naming the failing precondition", () => {
    const p = readProvenance(newestNullOlderVerified(), WORKER, VM);
    const gate = ownerGate(p);
    expect(gate.ok).toBe(false);
    // NOT "identity" and NOT "branch_mismatch": the identity is right and there
    // is no reported branch to mismatch, it is the source that is unverified.
    expect(gate.failed).toBe("source_unverified");
    expect(() => assertOwnerGate(p)).toThrow(/source_unverified/);
    expect(() => assertOwnerGate(p)).toThrow(/before any guest mutation/);
  });

  test("the newest dispatch is the row that decides, whichever way it goes", () => {
    // Same two rows with the order reversed: now the newest IS the verified one,
    // so the gate must open. A gate that ignored order could not do both.
    const path = join(root, "reversed.sqlite");
    const db = new Database(path, { create: true });
    db.exec(
      "CREATE TABLE workers(worker_id TEXT PRIMARY KEY,team_id TEXT NOT NULL,task_id TEXT NOT NULL,state TEXT NOT NULL,request_id TEXT,body TEXT NOT NULL,UNIQUE(team_id,request_id));",
    );
    db.exec(
      "CREATE TABLE dispatches(run_id TEXT PRIMARY KEY,worker_id TEXT NOT NULL,message_id TEXT NOT NULL UNIQUE,state TEXT NOT NULL,body TEXT NOT NULL);",
    );
    db.query("INSERT INTO workers VALUES (?,?,?,?,?,?)").run(
      WORKER,
      TEAM,
      TASK,
      "completed",
      null,
      JSON.stringify({
        worker_id: WORKER,
        team_id: TEAM,
        task_id: TASK,
        state: "completed",
        vm_id: VM,
      }),
    );
    db.query("INSERT INTO dispatches VALUES (?,?,?,?,?)").run(
      "run-a-null",
      WORKER,
      "msg-a",
      "completed",
      JSON.stringify({
        run_id: "run-a-null",
        worker_id: WORKER,
        message_id: "msg-a",
        message: "",
        state: "completed",
        created_at: 1,
        sent_at: 1,
        result: null,
      }),
    );
    db.query("INSERT INTO dispatches VALUES (?,?,?,?,?)").run(
      "run-b-verified",
      WORKER,
      "msg-b",
      "completed",
      JSON.stringify({
        run_id: "run-b-verified",
        worker_id: WORKER,
        message_id: "msg-b",
        message: "",
        state: "completed",
        created_at: 2,
        sent_at: 2,
        result: {
          status: "completed",
          summary: "real work",
          git: { persisted: true, branch: BRANCH, workspace: "/workspace" },
        },
      }),
    );
    db.close();
    const p = readProvenance(path, WORKER, VM);
    expect(p.latest_run_id).toBe("run-b-verified");
    expect(p.latest_persisted).toBe(true);
    expect(ownerGate(p).ok).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// H2: the gate runs before ANY guest mutation, on every real run.
// -----------------------------------------------------------------------------

describe("HIGH: the owner gate is a precondition, not a destroy extra", () => {
  const VM = "vm-debbc6d8e4cf4705ba96574c8f1ac519";
  const WORKER = "w-c6875611-3237-4c55-aa4b-8e5c047e6efb";
  const TEAM = "artifact-salvage-20261001";
  const TASK = "harden-data-plane";
  const BRANCH = `swarmforge/${TEAM}/${TASK}/${WORKER}`;

  /** A well-formed provenance, for mutating one field at a time. */
  function good(over: Partial<Provenance> = {}): Provenance {
    return {
      team_id: TEAM,
      task_id: TASK,
      worker_id: WORKER,
      branch: BRANCH,
      reported_branch: BRANCH,
      git: { persisted: true, branch: BRANCH },
      latest_run_id: "run-1",
      latest_state: "completed",
      worker_state: "completed",
      latest_persisted: true,
      dispatch_count: 1,
      vm_id: VM,
      ...over,
    };
  }

  test("a fully verified, finished, on-target record opens the gate", () => {
    expect(ownerGate(good())).toEqual({
      ok: true,
      failed: null,
      detail: null,
    });
  });

  test("each precondition is reported by name", () => {
    // The target must be the fixed guest, not a different one that happens to
    // carry a verified result.
    expect(ownerGate(good({ vm_id: "vm-someone-else" })).failed).toBe("target");
    // The owner must have finished.
    expect(ownerGate(good({ latest_state: "failed" })).failed).toBe(
      "owner_finished",
    );
    expect(ownerGate(good({ latest_state: "running" })).failed).toBe(
      "owner_finished",
    );
    // The source must be verified.
    expect(ownerGate(good({ latest_persisted: false })).failed).toBe(
      "source_unverified",
    );
    // The OWNER ITSELF must be finished. A completed, verified dispatch inside a
    // worker that is still running, paused or in recovery is not a finished owner,
    // and its guest is still live.
    for (const state of ["running", "ready", "paused", "recovery_required"])
      expect(ownerGate(good({ worker_state: state })).failed).toBe(
        "owner_active",
      );
    // A failed or cancelled owner is finished but did not finish successfully, so
    // it is not a durability proof either.
    for (const state of ["failed", "cancelled", "destroyed"])
      expect(ownerGate(good({ worker_state: state })).failed).toBe(
        "owner_active",
      );
    // The branch must be the published one.
    expect(ownerGate(good({ reported_branch: null })).failed).toBe(
      "branch_mismatch",
    );
    // A different identity is not the owner.
    expect(ownerGate(good({ worker_id: "w-other" })).failed).toBe("identity");
    // A snapshot with no dispatch at all proves nothing.
    expect(
      ownerGate(good({ latest_run_id: null, dispatch_count: 0 })).failed,
    ).toBe("no_dispatch");
  });

  test("a refusal names the fact and keeps the guest", () => {
    let thrown: unknown = null;
    try {
      assertOwnerGate(good({ latest_persisted: false }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toMatch(/refusing before any guest mutation/);
    expect(message).toMatch(/git\.persisted=false/);
    // The refusal carries the retained guest, so a report never implies the VM
    // was touched.
    expect((thrown as { retained?: Record<string, unknown> }).retained).toEqual(
      {
        retained_vm: VM,
        gate: "source_unverified",
      },
    );
  });

  test("a fresh provider status is required and must be the fixed VM", () => {
    // The snapshot can only say what was true when the lead captured it, so the
    // runner asks the provider itself. A wrong id is refused rather than used.
    expect(
      assertProviderTarget({ id: VM, slug: "x", state: "running" }).id,
    ).toBe(VM);
    expect(() => assertProviderTarget(null)).toThrow(/not reachable/);
    expect(() =>
      assertProviderTarget({ id: "vm-other", slug: "x", state: "running" }),
    ).toThrow(/answered a different VM/);
  });

  test("--execute without a provenance snapshot is refused before anything runs", async () => {
    // The real proof runner as a program, in the one mode that needs no
    // credential, no network and no guest. Inert apart from argument handling.
    const source = proofCode();
    // The refusal is a precondition in `main`, before the plan/execute split and
    // therefore before any provider call, so a plain --execute cannot mutate.
    const gate = source.indexOf("--execute requires --provenance-db");
    const firstGuestCall = source.indexOf("provider.getWorker(PROOF_VM)");
    expect(gate).toBeGreaterThan(-1);
    expect(firstGuestCall).toBeGreaterThan(-1);
    // Every first guest observation happens after the gate: the gate is inside
    // `main` and the provider is only reached inside the `try` that follows it.
    expect(gate).toBeLessThan(firstGuestCall);
  });
});

// -----------------------------------------------------------------------------
// H3: the private owner copy, and its re-verification.
// -----------------------------------------------------------------------------

describe("HIGH: destruction runs on a private copy of the owner's real record", () => {
  const VM = "vm-debbc6d8e4cf4705ba96574c8f1ac519";
  const WORKER = "w-c6875611-3237-4c55-aa4b-8e5c047e6efb";
  const TEAM = "artifact-salvage-20261001";
  const TASK = "harden-data-plane";
  const BRANCH = `swarmforge/${TEAM}/${TASK}/${WORKER}`;

  function approved(): Provenance {
    return {
      team_id: TEAM,
      task_id: TASK,
      worker_id: WORKER,
      branch: BRANCH,
      reported_branch: BRANCH,
      git: { persisted: true, branch: BRANCH },
      latest_run_id: "run-1",
      latest_state: "completed",
      worker_state: "completed",
      latest_persisted: true,
      dispatch_count: 1,
      vm_id: VM,
    };
  }

  test("the copy is a private, exclusive, byte-identical copy of the snapshot", () => {
    const source = join(root, "source.sqlite");
    writeFileSync(source, "not-really-a-database", { mode: 0o600 });
    const dest = privateRunPaths(root, "stamp-1").destructionDb;
    expect(privateOwnerCopy(source, dest)).toBe(dest);
    expect(readFileSync(dest, "utf8")).toBe("not-really-a-database");
    expect(statSync(dest).mode & 0o777).toBe(0o600);
    // A second copy under the same name is refused, never an overwrite.
    expect(() => privateOwnerCopy(source, dest)).toThrow(/cannot make/);
  });

  test("a missing snapshot is refused instead of yielding an empty copy", () => {
    expect(() =>
      privateOwnerCopy(
        join(root, "absent.sqlite"),
        privateRunPaths(root, "s").destructionDb,
      ),
    ).toThrow(/provenance snapshot not found/);
  });

  test("a copy identical to the approved provenance passes", () => {
    expect(() =>
      assertOwnerCopyUnchanged(approved(), approved()),
    ).not.toThrow();
  });

  test("a stale or doctored copy is refused field by field", () => {
    // A copy whose newest dispatch is not the approved one, a copy pointed at a
    // different guest, and a copy whose verification was quietly downgraded are
    // all refused. Nothing is repaired.
    for (const field of [
      "latest_run_id",
      "latest_state",
      "latest_persisted",
      "vm_id",
      "worker_id",
      "branch",
      "reported_branch",
      "dispatch_count",
    ] as const) {
      const stale = { ...approved(), [field]: "something-else" };
      expect(() => assertOwnerCopyUnchanged(stale, approved())).toThrow(
        /does not match the approved provenance/,
      );
      expect(() => assertOwnerCopyUnchanged(stale, approved())).toThrow(
        new RegExp(field),
      );
    }
  });

  test("destruction never asks the coordinator to force, and never mints a result", () => {
    const source = proofCode();
    // The destroy control is called on the OWNER, with the copy's store.
    expect(source).toMatch(
      /ownerCoordinator\.control\(PROOF_WORKER, "destroy"\)/,
    );
    // `force` is never passed, so the production refusal paths stay reachable.
    expect(source).not.toMatch(/control\(\s*PROOF_WORKER,\s*"destroy",\s*true/);
    // There is no force delete and no force_destroy anywhere in the file.
    expect(source).not.toMatch(/force_destroy\s*[:=]\s*true/);
    expect(source).not.toMatch(/destroyWorker\([^)]*,\s*true/);
    // The salvage record is no longer what gets destroyed.
    expect(source).not.toMatch(/control\(spawned\.worker_id, "destroy"\)/);
    // The snapshot is only ever opened read-only.
    expect(source).toMatch(
      /new Database\(snapshotPath, \{ readonly: true \}\)/,
    );
  });
});

// -----------------------------------------------------------------------------
// Low fixes: bounded streaming, per-run evidence, IO reporting, private default.
// -----------------------------------------------------------------------------

describe("LOW: bounded streaming, private per-run evidence and honest IO", () => {
  test("a stored artifact is hashed by draining one bounded stream", async () => {
    // 5 MiB, far over the 32 KiB cap `ArtifactService.read` enforces, which is
    // why the proof may not re-read an artifact with `read(id, 0, size)`.
    const payload = Buffer.alloc(5 * 1024 * 1024, 0x2b);
    payload.write("artifact-salvage", 0, "ascii");
    const expected = createHash("sha256").update(payload).digest("hex");
    const bytes = new Uint8Array(payload);
    let requested = 0;
    const artifacts = {
      async download() {
        requested++;
        let offset = 0;
        return new ReadableStream<Uint8Array>({
          pull(controller) {
            if (offset >= bytes.byteLength) {
              controller.close();
              return;
            }
            const next = Math.min(offset + 65536, bytes.byteLength);
            controller.enqueue(bytes.subarray(offset, next));
            offset = next;
          },
        });
      },
    };
    const result = await streamedArtifactDigest(artifacts, "art-1");
    expect(result.sha256).toBe(expected);
    expect(result.bytes).toBe(bytes.byteLength);
    // One stream, one digest: never a second read of the same object.
    expect(requested).toBe(1);
  });

  test("evidence is per run, and an unwritable evidence file is reported", () => {
    const first = new Evidence(join(root, `real-proof.a.${Date.now()}.jsonl`));
    first.event("a", { n: 1 });
    const second = new Evidence(join(root, `real-proof.b.${Date.now()}.jsonl`));
    second.event("b", { n: 2 });
    // Two runs never share one file, so neither can interleave into the other's
    // audit trail.
    expect(first.jsonl).not.toBe(second.jsonl);
    expect(readFileSync(first.jsonl, "utf8")).toContain('"event":"a"');
    expect(readFileSync(first.jsonl, "utf8")).not.toContain('"event":"b"');
    expect(statSync(first.jsonl).mode & 0o777).toBe(0o600);
    expect(() => first.assertHealthy()).not.toThrow();

    // A directory where the evidence file should be: the append cannot succeed.
    const brokenDir = join(root, "not-a-file");
    mkdirSync(brokenDir, { recursive: true });
    const broken = new Evidence(brokenDir);
    broken.event("c");
    expect(broken.writeFailures.length).toBeGreaterThan(0);
    // Best-effort evidence used to swallow this and still report success.
    expect(() => broken.assertHealthy()).toThrow(
      /evidence could not be written/,
    );
  });

  test("the default evidence directory is private and outside the repository", () => {
    const dir = defaultEvidenceDir();
    try {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      // Not inside the working tree: this repository does not ignore
      // `.swarmforge`, so a default there would scatter a private database and an
      // audit trail into the checkout as untracked files.
      expect(dir.startsWith(`${process.cwd()}/`)).toBe(false);
      expect(dir.startsWith(tmpdir())).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing artifact store location is refused, not invented", () => {
    expect(() => privateArtifactDir({})).toThrow(
      /SWARMFORGE_ARTIFACT_DIR is not configured/,
    );
    expect(() => privateArtifactDir({ SWARMFORGE_ARTIFACT_DIR: "" })).toThrow(
      /SWARMFORGE_ARTIFACT_DIR is not configured/,
    );
    expect(privateArtifactDir({ SWARMFORGE_ARTIFACT_DIR: "/tmp/x" })).toBe(
      "/tmp/x",
    );
  });

  test("a checkout without the data plane is refused, not half-run", () => {
    // The salvage phase is genuinely unavailable there. Saying so is the point:
    // a partial proof that reported success would be worse than no proof.
    const withoutDataPlane = {} as Parameters<typeof assertDataPlane>[0];
    expect(() => assertDataPlane(withoutDataPlane)).toThrow(
      /does not provide the data plane/,
    );
    expect(() => assertDataPlane(withoutDataPlane)).toThrow(/artifacts/);
    expect(() => assertDataPlane(withoutDataPlane)).toThrow(/finalize/);
    // A checkout that does provide it passes without touching anything.
    expect(() =>
      assertDataPlane({
        artifacts: {},
        finalize: () => undefined,
      } as unknown as Parameters<typeof assertDataPlane>[0]),
    ).not.toThrow();
  });
});

describe("MEDIUM: the scale probe names its digest metric for what it counts", () => {
  test("equal content under different workers is expected, not a duplicate", () => {
    // Two different workers may legitimately write the same bytes. The probe's
    // defect signal is one worker/run/path stored twice under two kinds, never an
    // equal digest across worker boundaries.
    const records = [
      {
        worker_id: "w-1",
        run_id: "r-1",
        original_path: "report.json",
        kind: "file",
      },
      {
        worker_id: "w-2",
        run_id: "r-1",
        original_path: "report.json",
        kind: "file",
      },
    ];
    const found = duplicateFindings(records);
    expect(found.paths).toBe(0);
    expect(found.records).toBe(0);
  });

  test("the probe reports the digest count as a per-record observation, unasserted", () => {
    const source = scaleCode();
    // The old name sat next to the duplicate counters and read like a
    // cross-worker dedup measurement. It is named for what it counts now.
    expect(source).toMatch(/distinct_content_digests_across_stored_records/);
    expect(source).not.toMatch(/report\.distinct_content_digests\b/);
    // And the note states plainly that it is not a dedup measurement.
    expect(source).toMatch(/not a cross-worker dedup measurement/);
    // The enforced assertion is still the per worker/run/path duplication.
    expect(source).toMatch(/if \(duplicate\.paths > 0\)/);
  });

  test("the probe refuses by name when the combined disposable is absent", async () => {
    // `loadLocalGuest` is what resolves the real local guest fixture. On a
    // checkout without the data plane it must refuse and name the modules, never
    // fall back to something this file invented.
    const source = scaleCode();
    expect(source).toMatch(
      /combined disposable's local guest fixture is unavailable/,
    );
    expect(source).toMatch(/does not substitute a stand-in/);
  });
});
