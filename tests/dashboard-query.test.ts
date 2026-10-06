import { expect, test } from "bun:test";
import { redactorFor } from "../src/security";
import { harness, task } from "./helpers";

test("SQL pages filter literal searches and order without loading history into JS", () => {
  const h = harness();
  try {
    for (let i = 0; i < 160; i++) {
      const w = h.store.create({
        ...task,
        task_id: `task-${i}`,
        timeout_seconds: 60,
      });
      h.store.patch(w.worker_id, {
        created_at: i,
        last_activity_at: i,
        vm_id: `vm-${i}`,
        state: "completed",
        finalization: {
          state: "preserved",
          attempts: 1,
          run_id: null,
          error: null,
          next_retry_at: null,
          started_at: null,
          completed_at: null,
        },
      });
      h.store.cancelDispatches(w.worker_id);
    }
    h.store.all = () => {
      throw new Error("Unbounded history read");
    };
    const page = h.store.queryWorkers({
      retained_only: true,
      preservation: "preserved",
      sort: "age",
      limit: 10,
      offset: 20,
    });
    expect(page.total).toBe(160);
    expect(page.workers).toHaveLength(10);
    expect(page.workers[0]?.created_at).toBe(20);
    expect(page.next_offset).toBe(30);
    expect(h.store.queryWorkers({ query: "%" }).total).toBe(0);
    expect(h.store.queryWorkers({ query: "TASK-159" }).total).toBe(1);
    expect(h.store.summary().retention.candidates).toBe(160);
    const redactor = redactorFor(h.coordinator);
    expect(redactor.text(page.workers[0]!.server_password)).toBe("[REDACTED]");
    const revision = h.store.revision();
    const updated = h.store.patch(page.workers[0]!.worker_id, {
      server_password: "new-guest-password",
    });
    expect(h.store.revision()).not.toBe(revision);
    expect(redactor.text(updated.server_password)).toBe("[REDACTED]");
  } finally {
    h.store.close();
  }
});

test("credential and summary caches recover after rollback", () => {
  const h = harness();
  const w = h.store.create({ ...task, timeout_seconds: 60 });
  try {
    const redactor = redactorFor(h.coordinator);
    expect(() =>
      h.store.db.transaction(() => {
        h.store.patch(w.worker_id, {
          server_password: "temporary-password",
          state: "failed",
        });
        expect(redactor.text("temporary-password")).toBe("[REDACTED]");
        expect(h.store.summary().states.failed).toBe(1);
        throw new Error("rollback");
      })(),
    ).toThrow("rollback");
    expect(redactor.text(w.server_password)).toBe("[REDACTED]");
    expect(h.store.summary().states.queued).toBe(1);
  } finally {
    h.store.close();
  }
});

test("ten thousand historical workers remain a 50-record dashboard query", () => {
  const h = harness();
  try {
    h.store.db.transaction(() => {
      for (let i = 0; i < 10000; i++)
        h.store.create({
          ...task,
          task_id: `history-${i}`,
          timeout_seconds: 60,
        });
    })();
    h.store.all = () => {
      throw new Error("Unbounded history read");
    };
    const page = h.store.queryWorkers({ sort: "recent", limit: 50 });
    expect(page.total).toBe(10000);
    expect(page.workers).toHaveLength(50);
    expect(h.store.summary().total).toBe(10000);
    const redactor = redactorFor(h.coordinator);
    expect(redactor.text(page.workers[0]!.server_password)).toBe("[REDACTED]");
    expect(redactor.text("ordinary worker metadata")).toBe(
      "ordinary worker metadata",
    );
  } finally {
    h.store.close();
  }
}, 15000);

test("nested rollback never reuses credential or aggregate state inside the outer transaction", () => {
  const h = harness();
  const w = h.store.create({ ...task, timeout_seconds: 60 });
  try {
    const redactor = redactorFor(h.coordinator);
    h.store.db.transaction(() => {
      expect(() =>
        h.store.db.transaction(() => {
          h.store.patch(w.worker_id, {
            server_password: "rolled-back-password",
            state: "failed",
          });
          expect(redactor.text("rolled-back-password")).toBe("[REDACTED]");
          expect(h.store.summary().states.failed).toBe(1);
          throw new Error("savepoint rollback");
        })(),
      ).toThrow("savepoint rollback");
      expect(redactor.text(w.server_password)).toBe("[REDACTED]");
      expect(h.store.summary().states.queued).toBe(1);
    })();
  } finally {
    h.store.close();
  }
});
