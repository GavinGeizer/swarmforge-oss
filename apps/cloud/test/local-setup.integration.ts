import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("local cf migrations finish and can be repeated without reapplying schema", async () => {
  const directory = await mkdtemp(join(tmpdir(), "swarmforge-local-setup-"));
  try {
    for (const first of [true, false]) {
      const result = spawnSync(
        process.execPath,
        [new URL("../scripts/migrate-local.mjs", import.meta.url).pathname],
        { cwd: directory, encoding: "utf8", timeout: 30_000 },
      );
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, first ? /0003_hosted_execution.sql/ : /\[\]/);
      assert.doesNotMatch(result.stdout, /❌/);
    }
    const cleanup = spawnSync(
      process.execPath,
      [new URL("../scripts/cleanup-local.mjs", import.meta.url).pathname],
      { cwd: directory, encoding: "utf8", timeout: 30_000 },
    );
    assert.ifError(cleanup.error);
    assert.equal(cleanup.status, 0, cleanup.stderr);
    assert.doesNotMatch(cleanup.stdout, /❌/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
