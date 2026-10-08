import assert from "node:assert/strict";
import { test } from "node:test";
import { bearer, type Credential, count, fixture } from "./machine-helpers.ts";

test("single-use worker enrollment and encrypted retry are distinct from devices, sessions and task authority", async () => {
  const h = await fixture();
  try {
    const a = await h.login(),
      device = await h.linked(a),
      invite = await h.enroll(a),
      k = crypto.randomUUID();
    const rs = await Promise.all([
      h.register(invite, k),
      h.register(invite, k),
    ]);
    assert.ok(rs.every((r) => r.status === 201));
    const worker = (await rs[0]!.json()) as Credential;
    assert.deepEqual(await rs[1]!.json(), worker);
    assert.equal(await count(h, "cloud_workers"), 1);
    assert.equal(await count(h, "machine_credentials"), 2);
    assert.equal(
      (await h.request("/v1/workers/me", bearer(worker))).status,
      200,
    );
    for (const credentials of [
      bearer(device),
      a.headers,
      { authorization: "Bearer github-token" },
    ])
      assert.equal(
        (await h.request("/v1/workers/me", credentials)).status,
        401,
      );
    assert.equal((await h.request("/v1/cli/me", bearer(worker))).status, 401);
    assert.equal((await h.request("/v1/me", bearer(worker))).status, 401);
    assert.equal((await h.register(invite)).status, 409);
    assert.equal(
      (
        await h.request(
          `/v1/tenants/${a.tenant}/tasks`,
          bearer(worker),
          "POST",
          {},
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await h.request(
          `/v1/tenants/${a.tenant}/worker-enrollments`,
          bearer(worker),
          "POST",
          { name: "bad" },
        )
      ).status,
      401,
    );
    const list = await h.request(`/v1/tenants/${a.tenant}/workers`, a.headers);
    assert.equal(list.status, 200);
    const rows = (await list.json()) as { items: unknown[] };
    assert.equal(rows.items.length, 1);
    const dump =
      JSON.stringify(
        (await h.db.prepare("SELECT * FROM worker_enrollments").all()).results,
      ) +
      JSON.stringify(
        (await h.db.prepare("SELECT * FROM machine_credentials").all()).results,
      ) +
      JSON.stringify(
        (await h.db.prepare("SELECT * FROM audit_events").all()).results,
      );
    assert.ok(!dump.includes(invite.enrollment_secret));
    assert.ok(!dump.includes(worker.credential));
  } finally {
    await h.mf.dispose();
  }
});
test("cross-tenant enrollment/revocation, loss of owner authority, expired invitations and revoked workers fail closed", async () => {
  const h = await fixture();
  try {
    const a = await h.login(),
      b = await h.login(200),
      inv = await h.enroll(a);
    assert.equal(
      (
        await h.request(
          `/v1/tenants/${a.tenant}/worker-enrollments`,
          { ...b.headers, "idempotency-key": crypto.randomUUID() },
          "POST",
          { name: "attack" },
        )
      ).status,
      404,
    );
    const registered = await h.register(inv);
    assert.equal(registered.status, 201);
    const worker = (await registered.json()) as Credential;
    assert.equal(
      (
        await h.request(
          `/v1/tenants/${b.tenant}/workers/${worker.worker_id}`,
          b.headers,
          "DELETE",
        )
      ).status,
      404,
    );
    await h.db
      .prepare(
        "UPDATE memberships SET role='member' WHERE organization_id=? AND user_id=?",
      )
      .bind(a.tenant, a.user)
      .run();
    assert.equal(
      (await h.request("/v1/workers/me", bearer(worker))).status,
      401,
    );
    await h.db
      .prepare(
        "UPDATE memberships SET role='owner' WHERE organization_id=? AND user_id=?",
      )
      .bind(a.tenant, a.user)
      .run();
    assert.equal(
      (
        await h.request(
          `/v1/tenants/${a.tenant}/workers/${worker.worker_id}`,
          a.headers,
          "DELETE",
        )
      ).status,
      200,
    );
    assert.equal(
      (await h.request("/v1/workers/me", bearer(worker))).status,
      401,
    );
    assert.equal(
      (
        await h.request(
          `/v1/tenants/${a.tenant}/workers/${worker.worker_id}`,
          a.headers,
          "DELETE",
        )
      ).status,
      200,
    );
    const expired = await h.enroll(a);
    await h.db
      .prepare(
        "UPDATE worker_enrollments SET expires_at=created_at+1 WHERE enrollment_id=?",
      )
      .bind(expired.enrollment_id)
      .run();
    assert.equal((await h.register(expired)).status, 410);
    const revoked = await h.enroll(a);
    assert.equal(
      (
        await h.request(
          `/v1/tenants/${a.tenant}/worker-enrollments/${revoked.enrollment_id}`,
          a.headers,
          "DELETE",
        )
      ).status,
      200,
    );
    assert.equal((await h.register(revoked)).status, 410);
    const stale = await h.enroll(a);
    await h.db
      .prepare(
        "UPDATE memberships SET status='revoked' WHERE organization_id=? AND user_id=?",
      )
      .bind(a.tenant, a.user)
      .run();
    assert.equal((await h.register(stale)).status, 403);
  } finally {
    await h.mf.dispose();
  }
});
test("worker rotation invalidates the old epoch and suspended tenant/disabled authorizer/expired credentials are denied", async () => {
  const h = await fixture();
  try {
    const a = await h.login(),
      inv = await h.enroll(a),
      old = (await (await h.register(inv)).json()) as Credential;
    const rotate = await h.request(
      "/v1/workers/me/rotate",
      { ...bearer(old), "idempotency-key": crypto.randomUUID() },
      "POST",
      {},
    );
    assert.equal(rotate.status, 200);
    const next = (await rotate.json()) as Credential;
    assert.equal((await h.request("/v1/workers/me", bearer(old))).status, 401);
    assert.equal((await h.request("/v1/workers/me", bearer(next))).status, 200);
    assert.equal((await h.request("/v1/cli/me", bearer(next))).status, 401);
    await h.db
      .prepare(
        "UPDATE organizations SET status='disabled' WHERE organization_id=?",
      )
      .bind(a.tenant)
      .run();
    assert.equal((await h.request("/v1/workers/me", bearer(next))).status, 401);
    await h.db
      .prepare(
        "UPDATE organizations SET status='active' WHERE organization_id=?",
      )
      .bind(a.tenant)
      .run();
    await h.db
      .prepare("UPDATE users SET status='disabled' WHERE user_id=?")
      .bind(a.user)
      .run();
    assert.equal((await h.request("/v1/workers/me", bearer(next))).status, 401);
    await h.db
      .prepare("UPDATE users SET status='active' WHERE user_id=?")
      .bind(a.user)
      .run();
    await h.db
      .prepare(
        "UPDATE machine_credentials SET expires_at=created_at+1 WHERE credential_id=?",
      )
      .bind(next.credential_id)
      .run();
    assert.equal((await h.request("/v1/workers/me", bearer(next))).status, 401);
  } finally {
    await h.mf.dispose();
  }
});
test("audit or database failures cannot partly enroll, consume or authorize machine identities", async () => {
  const h = await fixture();
  try {
    const a = await h.login(),
      l = await h.start(),
      e = await h.enroll(a);
    assert.equal((await h.approve(l, a)).status, 200);
    await h.db.prepare("DROP TABLE audit_events").run();
    assert.equal((await h.exchange(l)).status, 503);
    assert.equal((await h.register(e)).status, 503);
    assert.equal(await count(h, "machine_credentials"), 0);
    assert.equal(await count(h, "cli_installations"), 0);
    assert.equal(await count(h, "cloud_workers"), 0);
    const link = await h.db
      .prepare("SELECT state FROM cli_links WHERE link_id=?")
      .bind(l.link_id)
      .first<{ state: string }>();
    assert.equal(link?.state, "approved");
    await h.db.prepare("DROP TABLE memberships").run();
    assert.equal((await h.exchange(l)).status, 503);
  } finally {
    await h.mf.dispose();
  }
});
