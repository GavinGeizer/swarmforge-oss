import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventLogger } from "../src/runtime";
import { harness, task } from "./helpers";

test("event logger screens terminal payloads and file records before exposure", () => {
  const h = harness();
  const directory = mkdtempSync(join(tmpdir(), "swarmforge-log-test-"));
  const path = join(directory, "events.log");
  const output: string[] = [];
  const log = spyOn(console, "log").mockImplementation((line) =>
    output.push(String(line)),
  );
  try {
    const worker = h.coordinator.spawn(task);
    h.store.event(worker.worker_id, "worker.failed", {
      detail: "infra-secret model-secret",
      access_token: "unknown-token-value",
      nested: { api_key: "nested-unknown-key" },
      safe: "visible diagnostic",
    });
    // JSON parsing can reconstruct a secret invisible in the serialized payload.
    h.store.event(worker.worker_id, "worker.failed", {});
    const escaped = String.raw`{"detail":"infra\u002dsecret"}`;
    h.store.db
      .query("UPDATE events SET data=? WHERE id=?")
      .run(escaped, h.store.latestEventId());
    h.store.event(worker.worker_id, "worker.failed", {});
    h.store.db
      .query("UPDATE events SET data=? WHERE id=?")
      .run("malformed JSON: infra-secret", h.store.latestEventId());
    const flush = eventLogger(h.coordinator, path);
    flush();
    const terminal = output.join("\n");
    const file = readFileSync(path, "utf8");
    expect(terminal).toContain("visible diagnostic");
    const records = file
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const decoded = records.map((record) => {
      try {
        return JSON.parse(record.data);
      } catch {
        return record.data;
      }
    });
    for (const secret of [
      "infra-secret",
      "model-secret",
      "unknown-token-value",
      "nested-unknown-key",
    ]) {
      expect(terminal).not.toContain(secret);
      expect(file).not.toContain(secret);
      expect(JSON.stringify(decoded)).not.toContain(secret);
    }
    expect(terminal).toContain("[REDACTED]");
    const count = output.length;
    flush();
    expect(output).toHaveLength(count);
    expect(h.store.setting("logged_event")).toBe(
      String(h.store.latestEventId()),
    );
  } finally {
    log.mockRestore();
    h.store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
