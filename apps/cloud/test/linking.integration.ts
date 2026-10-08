import assert from "node:assert/strict";
import { test } from "node:test";
import { token } from "../src/crypto.ts";
import { bearer, type Credential, count, fixture } from "./machine-helpers.ts";

test("workerd complete browser pairing, proof-bound polling, atomic idempotent exchange and independent device identity", async () => {
  const h = await fixture();
  try {
    const a = await h.login(),
      link = await h.start();
    const page = await h.request(
      `/cloud/connect?link_id=${link.link_id}`,
      a.headers,
    );
    assert.equal(page.status, 200);
    assert.match(
      page.headers.get("content-security-policy")!,
      /script-src 'nonce-/,
    );
    assert.doesNotMatch(await page.text(), new RegExp(link.proof));
    const pending = await h.exchange(link);
    assert.equal(pending.status, 202);
    assert.deepEqual(await pending.json(), {
      state: "pending",
      poll_interval_seconds: 5,
    });
    assert.equal((await h.exchange(link)).status, 429);
    const invalid = {
      ...link,
      headers: { ...link.headers, authorization: `LinkInitiator ${token()}` },
    };
    assert.equal((await h.exchange(invalid)).status, 404);
    assert.equal((await h.approve(link, a)).status, 200);
    const k = crypto.randomUUID(),
      results = await Promise.all([h.exchange(link, k), h.exchange(link, k)]);
    assert.ok(results.every((r) => r.status === 200));
    const first = (await results[0]!.json()) as Credential,
      second = await results[1]!.json();
    assert.deepEqual(first, second);
    assert.equal(first.tenant_id, a.tenant);
    assert.equal(first.subject_id, a.user);
    assert.equal((await h.request("/v1/cli/me", bearer(first))).status, 200);
    assert.equal((await h.request("/v1/cli/me", a.headers)).status, 401);
    assert.equal((await h.request("/v1/me", bearer(first))).status, 401);
    assert.equal((await h.exchange(link)).status, 409);
    assert.equal(await count(h, "cli_installations"), 1);
    assert.equal(await count(h, "machine_credentials"), 1);
    const dump =
      JSON.stringify(
        (await h.db.prepare("SELECT * FROM cli_links").all()).results,
      ) +
      JSON.stringify(
        (await h.db.prepare("SELECT * FROM machine_credentials").all()).results,
      ) +
      JSON.stringify(
        (await h.db.prepare("SELECT * FROM audit_events").all()).results,
      );
    for (const secret of [
      first.credential,
      link.proof,
      link.user_code,
      "provider-token",
      "test-code",
    ])
      assert.ok(!dump.includes(secret));
  } finally {
    await h.mf.dispose();
  }
});
test("explicit denial/cancellation, expiration, CSRF and request validation", async () => {
  const h = await fixture();
  try {
    const a = await h.login(),
      l = await h.start();
    assert.equal(
      (
        await h.request(
          `/v1/cli-links/${l.link_id}/approve`,
          { cookie: a.headers.cookie, "idempotency-key": crypto.randomUUID() },
          "POST",
          { user_code: l.user_code, tenant_id: a.tenant },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await h.request(
          `/v1/cli-links/${l.link_id}/deny`,
          { ...a.headers, "idempotency-key": crypto.randomUUID() },
          "POST",
          { user_code: l.user_code },
        )
      ).status,
      200,
    );
    assert.equal((await h.exchange(l)).status, 403);
    const c = await h.start();
    assert.equal(
      (await h.request(`/v1/cli-links/${c.link_id}`, c.headers, "DELETE"))
        .status,
      200,
    );
    assert.equal((await h.exchange(c)).status, 403);
    const expired = await h.start();
    await h.db
      .prepare("UPDATE cli_links SET expires_at=created_at+1 WHERE link_id=?")
      .bind(expired.link_id)
      .run();
    assert.equal((await h.exchange(expired)).status, 410);
    assert.equal((await h.approve(expired, a)).status, 410);
    assert.equal(
      (
        await h.request("/v1/cli-links", { "idempotency-key": "x" }, "POST", {
          client_name: "bad",
          requested_scopes: ["admin"],
        })
      ).status,
      401,
    );
    assert.equal(await count(h, "machine_credentials"), 0);
  } finally {
    await h.mf.dispose();
  }
});
test("cross-tenant approval, bound organization, membership loss and simultaneous competing approvals cannot reassign grants", async () => {
  const h = await fixture();
  try {
    const a = await h.login(),
      b = await h.login(200),
      l = await h.start(a.tenant);
    assert.equal((await h.approve(l, b, a.tenant)).status, 404);
    assert.equal((await h.approve(l, b, b.tenant)).status, 403);
    assert.equal((await h.approve(l, a)).status, 200);
    assert.equal((await h.approve(l, b, b.tenant)).status, 403);
    await h.db
      .prepare(
        "UPDATE memberships SET status='revoked' WHERE organization_id=? AND user_id=?",
      )
      .bind(a.tenant, a.user)
      .run();
    assert.equal((await h.exchange(l)).status, 403);
    const free = await h.start();
    const results = await Promise.all([h.approve(free, b), h.approve(free, a)]);
    assert.equal(results.filter((r) => r.status === 200).length, 1);
    const issued = (await (await h.exchange(free)).json()) as Credential;
    assert.equal(issued.tenant_id, b.tenant);
    assert.equal(issued.subject_id, b.user);
  } finally {
    await h.mf.dispose();
  }
});
test("devices are isolated by tenant/user and cursor, organization selection needs re-pairing, revocation and disablement deny", async () => {
  const h = await fixture();
  try {
    const a = await h.login(),
      b = await h.login(200),
      one = await h.linked(a),
      two = await h.linked(a),
      foreign = await h.linked(b);
    const list = await h.request(
      `/v1/tenants/${a.tenant}/cli-installations?limit=1`,
      a.headers,
    );
    assert.equal(list.status, 200);
    const body = (await list.json()) as {
      items: unknown[];
      next_cursor: string;
    };
    assert.equal(body.items.length, 1);
    assert.ok(body.next_cursor);
    assert.equal(
      (
        await h.request(
          `/v1/tenants/${b.tenant}/cli-installations?cursor=${encodeURIComponent(body.next_cursor)}`,
          b.headers,
        )
      ).status,
      400,
    );
    assert.equal(
      (await h.request(`/v1/tenants/${a.tenant}/cli-installations`, b.headers))
        .status,
      404,
    );
    assert.equal(
      (
        await h.request(
          `/v1/tenants/${b.tenant}/cli-installations/${one.installation_id}`,
          b.headers,
          "DELETE",
        )
      ).status,
      404,
    );
    assert.equal(
      (await h.request(`/v1/tenants/${a.tenant}`, bearer(foreign))).status,
      401,
    );
    assert.equal(
      (await h.request(`/v1/cli/me?tenant_id=${b.tenant}`, bearer(one))).status,
      400,
    ); // client tenant claims are rejected
    const identity = (await (
      await h.request("/v1/cli/me", bearer(one))
    ).json()) as { tenant_id: string };
    assert.equal(identity.tenant_id, a.tenant);
    assert.equal(
      (await h.request("/v1/cli/me", bearer(one), "DELETE")).status,
      200,
    );
    assert.equal((await h.request("/v1/cli/me", bearer(one))).status, 401);
    assert.equal((await h.request("/v1/cli/me", bearer(two))).status, 200);
    await h.db
      .prepare("UPDATE users SET status='disabled' WHERE user_id=?")
      .bind(a.user)
      .run();
    assert.equal((await h.request("/v1/cli/me", bearer(two))).status, 401);
  } finally {
    await h.mf.dispose();
  }
});
test("machine rotation has one winner, invalidates old epoch, expiry and organization suspension fail closed", async () => {
  const h = await fixture();
  try {
    const a = await h.login(),
      c = await h.linked(a),
      headers = { ...bearer(c), "idempotency-key": crypto.randomUUID() };
    const rs = await Promise.all([
      h.request("/v1/cli/me/rotate", headers, "POST", {}),
      h.request("/v1/cli/me/rotate", headers, "POST", {}),
    ]);
    assert.equal(rs.filter((r) => r.status === 200).length, 2);
    const next = (await rs.find((r) => r.status === 200)!.json()) as Credential;
    assert.equal((await h.request("/v1/cli/me", bearer(c))).status, 401);
    assert.equal((await h.request("/v1/cli/me", bearer(next))).status, 200);
    await h.db
      .prepare(
        "UPDATE machine_credentials SET expires_at=created_at+1 WHERE credential_id=?",
      )
      .bind(next.credential_id)
      .run();
    assert.equal((await h.request("/v1/cli/me", bearer(next))).status, 401);
    const another = await h.linked(a);
    await h.db
      .prepare(
        "UPDATE organizations SET status='disabled' WHERE organization_id=?",
      )
      .bind(a.tenant)
      .run();
    assert.equal((await h.request("/v1/cli/me", bearer(another))).status, 401);
  } finally {
    await h.mf.dispose();
  }
});
