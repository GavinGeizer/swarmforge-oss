import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

test("preview mutation scripts refuse other databases and disable automatic provisioning", async () => {
  const directory = await mkdtemp(join(tmpdir(), "swarmforge-preview-"));
  const capture = join(directory, "calls.jsonl");
  const secrets = join(directory, "secrets.env");
  try {
    await writeFile(secrets, "AUTH_SECRET=fixture-only\n", { mode: 0o600 });
    await writeFile(
      join(directory, "cf"),
      `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CAPTURE, JSON.stringify(args)+"\\n");
if(args[0]==="d1" && args[1]==="get") console.log(JSON.stringify({name:process.env.DATABASE_NAME}));
`,
      { mode: 0o700 },
    );
    const env = {
      ...process.env,
      PATH: `${directory}${delimiter}${process.env.PATH}`,
      CAPTURE: capture,
      CF_PREVIEW_D1_ID: "11111111-2222-4333-8444-555555555555",
      CLOUDFLARE_ACCOUNT_ID: "fixture-account",
      CF_PREVIEW_API_ORIGIN: "https://preview.example.invalid",
      CF_PREVIEW_SECRETS_FILE: secrets,
      DATABASE_NAME: "production-metadata",
    };
    for (const script of ["deploy-preview.mjs", "migrate-preview.mjs"]) {
      const path = new URL(`../scripts/${script}`, import.meta.url).pathname;
      await writeFile(capture, "");
      const refused = spawnSync(process.execPath, [path], {
        env,
        encoding: "utf8",
      });
      assert.notEqual(refused.status, 0);
      assert.match(refused.stderr, /other databases are refused/);
      let calls: string[][] = (await readFile(capture, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.deepEqual(calls, [["d1", "get", env.CF_PREVIEW_D1_ID]]);

      await writeFile(capture, "");
      const allowed = spawnSync(process.execPath, [path], {
        env: { ...env, DATABASE_NAME: "swarmforge-cloud-preview" },
        encoding: "utf8",
      });
      assert.equal(allowed.status, 0, allowed.stderr);
      calls = (await readFile(capture, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(calls.length, 2);
      assert.deepEqual(calls[0], ["d1", "get", env.CF_PREVIEW_D1_ID]);
      assert.ok(calls[1]?.includes("preview"));
      if (script === "deploy-preview.mjs") {
        assert.deepEqual(calls[1], [
          "deploy",
          "--mode",
          "preview",
          "--provision=false",
          "--secrets-file",
          secrets,
        ]);
      } else {
        assert.deepEqual(calls[1]?.slice(0, 6), [
          "d1",
          "migrations",
          "apply",
          env.CF_PREVIEW_D1_ID,
          "--mode",
          "preview",
        ]);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
