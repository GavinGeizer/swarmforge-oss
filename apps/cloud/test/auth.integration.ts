import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { createWorker, type Env } from "../src/index.ts";

async function fixture() {
  let identity = { subject: "123", login: "alice" };
  let failProvider = false;
  const logs: Record<string, unknown>[] = [];
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response("ok")}}',
      compatibilityDate: "2026-10-08",
      d1Databases: ["DB"],
    }),
  );
  const db = await mf.getD1Database("DB");
  const sql = await readFile(
    new URL("../migrations/0001_identity.sql", import.meta.url),
    "utf8",
  );
  for (const stmt of sql
    .replace(/--[^\n]*/g, "")
    .split(";")
    .filter((x) => x.trim()))
    await db.prepare(stmt).run();
  const env: Env = {
    DB: db,
    APP_ORIGIN: "https://api.example.invalid",
    WEBSITE_ORIGIN: "https://api.example.invalid",
    GITHUB_CLIENT_ID: "test-client",
    GITHUB_CLIENT_SECRET: "test-provider-secret",
    AUTH_SECRET: "test-auth-secret-with-more-than-32-characters",
    ENVIRONMENT: "preview",
  };
  const worker = createWorker({
    provider: {
      async verify() {
        if (failProvider) throw new Error("provider-secret-must-never-leak");
        return identity;
      },
    },
    log: (value) => logs.push(value),
  });
  async function request(
    path: string,
    headers: Record<string, string> = {},
    options: RequestInit = {},
  ) {
    return worker.fetch(
      new Request(env.APP_ORIGIN + path, { ...options, headers }),
      env,
    );
  }
  async function login() {
    const start = await request("/v1/auth/github");
    assert.equal(start.status, 302);
    const state = new URL(start.headers.get("location")!).searchParams.get(
      "state",
    )!;
    const cookie = start.headers.get("set-cookie")!.split(";")[0]!;
    const callback = await request(
      `/v1/auth/github/callback?code=verified-provider-code&state=${state}`,
      { cookie },
    );
    assert.equal(callback.status, 302);
    const sessionCookie = callback.headers.get("set-cookie")!.split(";")[0]!;
    return { cookie: sessionCookie, state, browser: cookie };
  }
  return {
    mf,
    db,
    env,
    worker,
    request,
    login,
    logs,
    setIdentity(value: typeof identity) {
      identity = value;
    },
    failProvider() {
      failProvider = true;
    },
  };
}

test("verified provider login creates persistent personal authority and revocable session", async () => {
  const h = await fixture();
  try {
    const login = await h.login();
    const me = await h.request("/v1/me", { cookie: login.cookie });
    assert.equal(me.status, 200);
    const account = (await me.json()) as {
      subject_id: string;
      memberships: { tenant_id: string; role: string }[];
    };
    assert.equal(account.memberships[0]?.role, "owner");
    const current = await h.request("/v1/session", { cookie: login.cookie });
    const session = (await current.json()) as { csrf_token: string };
    const logout = await h.request(
      "/v1/auth/logout",
      {
        cookie: login.cookie,
        origin: h.env.APP_ORIGIN,
        "x-csrf-token": session.csrf_token,
      },
      { method: "POST" },
    );
    assert.equal(logout.status, 200);
    assert.equal(
      (await h.request("/v1/me", { cookie: login.cookie })).status,
      401,
    );
  } finally {
    await h.mf.dispose();
  }
});

test("callback replay and arbitrary state cannot create accounts", async () => {
  const h = await fixture();
  try {
    const login = await h.login();
    assert.equal(
      (
        await h.request(
          `/v1/auth/github/callback?code=other&state=${login.state}`,
          { cookie: login.browser },
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await h.request("/v1/auth/github/callback?code=arbitrary&state=fake", {
          cookie: "__Host-swarmforge-oauth=fake",
        })
      ).status,
      400,
    );
    const rows = await h.db
      .prepare("SELECT count(*) n FROM users")
      .first<{ n: number }>();
    assert.equal(rows?.n, 1);
  } finally {
    await h.mf.dispose();
  }
});

async function account(h: Awaited<ReturnType<typeof fixture>>, cookie: string) {
  const me = await h.request("/v1/me", { cookie });
  assert.equal(me.status, 200);
  return (await me.json()) as {
    subject_id: string;
    memberships: { tenant_id: string; role: string }[];
  };
}
async function mutations(
  h: Awaited<ReturnType<typeof fixture>>,
  cookie: string,
) {
  const current = await h.request("/v1/session", { cookie });
  assert.equal(current.status, 200);
  const s = (await current.json()) as {
    session_id: string;
    csrf_token: string;
  };
  return {
    cookie,
    origin: h.env.APP_ORIGIN,
    "content-type": "application/json",
    "x-csrf-token": s.csrf_token,
    "idempotency-key": "test-update",
  };
}

test("repeat login and username changes retain immutable identity and personal organization", async () => {
  const h = await fixture();
  try {
    const first = await h.login(),
      a = await account(h, first.cookie);
    h.setIdentity({ subject: "123", login: "renamed" });
    const repeat = await h.login(),
      b = await account(h, repeat.cookie);
    assert.equal(a.subject_id, b.subject_id);
    assert.deepEqual(a.memberships, b.memberships);
    h.setIdentity({ subject: "456", login: "alice" });
    const different = await h.login(),
      c = await account(h, different.cookie);
    assert.notEqual(c.subject_id, a.subject_id);
    const n = await h.db
      .prepare("SELECT count(*) n FROM organizations")
      .first<{ n: number }>();
    assert.equal(n?.n, 2);
  } finally {
    await h.mf.dispose();
  }
});

test("concurrent sign-in creates one identity and personal owner without orphan users", async () => {
  const h = await fixture();
  try {
    const [a, b] = await Promise.all([h.login(), h.login()]);
    assert.equal(
      (await account(h, a.cookie)).subject_id,
      (await account(h, b.cookie)).subject_id,
    );
    for (const table of [
      "users",
      "organizations",
      "memberships",
      "external_identities",
    ]) {
      const row = await h.db
        .prepare(`SELECT count(*) n FROM ${table}`)
        .first<{ n: number }>();
      assert.equal(row?.n, 1, table);
    }
  } finally {
    await h.mf.dispose();
  }
});

test("expired and wrong-browser OAuth state are rejected before provider verification", async () => {
  const h = await fixture();
  try {
    const start = await h.request("/v1/auth/github");
    const state = new URL(start.headers.get("location")!).searchParams.get(
      "state",
    )!;
    const browser = start.headers.get("set-cookie")!.split(";")[0]!;
    assert.equal(
      (
        await h.request(`/v1/auth/github/callback?code=x&state=${state}`, {
          cookie: `__Host-swarmforge-oauth=${"a".repeat(43)}`,
        })
      ).status,
      400,
    );
    await h.db
      .prepare("UPDATE oauth_transactions SET expires_at=created_at+1")
      .run();
    assert.equal(
      (
        await h.request(`/v1/auth/github/callback?code=x&state=${state}`, {
          cookie: browser,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await h.db
          .prepare("SELECT count(*) n FROM users")
          .first<{ n: number }>()
      )?.n,
      0,
    );
  } finally {
    await h.mf.dispose();
  }
});

test("upstream identity failure consumes callback without partial linked accounts or secret logging", async () => {
  const h = await fixture();
  try {
    h.failProvider();
    const start = await h.request("/v1/auth/github"),
      state = new URL(start.headers.get("location")!).searchParams.get(
        "state",
      )!,
      cookie = start.headers.get("set-cookie")!.split(";")[0]!;
    const response = await h.request(
      `/v1/auth/github/callback?code=secret-code&state=${state}`,
      { cookie },
    );
    assert.equal(response.status, 502);
    assert.equal(
      (
        await h.request(
          `/v1/auth/github/callback?code=secret-code&state=${state}`,
          { cookie },
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await h.db
          .prepare("SELECT count(*) n FROM users")
          .first<{ n: number }>()
      )?.n,
      0,
    );
    for (const secret of [
      "secret-code",
      state,
      "provider-secret-must-never-leak",
      h.env.GITHUB_CLIENT_SECRET,
    ]) {
      assert.ok(!JSON.stringify(h.logs).includes(secret));
    }
  } finally {
    await h.mf.dispose();
  }
});

test("tenant IDs do not grant access and cross-tenant idempotency cannot replay results", async () => {
  const h = await fixture();
  try {
    const a = await h.login(),
      aa = await account(h, a.cookie),
      orgA = aa.memberships[0]!.tenant_id;
    h.setIdentity({ subject: "456", login: "bob" });
    const b = await h.login(),
      bb = await account(h, b.cookie),
      orgB = bb.memberships[0]!.tenant_id;
    const headerA = await mutations(h, a.cookie),
      headerB = await mutations(h, b.cookie);
    for (const route of ["", "/memberships"])
      assert.equal(
        (await h.request(`/v1/tenants/${orgB}${route}`, { cookie: a.cookie }))
          .status,
        404,
      );
    assert.equal(
      (
        await h.request(`/v1/tenants/${orgB}`, headerA, {
          method: "PATCH",
          body: JSON.stringify({ display_name: "intruder" }),
        })
      ).status,
      404,
    );
    const first = await h.request(`/v1/tenants/${orgA}`, headerA, {
      method: "PATCH",
      body: JSON.stringify({ display_name: "Alpha" }),
    });
    assert.equal(first.status, 200);
    const bodyA = await first.json();
    const retry = await h.request(`/v1/tenants/${orgA}`, headerA, {
      method: "PATCH",
      body: JSON.stringify({ display_name: "Alpha" }),
    });
    assert.deepEqual(await retry.json(), bodyA);
    assert.equal(
      (
        await h.request(`/v1/tenants/${orgA}`, headerA, {
          method: "PATCH",
          body: JSON.stringify({ display_name: "Changed" }),
        })
      ).status,
      409,
    );
    const ownB = await h.request(`/v1/tenants/${orgB}`, headerB, {
      method: "PATCH",
      body: JSON.stringify({ display_name: "Beta" }),
    });
    assert.equal(ownB.status, 200);
    assert.equal(
      ((await ownB.json()) as { display_name: string }).display_name,
      "Beta",
    );
    await h.db
      .prepare("UPDATE memberships SET status='revoked' WHERE user_id=?")
      .bind(aa.subject_id)
      .run();
    assert.equal(
      (
        await h.request(`/v1/tenants/${orgA}`, headerA, {
          method: "PATCH",
          body: JSON.stringify({ display_name: "Alpha" }),
        })
      ).status,
      404,
    );
    assert.deepEqual((await account(h, a.cookie)).memberships, []);
  } finally {
    await h.mf.dispose();
  }
});

test("session and membership cursors are principal, tenant and purpose bound", async () => {
  const h = await fixture();
  try {
    const a = await h.login(),
      aa = await account(h, a.cookie);
    await h.login();
    const page = await h.request("/v1/sessions?limit=1", { cookie: a.cookie });
    const data = (await page.json()) as { next_cursor: string };
    assert.ok(data.next_cursor);
    h.setIdentity({ subject: "456", login: "bob" });
    const b = await h.login(),
      bb = await account(h, b.cookie);
    assert.equal(
      (
        await h.request(`/v1/sessions?cursor=${data.next_cursor}`, {
          cookie: b.cookie,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await h.request(`/v1/me?cursor=${data.next_cursor}`, {
          cookie: a.cookie,
        })
      ).status,
      400,
    );
    const now = Date.now();
    await h.db
      .prepare("INSERT INTO memberships VALUES(?,?,'member','active',?,?)")
      .bind(aa.memberships[0]!.tenant_id, bb.subject_id, now, now)
      .run();
    const members = await h.request(
      `/v1/tenants/${aa.memberships[0]!.tenant_id}/memberships?limit=1`,
      { cookie: a.cookie },
    );
    const list = (await members.json()) as {
      items: unknown[];
      next_cursor: string;
    };
    assert.equal(list.items.length, 1);
    assert.ok(list.next_cursor);
    assert.equal(
      (
        await h.request(
          `/v1/tenants/${bb.memberships[0]!.tenant_id}/memberships?cursor=${list.next_cursor}`,
          { cookie: b.cookie },
        )
      ).status,
      400,
    );
    await h.db
      .prepare("DELETE FROM memberships WHERE organization_id=? AND user_id=?")
      .bind(aa.memberships[0]!.tenant_id, aa.subject_id)
      .run();
    assert.equal(
      (
        await h.request(
          `/v1/tenants/${aa.memberships[0]!.tenant_id}/memberships?cursor=${list.next_cursor}`,
          { cookie: a.cookie },
        )
      ).status,
      404,
    );
  } finally {
    await h.mf.dispose();
  }
});

test("disabled users, expired/revoked/forged sessions and repository bearers fail closed", async () => {
  const h = await fixture();
  try {
    assert.equal(
      (
        await h.request("/v1/me", {
          authorization: "Bearer github-repository-token",
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await h.request("/v1/me", {
          cookie: `__Host-swarmforge=${"a".repeat(43)}`,
        })
      ).status,
      401,
    );
    const a = await h.login(),
      aa = await account(h, a.cookie);
    await h.db
      .prepare("UPDATE users SET status='disabled' WHERE user_id=?")
      .bind(aa.subject_id)
      .run();
    assert.equal((await h.request("/v1/me", { cookie: a.cookie })).status, 403);
    const again = await h.request("/v1/auth/github");
    const state = new URL(again.headers.get("location")!).searchParams.get(
      "state",
    )!;
    assert.equal(
      (
        await h.request(`/v1/auth/github/callback?code=x&state=${state}`, {
          cookie: again.headers.get("set-cookie")!.split(";")[0]!,
        })
      ).status,
      403,
    );
    await h.db
      .prepare("UPDATE users SET status='active' WHERE user_id=?")
      .bind(aa.subject_id)
      .run();
    await h.db.prepare("UPDATE sessions SET expires_at=created_at+1").run();
    assert.equal((await h.request("/v1/me", { cookie: a.cookie })).status, 401);
  } finally {
    await h.mf.dispose();
  }
});

test("CSRF, strict input, body limits, CORS and security headers apply", async () => {
  const h = await fixture();
  try {
    const a = await h.login(),
      aa = await account(h, a.cookie),
      org = aa.memberships[0]!.tenant_id,
      headers = await mutations(h, a.cookie);
    const missing = { ...headers };
    delete (missing as Partial<typeof headers>)["x-csrf-token"];
    assert.equal(
      (
        await h.request(`/v1/tenants/${org}`, missing, {
          method: "PATCH",
          body: '{"display_name":"x"}',
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await h.request(
          `/v1/tenants/${org}`,
          { ...headers, origin: "https://attacker.invalid" },
          { method: "PATCH", body: '{"display_name":"x"}' },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await h.request(`/v1/tenants/${org}`, headers, {
          method: "PATCH",
          body: '{"display_name":"x","role":"owner"}',
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await h.request(`/v1/tenants/${org}`, headers, {
          method: "PATCH",
          body: JSON.stringify({ display_name: "x".repeat(131073) }),
        })
      ).status,
      413,
    );
    assert.equal(
      (
        await h.request("/v1/me", {
          cookie: a.cookie,
          origin: "https://attacker.invalid",
        })
      ).status,
      403,
    );
    const own = await h.request("/v1/me", {
      cookie: a.cookie,
      origin: h.env.APP_ORIGIN,
    });
    assert.equal(
      own.headers.get("access-control-allow-origin"),
      h.env.APP_ORIGIN,
    );
    assert.equal(own.headers.get("cache-control"), "no-store");
    assert.equal(own.headers.get("referrer-policy"), "no-referrer");
    assert.ok(own.headers.get("content-security-policy"));
    const preflight = await h.request(
      "/v1/me",
      {
        origin: "https://attacker.invalid",
        "access-control-request-method": "GET",
      },
      { method: "OPTIONS" },
    );
    assert.equal(preflight.status, 403);
    assert.equal(preflight.headers.get("access-control-allow-origin"), null);
    assert.equal(
      (
        await h.request(
          `/v1/tenants/${org}`,
          { ...headers, cookie: `${a.cookie}; ${a.cookie}` },
          { method: "PATCH", body: "{}" },
        )
      ).status,
      400,
    );
  } finally {
    await h.mf.dispose();
  }
});

test("audit failure rolls back privileged updates and D1 outage never authorizes", async () => {
  const h = await fixture();
  try {
    const a = await h.login(),
      aa = await account(h, a.cookie),
      org = aa.memberships[0]!.tenant_id,
      headers = await mutations(h, a.cookie);
    await h.db.prepare("DROP TABLE audit_events").run();
    assert.equal(
      (
        await h.request(`/v1/tenants/${org}`, headers, {
          method: "PATCH",
          body: '{"display_name":"unsafe"}',
        })
      ).status,
      503,
    );
    const record = await h.db
      .prepare("SELECT display_name FROM organizations WHERE organization_id=?")
      .bind(org)
      .first<{ display_name: string }>();
    assert.notEqual(record?.display_name, "unsafe");
    assert.equal(
      (
        await h.db
          .prepare("SELECT count(*) n FROM request_dedup")
          .first<{ n: number }>()
      )?.n,
      0,
    );
    await h.db.prepare("DROP TABLE memberships").run();
    assert.equal(
      (await h.request(`/v1/tenants/${org}`, { cookie: a.cookie })).status,
      503,
    );
  } finally {
    await h.mf.dispose();
  }
});

test("only owner/admin can update settings; session revocation is user scoped", async () => {
  const h = await fixture();
  try {
    const a = await h.login(),
      aa = await account(h, a.cookie),
      a2 = await h.login(),
      headers = await mutations(h, a.cookie);
    const s2 = await h.request("/v1/session", { cookie: a2.cookie });
    const other = (await s2.json()) as { session_id: string };
    h.setIdentity({ subject: "456", login: "bob" });
    const b = await h.login(),
      bb = await account(h, b.cookie),
      headerB = await mutations(h, b.cookie);
    assert.equal(
      (
        await h.request(`/v1/sessions/${other.session_id}`, headerB, {
          method: "DELETE",
        })
      ).status,
      404,
    );
    const revoked = await h.request(
      `/v1/sessions/${other.session_id}`,
      headers,
      { method: "DELETE" },
    );
    assert.equal(revoked.status, 200);
    const proof = await revoked.json();
    assert.deepEqual(
      await (
        await h.request(`/v1/sessions/${other.session_id}`, headers, {
          method: "DELETE",
        })
      ).json(),
      proof,
    );
    assert.equal(
      (await h.request("/v1/me", { cookie: a2.cookie })).status,
      401,
    );
    const now = Date.now();
    await h.db
      .prepare("INSERT INTO memberships VALUES(?,?,'member','active',?,?)")
      .bind(aa.memberships[0]!.tenant_id, bb.subject_id, now, now)
      .run();
    assert.equal(
      (
        await h.request(`/v1/tenants/${aa.memberships[0]!.tenant_id}`, {
          cookie: b.cookie,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await h.request(
          `/v1/tenants/${aa.memberships[0]!.tenant_id}`,
          headerB,
          { method: "PATCH", body: '{"display_name":"unauthorized"}' },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await h.request(
          `/v1/tenants/${aa.memberships[0]!.tenant_id}/memberships`,
          { cookie: b.cookie },
        )
      ).status,
      403,
    );
  } finally {
    await h.mf.dispose();
  }
});

test("concurrent identical mutation keys have one durable effect and audit event", async () => {
  const h = await fixture();
  try {
    const a = await h.login(),
      aa = await account(h, a.cookie),
      headers = await mutations(h, a.cookie),
      path = `/v1/tenants/${aa.memberships[0]!.tenant_id}`;
    const replies = await Promise.all(
      [1, 2].map(() =>
        h.request(path, headers, {
          method: "PATCH",
          body: '{"display_name":"concurrent"}',
        }),
      ),
    );
    for (const reply of replies) assert.equal(reply.status, 200);
    assert.deepEqual(await replies[0]!.json(), await replies[1]!.json());
    assert.equal(
      (
        await h.db
          .prepare("SELECT count(*) n FROM request_dedup")
          .first<{ n: number }>()
      )?.n,
      1,
    );
    assert.equal(
      (
        await h.db
          .prepare(
            "SELECT count(*) n FROM audit_events WHERE action='organization.updated'",
          )
          .first<{ n: number }>()
      )?.n,
      1,
    );
  } finally {
    await h.mf.dispose();
  }
});

test("account bootstrap batch rolls back and query claims cannot link identities", async () => {
  const h = await fixture();
  try {
    const start = await h.request("/v1/auth/github"),
      state = new URL(start.headers.get("location")!).searchParams.get(
        "state",
      )!,
      cookie = start.headers.get("set-cookie")!.split(";")[0]!;
    assert.equal(
      (
        await h.request(
          `/v1/auth/github/callback?code=x&state=${state}&user_id=${crypto.randomUUID()}`,
          { cookie },
        )
      ).status,
      400,
    );
    await h.db.prepare("DROP TABLE audit_events").run();
    assert.equal(
      (
        await h.request(`/v1/auth/github/callback?code=x&state=${state}`, {
          cookie,
        })
      ).status,
      503,
    );
    for (const table of [
      "users",
      "organizations",
      "memberships",
      "external_identities",
      "sessions",
    ])
      assert.equal(
        (
          await h.db
            .prepare(`SELECT count(*) n FROM ${table}`)
            .first<{ n: number }>()
        )?.n,
        0,
      );
  } finally {
    await h.mf.dispose();
  }
});

test("missing auth configuration and unmigrated D1 return coarse unavailability", async () => {
  const h = await fixture();
  try {
    h.env.GITHUB_CLIENT_SECRET = "";
    assert.equal((await h.request("/v1/auth/github")).status, 503);
    const ready = await h.request("/ready");
    assert.equal(ready.status, 503);
    assert.ok(
      !JSON.stringify(await ready.json()).includes("GITHUB_CLIENT_SECRET"),
    );
    assert.equal((await h.request("/health")).status, 200);
    h.env.GITHUB_CLIENT_SECRET = "test-provider-secret";
    await h.db.prepare("DROP TABLE request_dedup").run();
    assert.equal((await h.request("/ready")).status, 503);
  } finally {
    await h.mf.dispose();
  }
});
