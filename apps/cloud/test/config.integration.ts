import assert from "node:assert/strict";
import { test } from "node:test";
import config, {
  localDatabaseId,
  previewDatabaseName,
  previewWorkerName,
} from "../cloudflare.config.ts";

function configuration(mode?: string) {
  assert.equal(typeof config, "function");
  if (typeof config !== "function")
    throw new Error("Expected environment-aware configuration");
  return config({ mode, isPreview: false });
}

test("local configuration isolates metadata and secret bindings from the Bun coordinator", () => {
  const result = configuration("local");
  assert.equal(result.worker.name, "swarmforge-cloud-local");
  assert.equal(result.worker.workersDev, false);
  assert.equal(result.worker.env.APP_ORIGIN.value, "http://localhost:8788");
  assert.equal(result.worker.env.DB.id, localDatabaseId);
  assert.equal(result.worker.observability.redactQueryString, true);
  assert.equal(result.worker.observability.logs.invocationLogs, false);
  for (const secret of [
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
    "AUTH_SECRET",
  ] as const) {
    assert.equal(result.worker.env[secret].type, "secret");
  }
});

test("production and unknown modes are rejected", () => {
  for (const mode of ["production", "prod", "staging"]) {
    assert.throws(() => configuration(mode), /local and preview modes only/);
  }
});

test("preview requires separate D1 UUID and exact HTTPS origins", () => {
  const saved = { ...process.env };
  try {
    delete process.env.CF_PREVIEW_API_ORIGIN;
    delete process.env.CF_PREVIEW_D1_ID;
    assert.throws(() => configuration("preview"), /Preview requires/);
    process.env.CF_PREVIEW_D1_ID = "11111111-2222-4333-8444-555555555555";
    process.env.CF_PREVIEW_API_ORIGIN = "http://localhost:8788";
    assert.throws(() => configuration("preview"), /preview requires HTTPS/);
    process.env.CF_PREVIEW_API_ORIGIN = "https://preview.example.invalid/path";
    assert.throws(() => configuration("preview"), /exact origins/);
    process.env.CF_PREVIEW_API_ORIGIN = "https://preview.example.invalid";
    delete process.env.CF_PREVIEW_WEBSITE_ORIGIN;
    process.env.CF_PREVIEW_D1_ID = localDatabaseId;
    assert.throws(() => configuration("preview"), /separate D1 database UUID/);
    process.env.CF_PREVIEW_D1_ID = "11111111-2222-4333-8444-555555555555";
    const result = configuration("preview");
    assert.equal(result.worker.name, previewWorkerName);
    assert.equal(result.worker.env.DB.name, previewDatabaseName);
    assert.equal(result.worker.env.DB.id, process.env.CF_PREVIEW_D1_ID);
    assert.equal(
      result.worker.env.APP_ORIGIN.value,
      process.env.CF_PREVIEW_API_ORIGIN,
    );
    assert.equal(result.worker.env.ENVIRONMENT.value, "preview");
  } finally {
    for (const key of [
      "CF_PREVIEW_API_ORIGIN",
      "CF_PREVIEW_WEBSITE_ORIGIN",
      "CF_PREVIEW_D1_ID",
    ]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
