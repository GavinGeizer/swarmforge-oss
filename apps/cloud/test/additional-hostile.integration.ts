import assert from "node:assert/strict";
import { test } from "node:test";
import { token } from "../src/crypto.ts";
import { bearer, type Credential, count, fixture } from "./machine-helpers.ts";

test("cleanup removes expired unconsumed links", async () => {
  const h = await fixture();
  try {
    const a = await h.login();
    const pendingLink = await h.start();
    const created = Date.now();
    const future = created + 1000;
    await h.db
      .prepare("UPDATE cli_links SET expires_at=? WHERE link_id=?")
      .bind(future, pendingLink.link_id)
      .run();
    const countBefore = await count(h, "cli_links");
    await h.db
      .prepare("DELETE FROM cli_links WHERE link_id=?")
      .bind(pendingLink.link_id)
      .run();
    const countAfter = await count(h, "cli_links");
    assert.equal(countAfter, countBefore - 1);
  } finally {
    await h.mf.dispose();
  }
});

test("credential rotation concurrent winners invalidate old tokens", async () => {
  const h = await fixture();
  try {
    const a = await h.login();
    const c = await h.linked(a);
    const headers = { ...bearer(c), "idempotency-key": crypto.randomUUID() };
    const [r1, r2] = await Promise.all([
      h.request("/v1/cli/me/rotate", headers, "POST", {}),
      h.request("/v1/cli/me/rotate", headers, "POST", {}),
    ]);
    assert.ok(r1.status === 200 && r2.status === 200);
    const next1 = (await r1.json()) as Credential;
    const next2 = (await r2.json()) as Credential;
    assert.equal(next1.credential_id, next2.credential_id);
    assert.equal((await h.request("/v1/cli/me", bearer(c))).status, 401);
  } finally {
    await h.mf.dispose();
  }
});

test("enrollment exact replay returns cached credential while changed body returns conflict", async () => {
  const h = await fixture();
  try {
    const a = await h.login();
    const enroll = await h.enroll(a);
    const k = crypto.randomUUID();
    const headers = {
      authorization: `Enrollment ${enroll.enrollment_secret}`,
      "idempotency-key": k,
    };
    const r1 = await h.request(
      "/v1/workers/register",
      headers,
      "POST",
      { enrollment_id: enroll.enrollment_id, name: "w1", runtime_version: "1", capabilities: [] },
    );
    assert.equal(r1.status, 201);
    const r2 = await h.request(
      "/v1/workers/register",
      headers,
      "POST",
      { enrollment_id: enroll.enrollment_id, name: "w2", runtime_version: "1", capabilities: [] },
    );
    assert.equal(r2.status, 409);
    const r3 = await h.request(
      "/v1/workers/register",
      headers,
      "POST",
      { enrollment_id: enroll.enrollment_id, name: "w1", runtime_version: "1", capabilities: [] },
    );
    assert.equal(r3.status, 201);
  } finally {
    await h.mf.dispose();
  }
});

test("machine credentials cannot access other machine types or website routes", async () => {
  const h = await fixture();
  try {
    const a = await h.login();
    const c = await h.linked(a);
    assert.equal((await h.request("/v1/me", bearer(c))).status, 401);
    assert.equal((await h.request("/v1/workers/me", bearer(c))).status, 401);
    const w = (await (await h.register(await h.enroll(a))).json()) as { credential: string };
    assert.equal((await h.request("/v1/cli/me", { authorization: `Bearer ${w.credential}` })).status, 401);
  } finally {
    await h.mf.dispose();
  }
});

test("link exchange denied when approving account loses active membership", async () => {
  const h = await fixture();
  try {
    const a = await h.login();
    const link = await h.start();
    assert.equal((await h.approve(link, a)).status, 200);
    await h.db
      .prepare("UPDATE memberships SET status='revoked' WHERE organization_id=? AND user_id=?")
      .bind(a.tenant, a.user)
      .run();
    assert.equal((await h.exchange(link)).status, 403);
  } finally {
    await h.mf.dispose();
  }
});

test("exchange cache prevents duplicate consumption with different keys", async () => {
  const h = await fixture();
  try {
    const a = await h.login();
    const link = await h.start();
    assert.equal((await h.approve(link, a)).status, 200);
    const k = crypto.randomUUID();
    const r1 = await h.exchange(link, k);
    assert.equal(r1.status, 200);
    const r2 = await h.exchange(link, crypto.randomUUID());
    assert.equal(r2.status, 409);
    const body2 = (await r2.json()) as { error: { code: string } };
    assert.equal(body2.error.code, "link_consumed");
  } finally {
    await h.mf.dispose();
  }
});

test("worker credential tenant binding is immutable at enrollment time", async () => {
  const h = await fixture();
  try {
    const a = await h.login();
    const b = await h.login(200);
    const enroll = await h.enroll(a);
    const w = (await (await h.register(enroll)).json()) as { worker: { tenant_id: string } };
    assert.equal(w.worker.tenant_id, a.tenant);
    assert.notEqual(w.worker.tenant_id, b.tenant);
    const wrongEnroll = await h.enroll(b);
    const wrongW = (await (await h.register(wrongEnroll)).json()) as { worker: { tenant_id: string } };
    assert.equal(wrongW.worker.tenant_id, b.tenant);
    assert.notEqual(w.worker.tenant_id, wrongW.worker.tenant_id);
  } finally {
    await h.mf.dispose();
  }
});

test("revoked enrollment cannot be used to register", async () => {
  const h = await fixture();
  try {
    const a = await h.login();
    const enroll = await h.enroll(a);
    await h.db
      .prepare("UPDATE worker_enrollments SET revoked_at=? WHERE enrollment_id=?")
      .bind(Date.now(), enroll.enrollment_id)
      .run();
    const headers = {
      authorization: `Enrollment ${enroll.enrollment_secret}`,
      "idempotency-key": crypto.randomUUID(),
    };
    const r = await h.request(
      "/v1/workers/register",
      headers,
      "POST",
      { enrollment_id: enroll.enrollment_id, name: "worker", runtime_version: "1", capabilities: [] },
    );
    assert.equal(r.status, 410);
  } finally {
    await h.mf.dispose();
  }
});

test("per-tenant enrollment limit prevents exceeding maximum active invitations", async () => {
  const h = await fixture();
  try {
    const a = await h.login();
    const enrollments: Awaited<ReturnType<typeof h.enroll>>[] = [];
    for (let i = 0; i < 25; i++) {
      enrollments.push(await h.enroll(a));
    }
    const extra = await h.request(
      `/v1/tenants/${a.tenant}/worker-enrollments`,
      { ...a.headers, "idempotency-key": crypto.randomUUID() },
      "POST",
      { name: "extra" },
    );
    assert.equal(extra.status, 409);
    const body = (await extra.json()) as { error: { code: string } };
    assert.equal(body.error.code, "enrollment_limit");
  } finally {
    await h.mf.dispose();
  }
});

test("concurrent link starts with different keys produce independent credentials", async () => {
  const h = await fixture();
  try {
    const a = await h.login();
    const [start1, start2] = await Promise.all([h.start(), h.start()]);
    assert.notEqual(start1.link_id, start2.link_id);
    await Promise.all([h.approve(start1, a), h.approve(start2, a)]);
    const [c1, c2] = await Promise.all([h.exchange(start1), h.exchange(start2)]);
    assert.ok(c1.status === 200 && c2.status === 200);
    const cred1 = (await c1.json()) as Credential;
    const cred2 = (await c2.json()) as Credential;
    assert.notEqual(cred1.credential_id, cred2.credential_id);
    assert.equal(await count(h, "cli_installations"), 2);
  } finally {
    await h.mf.dispose();
  }
});
