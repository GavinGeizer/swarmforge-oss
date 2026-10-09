import { expect, spyOn, test } from "bun:test";
import { hostedSupervisorCredentialReplySchema } from "../src/hosted-types.ts";
import { localFixture } from "./local-fixture.ts";

for (const expiredWindow of ["credential", "recovery"] as const) {
  test(`rotation replay rejects ${expiredWindow} expiry at SQL execution after a delayed query`, async () => {
    const h = await localFixture();
    const execute = h.db.execute.bind(h.db);
    let intercepted = false;
    const delayed = spyOn(h.db, "execute");
    delayed.mockImplementation((statement) => {
      if (statement.sql.startsWith("SELECT r.result_ciphertext")) {
        intercepted = true;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
      }
      return execute(statement);
    });
    try {
      const a = await h.login();
      const w = await h.enrolledWorker(a);
      const s = await h.registerSupervisor(a, w.worker_id);
      const key = crypto.randomUUID();
      const headers = {
        authorization: `Bearer ${s.credential}`,
        "idempotency-key": key,
      };
      const first = await h.request(
        "/v1/supervisor/me/rotate",
        headers,
        "POST",
        {},
      );
      expect(first.status).toBe(200);
      const successor = (await first.json()) as { credential: string };
      if (expiredWindow === "credential") {
        h.db.sqlite
          .query(
            "UPDATE hosted_supervisor_credentials SET expires_at=? WHERE credential_id=?",
          )
          .run(Date.now() + 100, s.credential_id);
      } else {
        h.db.sqlite
          .query(
            "UPDATE hosted_supervisor_rotations SET expires_at=? WHERE previous_credential_id=?",
          )
          .run(Date.now() + 100, s.credential_id);
      }
      const before = h.db.sqlite
        .query(
          "SELECT * FROM hosted_supervisor_credentials ORDER BY credential_id",
        )
        .all();
      const retry = await h.request(
        "/v1/supervisor/me/rotate",
        headers,
        "POST",
        {},
      );
      expect(intercepted).toBe(true);
      expect(retry.status).toBe(401);
      expect(await retry.text()).not.toContain(successor.credential);
      expect(
        h.db.sqlite
          .query(
            "SELECT * FROM hosted_supervisor_credentials ORDER BY credential_id",
          )
          .all(),
      ).toEqual(before);
      expect(
        (
          await h.request("/v1/supervisor/me", {
            authorization: `Bearer ${successor.credential}`,
          })
        ).status,
      ).toBe(200);
    } finally {
      delayed.mockRestore();
      h.close();
    }
  });
}

test("lost rotation reply remains recoverable within both current finite windows", async () => {
  const h = await localFixture();
  try {
    const a = await h.login();
    const w = await h.enrolledWorker(a);
    const s = await h.registerSupervisor(a, w.worker_id);
    const headers = {
      authorization: `Bearer ${s.credential}`,
      "idempotency-key": crypto.randomUUID(),
    };
    const first = await h.request(
      "/v1/supervisor/me/rotate",
      headers,
      "POST",
      {},
    );
    expect(first.status).toBe(200);
    const successor = hostedSupervisorCredentialReplySchema.parse(
      await first.json(),
    );
    const retry = await h.request(
      "/v1/supervisor/me/rotate",
      headers,
      "POST",
      {},
    );
    expect(retry.status).toBe(200);
    expect(
      hostedSupervisorCredentialReplySchema.parse(await retry.json()),
    ).toEqual(successor);
    expect(
      h.db.sqlite
        .query("SELECT count(*) n FROM hosted_supervisor_credentials")
        .get(),
    ).toEqual({ n: 2 });
  } finally {
    h.close();
  }
});
