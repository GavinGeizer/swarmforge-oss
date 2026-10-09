import assert from "node:assert/strict";
import { test } from "node:test";
import { hostedFixture } from "./hosted-helpers.ts";

test("execution grant issuance: browser-only own installation, fixed scopes, idempotent encrypted replay", async () => {
  const h = await hostedFixture();
  try {
    const a = await h.login();
    const device = await h.linkedDevice(a);
    const k = crypto.randomUUID();
    const first = await h.authorizeExecution(
      a,
      a.tenant,
      device.installation_id,
      k,
    );
    assert.equal(first.status, 201);
    const grant = (await first.json()) as {
      credential: string;
      grant_id: string;
      installation_id: string;
      tenant_id: string;
      scopes: string[];
      expires_at: number;
      authorization_expires_at: number;
    };
    assert.ok(/^sfexec_[A-Za-z0-9_-]{43}$/.test(grant.credential));
    assert.deepEqual(grant.scopes, [
      "tasks:create",
      "tasks:read",
      "tasks:cancel",
      "entitlements:read",
    ]);
    assert.equal(grant.installation_id, device.installation_id);
    assert.equal(grant.tenant_id, a.tenant);
    assert.ok(grant.expires_at <= grant.authorization_expires_at);
    // Same-key replay returns the identical credential with 200 replay
    // semantics (issuance itself is 201), and no second grant row.
    const replay = await h.authorizeExecution(
      a,
      a.tenant,
      device.installation_id,
      k,
    );
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), grant);
    const rows = (await h.db
      .prepare(
        "SELECT count(*) n FROM hosted_execution_grants WHERE organization_id=?",
      )
      .bind(a.tenant)
      .first<{ n: number }>())!;
    assert.equal(rows.n, 1);
    // Changed key after issuance creates a distinct grant (no conflict).
    const second = await h.authorizeExecution(
      a,
      a.tenant,
      device.installation_id,
    );
    assert.equal(second.status, 201);
    const grant2 = (await second.json()) as { credential: string };
    assert.notEqual(grant2.credential, grant.credential);
    // Raw secret never stored.
    const dump = JSON.stringify(
      (await h.db.prepare("SELECT * FROM hosted_execution_grants").all())
        .results,
    );
    assert.ok(!dump.includes(grant.credential));
    assert.ok(!dump.includes(grant2.credential));
    // The grant authenticates the entitlements read path.
    const ent = await h.request(`/v1/tenants/${a.tenant}/entitlements`, {
      authorization: `Bearer ${grant.credential}`,
    });
    assert.equal(ent.status, 200);
  } finally {
    await h.mf.dispose();
  }
});

test("concurrent same-key issuance serializes: one grant, identical replay bodies", async () => {
  // Reviewer A is right that sequential [201,200] does not prove the race:
  // D1 serializes batch writes, and the UNIQUE(installation,session,key)
  // loser inserts zero rows, but two issuanceReplay misses racing before
  // EITHER insert could double-issue. This test fires N concurrent same-key
  // requests at real D1 and asserts exactly one grant row and byte-identical
  // replay bodies, plus that the winner's ciphertext decrypts to a live
  // credential. If D1 ever interleaves two inserts, the UNIQUE rejects the
  // loser (batch atomic) and the final SELECT returns the winner — still one
  // row. A second row would fail this test RED.
  const h = await hostedFixture();
  try {
    const a = await h.login();
    const device = await h.linkedDevice(a);
    const k = crypto.randomUUID();
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        h.authorizeExecution(a, a.tenant, device.installation_id, k),
      ),
    );
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 201]);
    const bodies = await Promise.all(results.map((r) => r.json()));
    for (const b of bodies.slice(1)) assert.deepEqual(b, bodies[0]);
    const rows = (await h.db
      .prepare(
        "SELECT count(*) n FROM hosted_execution_grants WHERE organization_id=? AND installation_id=? AND idempotency_key=?",
      )
      .bind(a.tenant, device.installation_id, k)
      .first<{ n: number }>())!;
    assert.equal(rows.n, 1);
    const winner = bodies[0] as { credential: string };
    assert.equal(
      (
        await h.request(`/v1/tenants/${a.tenant}/entitlements`, {
          authorization: `Bearer ${winner.credential}`,
        })
      ).status,
      200,
    );
  } finally {
    await h.mf.dispose();
  }
});

test("execution grant denial: wrong installation/user/tenant, missing CSRF, machine credentials", async () => {
  const h = await hostedFixture();
  try {
    const a = await h.login();
    const b = await h.login(200);
    const deviceA = await h.linkedDevice(a);
    // Cross-user: b cannot authorize a's installation (indistinguishable 404).
    assert.equal(
      (await h.authorizeExecution(b, a.tenant, deviceA.installation_id)).status,
      404,
    );
    // Cross-tenant: a cannot authorize under b's tenant.
    assert.equal(
      (await h.authorizeExecution(a, b.tenant, deviceA.installation_id)).status,
      404,
    );
    // Nonexistent installation.
    assert.equal(
      (await h.authorizeExecution(a, a.tenant, crypto.randomUUID())).status,
      404,
    );
    // Missing CSRF proof.
    const noCsrf = await h.request(
      `/v1/tenants/${a.tenant}/cli-installations/${deviceA.installation_id}/execution-authorizations`,
      {
        cookie: a.headers.cookie,
        origin: a.headers.origin,
        "idempotency-key": crypto.randomUUID(),
      },
      "POST",
      {},
    );
    assert.equal(noCsrf.status, 403);
    // Machine credential (sfcli_) cannot authorize: authentication() rejects
    // Authorization headers for browser routes.
    const cliAuth = await h.request(
      `/v1/tenants/${a.tenant}/cli-installations/${deviceA.installation_id}/execution-authorizations`,
      {
        authorization: `Bearer ${deviceA.credential}`,
        origin: a.headers.origin,
        "x-csrf-token": "x",
        "idempotency-key": crypto.randomUUID(),
      },
      "POST",
      {},
    );
    assert.equal(cliAuth.status, 401);
  } finally {
    await h.mf.dispose();
  }
});

test("execution grant lifecycle: CLI rotation and revocation invalidate grants", async () => {
  const h = await hostedFixture();
  try {
    const a = await h.login();
    const device = await h.linkedDevice(a);
    const r = await h.authorizeExecution(a, a.tenant, device.installation_id);
    assert.equal(r.status, 201);
    const grant = (await r.json()) as { credential: string };
    const bearer = { authorization: `Bearer ${grant.credential}` };
    assert.equal(
      (await h.request(`/v1/tenants/${a.tenant}/entitlements`, bearer)).status,
      200,
    );
    // Rotate the underlying CLI installation (epoch bump): grant dies.
    const rotated = await h.request(
      "/v1/cli/me/rotate",
      {
        authorization: `Bearer ${device.credential}`,
        "idempotency-key": crypto.randomUUID(),
      },
      "POST",
      {},
    );
    assert.equal(rotated.status, 200);
    assert.equal(
      (await h.request(`/v1/tenants/${a.tenant}/entitlements`, bearer)).status,
      401,
    );
    // Fresh grant on the new epoch works, then installation revocation kills it.
    const device2 = (await rotated.json()) as { credential: string };
    const r2 = await h.authorizeExecution(a, a.tenant, device.installation_id);
    assert.equal(r2.status, 201);
    const grant2 = (await r2.json()) as { credential: string };
    assert.equal(
      (
        await h.request(`/v1/tenants/${a.tenant}/entitlements`, {
          authorization: `Bearer ${grant2.credential}`,
        })
      ).status,
      200,
    );
    const revoked = await h.request(
      "/v1/cli/me",
      { authorization: `Bearer ${device2.credential}` },
      "DELETE",
    );
    assert.equal(revoked.status, 200);
    assert.equal(
      (
        await h.request(`/v1/tenants/${a.tenant}/entitlements`, {
          authorization: `Bearer ${grant2.credential}`,
        })
      ).status,
      401,
    );
  } finally {
    await h.mf.dispose();
  }
});

test("execution grant audience isolation: legacy sfcli_/sfworker_ rejected on hosted paths", async () => {
  const h = await hostedFixture();
  try {
    const a = await h.login();
    const device = await h.linkedDevice(a);
    const worker = await h.enrolledWorker(a);
    for (const cred of [device.credential, worker.credential]) {
      const r = await h.request(`/v1/tenants/${a.tenant}/entitlements`, {
        authorization: `Bearer ${cred}`,
      });
      assert.equal(
        r.status,
        401,
        `legacy credential must not pass hosted auth: ${cred.slice(0, 7)}`,
      );
    }
    assert.equal(
      (
        await h.request(`/v1/tenants/${a.tenant}/entitlements`, {
          authorization: "Bearer github-token",
        })
      ).status,
      401,
    );
  } finally {
    await h.mf.dispose();
  }
});
