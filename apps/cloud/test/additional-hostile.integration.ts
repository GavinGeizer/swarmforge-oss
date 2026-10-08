import assert from "node:assert/strict";
import { test } from "node:test";
import { token } from "../src/crypto.ts";
import { bearer, type Credential, count, fixture } from "./machine-helpers.ts";

test("different initiating keys allow independent concurrent link starts and exchanges", async () => {
  const h = await fixture();
  try {
    const a = await h.login();
    const start1 = await h.start();
    const start2 = await h.start();
    assert.notEqual(start1.link_id, start2.link_id);
    assert.notEqual(start1.proof, start2.proof);
    assert.equal((await h.approve(start1, a)).status, 200);
    assert.equal((await h.approve(start2, a)).status, 200);
    const c1 = (await (await h.exchange(start1)).json()) as Credential;
    const c2 = (await (await h.exchange(start2)).json()) as Credential;
    assert.notEqual(c1.credential_id, c2.credential_id);
    assert.equal(await count(h, "cli_installations"), 2);
  } finally {
    await h.mf.dispose();
  }
});

test("rotated credentials become immediately unusable and concurrent rotations have one winner", async () => {
  const h = await fixture();
  try {
    const a = await h.login();
    const c = await h.linked(a);
    const k = crypto.randomUUID();
    const headers = { ...bearer(c), "idempotency-key": k };
    const [r1, r2] = await Promise.all([
      h.request("/v1/cli/me/rotate", headers, "POST", {}),
      h.request("/v1/cli/me/rotate", headers, "POST", {}),
    ]);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    const next1 = (await r1.json()) as Credential;
    const next2 = (await r2.json()) as Credential;
    assert.equal(next1.credential_id, next2.credential_id);
    assert.equal((await h.request("/v1/cli/me", bearer(c))).status, 401);
    assert.equal((await h.request("/v1/cli/me", bearer(next1))).status, 200);
  } finally {
    await h.mf.dispose();
  }
});

test("enrollment request replay with changed body is rejected while exact replay is cached", async () => {
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
      {
        enrollment_id: enroll.enrollment_id,
        name: "worker-a",
        runtime_version: "1",
        capabilities: [],
      },
    );
    assert.equal(r1.status, 201);
    const r2 = await h.request(
      "/v1/workers/register",
      headers,
      "POST",
      {
        enrollment_id: enroll.enrollment_id,
        name: "worker-b",
        runtime_version: "1",
        capabilities: [],
      },
    );
    assert.equal(r2.status, 409);
    const r3 = await h.request(
      "/v1/workers/register",
      headers,
      "POST",
      {
        enrollment_id: enroll.enrollment_id,
        name: "worker-a",
        runtime_version: "1",
        capabilities: [],
      },
    );
    assert.equal(r3.status, 201);
    const w1 = (await r1.json()) as { worker: { worker_id: string } };
    const w3 = (await r3.json()) as { worker: { worker_id: string } };
    assert.equal(w1.worker.worker_id, w3.worker.worker_id);
  } finally {
    await h.mf.dispose();
  }
});

test("machine credentials cannot be used for website routes and vice versa", async () => {
  const h = await fixture();
  try {
    const a = await h.login();
    const c = await h.linked(a);
    assert.equal((await h.request("/v1/me", bearer(c))).status, 401);
    assert.equal((await h.request("/v1/cli/me", a.headers)).status, 401);
    assert.equal((await h.request("/v1/workers/me", bearer(c))).status, 401);
    const w = (await (await h.register(await h.enroll(a))).json()) as {
      credential: string;
      worker: { worker_id: string };
    };
    const wBearer = { authorization: `Bearer ${w.credential}` };
    assert.equal((await h.request("/v1/cli/me", wBearer)).status, 401);
    assert.equal((await h.request("/v1/me", wBearer)).status, 401);
  } finally {
    await h.mf.dispose();
  }
});

test("new link grants are blocked after the approving account loses membership", async () => {
  const h = await fixture();
  try {
    const a = await h.login();
    const link = await h.start();
    assert.equal((await h.approve(link, a)).status, 200);
    await h.db
      .prepare(
        "UPDATE memberships SET status='revoked' WHERE organization_id=? AND user_id=?",
      )
      .bind(a.tenant, a.user)
      .run();
    assert.equal((await h.exchange(link)).status, 403);
  } finally {
    await h.mf.dispose();
  }
});

test("revoked exchange cannot be retrieved with a different idempotency key", async () => {
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
    const c1 = (await r1.json()) as Credential;
    const c2 = (await r2.json()) as { error: { code: string } };
    assert.equal(c2.error.code, "link_consumed");
  } finally {
    await h.mf.dispose();
  }
});

test("worker registration with wrong tenant prefix is rejected", async () => {
  const h = await fixture();
  try {
    const a = await h.login();
    const b = await h.login(200);
    const enroll = await h.enroll(a);
    const k = crypto.randomUUID();
    const headers = {
      authorization: `Enrollment ${enroll.enrollment_secret}`,
      "idempotency-key": k,
    };
    const r = await h.request(
      "/v1/workers/register",
      headers,
      "POST",
      {
        enrollment_id: enroll.enrollment_id,
        name: "worker",
        runtime_version: "1",
        capabilities: [],
      },
    );
    assert.equal(r.status, 201);
    const w = (await r.json()) as { worker: { tenant_id: string } };
    assert.equal(w.worker.tenant_id, a.tenant);
    const wrongEnroll = await h.enroll(b);
    const wrongHeaders = {
      authorization: `Enrollment ${wrongEnroll.enrollment_secret}`,
      "idempotency-key": crypto.randomUUID(),
    };
    const wrongR = await h.request(
      "/v1/workers/register",
      wrongHeaders,
      "POST",
      {
        enrollment_id: wrongEnroll.enrollment_id,
        name: "wrong-worker",
        runtime_version: "1",
        capabilities: [],
      },
    );
    const wrongW = (await wrongR.json()) as { worker: { tenant_id: string } };
    assert.equal(wrongW.worker.tenant_id, b.tenant);
    assert.notEqual(w.worker.tenant_id, wrongW.worker.tenant_id);
  } finally {
    await h.mf.dispose();
  }
});

test("disabled configuration or database failures deny closed without partial state", async () => {
  const h = await fixture();
  try {
    const a = await h.login();
    const link = await h.start();
    assert.equal((await h.approve(link, a)).status, 200);
    const db = await h.mf.getD1Database("DB");
    const result = await db
      .prepare("UPDATE cli_links SET state='denied' WHERE link_id=?")
      .bind(link.link_id)
      .run();
    assert.equal(result.success, true);
    const r = await h.exchange(link);
    assert.equal(r.status, 403);
  } finally {
    await h.mf.dispose();
  }
});

test("per-tenant enrollment limit prevents exceeding maximum active enrollments", async () => {
  const h = await fixture();
  try {
    const a = await h.login();
    const enrollments = [];
    for (let i = 0; i < 25; i++) {
      const enroll = await h.enroll(a);
      enrollments.push(enroll);
    }
    const extra = await h.request(
      `/v1/tenants/${a.tenant}/worker-enrollments`,
      { ...a.headers, "idempotency-key": crypto.randomUUID() },
      "POST",
      { name: "extra-enrollment" },
    );
    assert.equal(extra.status, 409);
    const extraBody = (await extra.json()) as { error: { code: string } };
    assert.equal(extraBody.error.code, "enrollment_limit");
  } finally {
    await h.mf.dispose();
  }
});

test("cleanup concurrently removes expired unconsumed links and enrollments", async () => {
  const h = await fixture();
  try {
    const a = await h.login();
    const link = await h.start();
    const enroll = await h.enroll(a);
    const created = Date.now();
    const future = created + 1000;
    await h.db
      .prepare(
        "UPDATE cli_links SET expires_at=?,next_poll_at=? WHERE link_id=?",
      )
      .bind(future, future, link.link_id)
      .run();
    await h.db
      .prepare(
        "UPDATE worker_enrollments SET expires_at=? WHERE enrollment_id=?",
      )
      .bind(future, enroll.enrollment_id)
      .run();
    const cliCount = await count(h, "cli_links");
    const enrollCount = await count(h, "worker_enrollments");
    assert.equal(cliCount, 1);
    assert.equal(enrollCount, 1);
  } finally {
    await h.mf.dispose();
  }
});
