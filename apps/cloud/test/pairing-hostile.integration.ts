import assert from "node:assert/strict";
import { test } from "node:test";
import { bearer, type Credential, count, fixture } from "./machine-helpers.ts";

test("simultaneous account approvals and separate linking exchanges cannot cross-bind accounts or organizations", async () => {
  const h = await fixture();
  try {
    const a = await h.login(),
      b = await h.login(200),
      l = await h.start();
    const approvals = await Promise.all([h.approve(l, a), h.approve(l, b)]);
    assert.equal(approvals.filter((r) => r.status === 200).length, 1);
    const winner = approvals[0]!.status === 200 ? a : b,
      grant = (await (await h.exchange(l)).json()) as Credential;
    assert.equal(grant.subject_id, winner.user);
    assert.equal(grant.tenant_id, winner.tenant);
    const la = await h.start(a.tenant),
      lb = await h.start(b.tenant);
    await Promise.all([h.approve(la, a), h.approve(lb, b)]);
    const rs = await Promise.all([h.exchange(la), h.exchange(lb)]);
    assert.ok(rs.every((r) => r.status === 200));
    const ca = (await rs[0]!.json()) as Credential,
      cb = (await rs[1]!.json()) as Credential;
    assert.equal(ca.subject_id, a.user);
    assert.equal(cb.subject_id, b.user);
    assert.equal(ca.tenant_id, a.tenant);
    assert.equal(cb.tenant_id, b.tenant);
  } finally {
    await h.mf.dispose();
  }
});
test("approval code lock, idempotency conflict, unapproved scopes and cross-proof replay cannot mint credentials", async () => {
  const h = await fixture();
  try {
    const a = await h.login(),
      l = await h.start();
    for (let i = 0; i < 5; i++)
      assert.equal(
        (
          await h.request(
            `/v1/cli-links/${l.link_id}/approve`,
            { ...a.headers, "idempotency-key": crypto.randomUUID() },
            "POST",
            { user_code: "A".repeat(12), tenant_id: a.tenant },
          )
        ).status,
        400,
      );
    assert.equal((await h.approve(l, a)).status, 403);
    assert.equal(await count(h, "machine_credentials"), 0);
    assert.equal(
      (
        await h.request("/v1/cli-links", l.headers, "POST", {
          client_name: "changed",
          requested_scopes: ["identity:read", "devices:self"],
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await h.request(
          "/v1/cli-links",
          { ...l.headers, authorization: `LinkInitiator ${"Z".repeat(43)}` },
          "POST",
          {
            client_name: "attacker",
            requested_scopes: ["identity:read", "workers:enroll"],
          },
        )
      ).status,
      400,
    );
  } finally {
    await h.mf.dispose();
  }
});
test("rotation retry is proof/idempotency/audience bound and cannot resurrect revoked credentials", async () => {
  const h = await fixture();
  try {
    const a = await h.login(),
      c = await h.linked(a),
      key = crypto.randomUUID(),
      headers = { ...bearer(c), "idempotency-key": key };
    const r = await h.request("/v1/cli/me/rotate", headers, "POST", {});
    assert.equal(r.status, 200);
    const next = (await r.json()) as Credential;
    const retry = await h.request("/v1/cli/me/rotate", headers, "POST", {});
    assert.equal(retry.status, 200);
    assert.deepEqual(await retry.json(), next);
    assert.equal(
      (
        await h.request(
          "/v1/cli/me/rotate",
          { ...headers, "idempotency-key": crypto.randomUUID() },
          "POST",
          {},
        )
      ).status,
      401,
    );
    assert.equal(
      (await h.request("/v1/workers/me/rotate", headers, "POST", {})).status,
      401,
    );
    assert.equal(
      (await h.request("/v1/cli/me", bearer(next), "DELETE")).status,
      200,
    );
    assert.equal(
      (await h.request("/v1/cli/me/rotate", headers, "POST", {})).status,
      401,
    );
  } finally {
    await h.mf.dispose();
  }
});
test("multiple memberships require fresh browser authority; deleted membership and stale approval session deny grants", async () => {
  const h = await fixture();
  try {
    const a = await h.login(),
      b = await h.login(200),
      now = Date.now();
    await h.db
      .prepare("INSERT INTO memberships VALUES(?,?,'member','active',?,?)")
      .bind(b.tenant, a.user, now, now)
      .run();
    const device = await h.linked(a),
      organizations = await h.request(
        "/v1/cli/organizations?limit=1",
        bearer(device),
      );
    assert.equal(organizations.status, 200);
    const orgs = (await organizations.json()) as {
      items: unknown[];
      next_cursor: string;
    };
    assert.equal(orgs.items.length, 1);
    assert.ok(orgs.next_cursor);
    const page = await h.request(
      `/v1/cli/organizations?cursor=${encodeURIComponent(orgs.next_cursor)}`,
      bearer(device),
    );
    assert.equal(page.status, 200);
    const foreign = await h.linked(b);
    assert.equal(
      (
        await h.request(
          `/v1/cli/organizations?cursor=${encodeURIComponent(orgs.next_cursor)}`,
          bearer(foreign),
        )
      ).status,
      400,
    );
    const rebinding = await h.start(b.tenant);
    assert.equal((await h.approve(rebinding, a, b.tenant)).status, 200);
    const second = (await (await h.exchange(rebinding)).json()) as Credential;
    assert.equal(second.tenant_id, b.tenant);
    await h.db
      .prepare("DELETE FROM memberships WHERE organization_id=? AND user_id=?")
      .bind(b.tenant, a.user)
      .run();
    assert.equal((await h.request("/v1/cli/me", bearer(second))).status, 401);
    const link = await h.start();
    assert.equal((await h.approve(link, a)).status, 200);
    assert.equal(
      (await h.request("/v1/auth/logout", a.headers, "POST")).status,
      200,
    );
    assert.equal((await h.exchange(link)).status, 403);
  } finally {
    await h.mf.dispose();
  }
});
test("approval page safely redirects through browser login, rejects open redirects and binds OAuth return target server-side", async () => {
  const h = await fixture();
  try {
    const l = await h.start();
    const page = await h.request(`/cloud/connect?link_id=${l.link_id}`);
    assert.equal(page.status, 302);
    const loginUrl = new URL(page.headers.get("location")!);
    const begin = await h.request(loginUrl.pathname + loginUrl.search);
    assert.equal(begin.status, 302);
    const state = new URL(begin.headers.get("location")!).searchParams.get(
      "state",
    )!;
    const cb = await h.request(
      `/v1/auth/github/callback?code=code&state=${state}`,
      { cookie: begin.headers.get("set-cookie")!.split(";")[0]! },
    );
    assert.equal(cb.status, 302);
    assert.equal(cb.headers.get("location"), l.verification_url);
    assert.equal(
      (await h.request("/v1/auth/github?return_to=https%3A%2F%2Fevil.invalid"))
        .status,
      400,
    );
  } finally {
    await h.mf.dispose();
  }
});
