import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Coordinator } from "../src/coordinator";
import { Store } from "../src/store";
import { config, FakeAgent, FakeProvider, task } from "./helpers";

test("a reopened SQLite database reconnects the same VM/session and retains results and tokens", async () => {
  const root = mkdtempSync(join(tmpdir(), "sf-restart-"));
  const path = join(root, "db.sqlite");
  const provider = new FakeProvider();
  const agent = new FakeAgent();
  let store = new Store(path);
  try {
    let c = new Coordinator(config, store, provider, agent);
    const w = c.spawn(task);
    for (let i = 0; i < 3; i++) await c.tick();
    const before = store.get(w.worker_id);
    store.close();
    store = new Store(path);
    c = new Coordinator(config, store, provider, agent);
    await c.recover();
    agent.complete(store.get(w.worker_id));
    await c.tick();
    expect(store.get(w.worker_id).vm_id).toBe(before.vm_id);
    expect(store.get(w.worker_id).opencode_session_id).toBe(
      before.opencode_session_id,
    );
    expect(store.result(w.worker_id)?.status).toBe("completed");
    expect(store.tokens().total).toBe(30);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
