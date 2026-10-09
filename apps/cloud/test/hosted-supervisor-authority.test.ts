import { expect, spyOn, test } from "bun:test";
import { localFixture } from "./local-fixture.ts";

test("supervisor registration cannot elect authority after browser expiry while waiting for its batch", async () => {
  const h = await localFixture();
  try {
    const a = await h.login();
    const w = await h.enrolledWorker(a);
    let intercepted = false;
    h.db.beforeBatch = async (statements) => {
      if (!statements[0]?.args.includes("supervisor.register")) return;
      h.db.beforeBatch = undefined;
      intercepted = true;
      h.db.sqlite
        .query("UPDATE sessions SET expires_at=? WHERE session_id=?")
        .run(Date.now() + 20, a.sessionId);
      await Bun.sleep(35);
    };
    const response = await h.request(
      `/v1/tenants/${a.tenant}/supervisors`,
      { ...a.headers, "idempotency-key": crypto.randomUUID() },
      "POST",
      { name: "bounded", worker_id: w.worker_id },
    );
    expect(intercepted).toBe(true);
    expect(response.status).toBe(409);
    for (const table of [
      "hosted_supervisors",
      "hosted_supervisor_credentials",
      "hosted_operations",
    ])
      expect(
        h.db.sqlite.query(`SELECT count(*) n FROM ${table}`).get(),
      ).toEqual({ n: 0 });
    expect(
      h.db.sqlite
        .query(
          "SELECT count(*) n FROM audit_events WHERE action='supervisor.registered'",
        )
        .get(),
    ).toEqual({ n: 0 });
  } finally {
    h.close();
  }
});

test("supervisor rotation cannot advance epoch after the authenticated credential expires before election", async () => {
  const h = await localFixture();
  try {
    const a = await h.login();
    const w = await h.enrolledWorker(a);
    const s = await h.registerSupervisor(a, w.worker_id);
    let intercepted = false;
    h.db.beforeBatch = async (statements) => {
      if (
        !statements[0]?.sql.startsWith(
          "UPDATE hosted_supervisors SET epoch=epoch+1",
        )
      )
        return;
      h.db.beforeBatch = undefined;
      intercepted = true;
      h.db.sqlite
        .query(
          "UPDATE hosted_supervisor_credentials SET expires_at=? WHERE credential_id=?",
        )
        .run(Date.now() + 20, s.credential_id);
      await Bun.sleep(35);
    };
    const response = await h.request(
      "/v1/supervisor/me/rotate",
      {
        authorization: `Bearer ${s.credential}`,
        "idempotency-key": crypto.randomUUID(),
      },
      "POST",
      {},
    );
    expect(intercepted).toBe(true);
    expect(response.status).toBe(409);
    expect(
      h.db.sqlite.query("SELECT epoch FROM hosted_supervisors").get(),
    ).toEqual({ epoch: 1 });
    expect(
      h.db.sqlite
        .query("SELECT count(*) n FROM hosted_supervisor_credentials")
        .get(),
    ).toEqual({ n: 1 });
    expect(
      h.db.sqlite
        .query("SELECT count(*) n FROM hosted_supervisor_rotations")
        .get(),
    ).toEqual({ n: 0 });
  } finally {
    h.close();
  }
});

test("different supervisor issuer cannot rotate or validate execution after the worker enroller loses admin", async () => {
  const h = await localFixture();
  try {
    const a = await h.login();
    const w = await h.enrolledWorker(a);
    const b = await h.login(101);
    h.db.sqlite
      .query("INSERT INTO memberships VALUES(?,?,'admin','active',?,?)")
      .run(a.tenant, b.user, Date.now(), Date.now());
    const s = await h.registerSupervisor(
      { ...b, tenant: a.tenant },
      w.worker_id,
    );
    h.db.sqlite
      .query(
        "UPDATE memberships SET role='member' WHERE organization_id=? AND user_id=?",
      )
      .run(a.tenant, a.user);
    const headers = {
      authorization: `Bearer ${s.credential}`,
      "idempotency-key": crypto.randomUUID(),
    };
    expect((await h.request("/v1/supervisor/me", headers)).status).toBe(401);
    expect(
      (await h.request("/v1/supervisor/me/rotate", headers, "POST", {})).status,
    ).toBe(401);
    expect(
      h.db.sqlite.query("SELECT epoch FROM hosted_supervisors").get(),
    ).toEqual({ epoch: 1 });
  } finally {
    h.close();
  }
});

test("registration elected before browser expiry completes all dependent writes and returns its fresh result", async () => {
  const h = await localFixture();
  const execute = h.db.execute.bind(h.db);
  const barrier = spyOn(h.db, "execute");
  try {
    const a = await h.login();
    const w = await h.enrolledWorker(a);
    let changed = false;
    barrier.mockImplementation((statement) => {
      if (statement.sql.startsWith("INSERT INTO hosted_supervisors")) {
        changed = true;
        h.db.sqlite
          .query("UPDATE sessions SET expires_at=? WHERE session_id=?")
          .run(Date.now() - 1, a.sessionId);
      }
      return execute(statement);
    });
    const response = await h.request(
      `/v1/tenants/${a.tenant}/supervisors`,
      { ...a.headers, "idempotency-key": crypto.randomUUID() },
      "POST",
      { name: "elected", worker_id: w.worker_id },
    );
    expect(changed).toBe(true);
    expect(response.status).toBe(201);
    expect(
      h.db.sqlite.query("SELECT count(*) n FROM hosted_supervisors").get(),
    ).toEqual({ n: 1 });
    expect(
      h.db.sqlite
        .query("SELECT count(*) n FROM hosted_supervisor_credentials")
        .get(),
    ).toEqual({ n: 1 });
    expect(
      h.db.sqlite
        .query(
          "SELECT count(*) n FROM audit_events WHERE action='supervisor.registered'",
        )
        .get(),
    ).toEqual({ n: 1 });
  } finally {
    barrier.mockRestore();
    h.close();
  }
});

test("expired browser cannot revoke through a delayed election or mutate credentials and assignments", async () => {
  const h = await localFixture();
  try {
    const a = await h.login();
    const w = await h.enrolledWorker(a);
    const s = await h.registerSupervisor(a, w.worker_id);
    h.db.beforeBatch = async (statements) => {
      if (!statements[0]?.args.includes("supervisor.revoke")) return;
      h.db.beforeBatch = undefined;
      h.db.sqlite
        .query("UPDATE sessions SET expires_at=? WHERE session_id=?")
        .run(Date.now() + 20, a.sessionId);
      await Bun.sleep(35);
    };
    const response = await h.request(
      `/v1/tenants/${a.tenant}/supervisors/${s.supervisor_id}`,
      { ...a.headers, "idempotency-key": crypto.randomUUID() },
      "DELETE",
    );
    expect(response.status).toBe(409);
    expect(
      h.db.sqlite.query("SELECT status,epoch FROM hosted_supervisors").get(),
    ).toEqual({ status: "registered", epoch: 1 });
    expect(
      h.db.sqlite
        .query("SELECT revoked_at FROM hosted_supervisor_credentials")
        .get(),
    ).toEqual({ revoked_at: null });
    expect(
      h.db.sqlite
        .query(
          "SELECT count(*) n FROM hosted_operations WHERE operation='supervisor.revoke'",
        )
        .get(),
    ).toEqual({ n: 0 });
    expect(
      h.db.sqlite
        .query(
          "SELECT count(*) n FROM audit_events WHERE action='supervisor.revoked'",
        )
        .get(),
    ).toEqual({ n: 0 });
  } finally {
    h.close();
  }
});
