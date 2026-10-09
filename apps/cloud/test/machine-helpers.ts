import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  convertV4MiniflareOptions,
  Miniflare,
  Response as RuntimeResponse,
} from "miniflare";
import { token } from "../src/crypto.ts";
import { applyMigrations, type FixtureSchema } from "./migrations.ts";

const bundled = build({
  entryPoints: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
  bundle: true,
  write: false,
  format: "esm",
  target: "es2023",
});
export async function fixture(
  origin = "https://api.example.invalid",
  options: { schema?: FixtureSchema } = {},
) {
  let subject = 100;
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: (await bundled).outputFiles[0]!.text,
      compatibilityDate: "2026-10-08",
      d1Databases: ["DB"],
      bindings: {
        APP_ORIGIN: origin,
        WEBSITE_ORIGIN: origin,
        ENVIRONMENT: origin.startsWith("http:") ? "local" : "preview",
        GITHUB_CLIENT_ID: "client",
        GITHUB_CLIENT_SECRET: "provider-secret",
        AUTH_SECRET: "test-auth-secret-with-at-least-thirty-two-characters",
      },
      outboundService: async (request) =>
        new RuntimeResponse(
          JSON.stringify(
            request.url.endsWith("/access_token")
              ? {
                  access_token: "provider-token",
                  token_type: "bearer",
                  scope: "read:user",
                }
              : { id: subject, login: `user${subject}` },
          ),
          { headers: { "content-type": "application/json" } },
        ),
    }),
  );
  const db = await mf.getD1Database("DB");
  await applyMigrations(db, options.schema ?? "phase2b2");
  async function request(
    path: string,
    headers: Record<string, string> = {},
    method = "GET",
    data?: unknown,
  ) {
    return mf.dispatchFetch(origin + path, {
      method,
      redirect: "manual",
      headers: {
        ...(data === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
  }
  async function login(id = 100) {
    subject = id;
    const start = await request("/v1/auth/github");
    assert.equal(start.status, 302);
    const state = new URL(start.headers.get("location")!).searchParams.get(
      "state",
    )!;
    const callback = await request(
      `/v1/auth/github/callback?code=test-code&state=${state}`,
      { cookie: start.headers.get("set-cookie")!.split(";")[0]! },
    );
    assert.equal(callback.status, 302);
    const cookie = callback.headers.get("set-cookie")!.split(";")[0]!;
    const me = (await (await request("/v1/me", { cookie })).json()) as {
      subject_id: string;
      memberships: { tenant_id: string }[];
    };
    const session = (await (
      await request("/v1/session", { cookie })
    ).json()) as { csrf_token: string };
    return {
      user: me.subject_id,
      tenant: me.memberships[0]!.tenant_id,
      headers: { cookie, origin, "x-csrf-token": session.csrf_token },
    };
  }
  async function start(
    tenant?: string,
    secret = token(),
    k = crypto.randomUUID(),
  ) {
    const headers = {
      authorization: `LinkInitiator ${secret}`,
      "idempotency-key": k,
    };
    const r = await request("/v1/cli-links", headers, "POST", {
      client_name: "workstation",
      requested_scopes: ["identity:read", "devices:self"],
      ...(tenant ? { tenant_id: tenant } : {}),
    });
    assert.equal(r.status, 201);
    const value = (await r.json()) as {
      link_id: string;
      user_code: string;
      expires_at: number;
      verification_url: string;
    };
    return { ...value, headers, proof: secret };
  }
  async function approve(
    link: Awaited<ReturnType<typeof start>>,
    account: Awaited<ReturnType<typeof login>>,
    tenant = account.tenant,
    k = crypto.randomUUID(),
  ) {
    return request(
      `/v1/cli-links/${link.link_id}/approve`,
      { ...account.headers, "idempotency-key": k },
      "POST",
      { user_code: link.user_code, tenant_id: tenant },
    );
  }
  async function exchange(
    link: Awaited<ReturnType<typeof start>>,
    k = crypto.randomUUID(),
  ) {
    return request(
      `/v1/cli-links/${link.link_id}/exchange`,
      { ...link.headers, "idempotency-key": k },
      "POST",
      {},
    );
  }
  async function linked(
    account: Awaited<ReturnType<typeof login>>,
    tenant = account.tenant,
  ) {
    const link = await start(tenant);
    assert.equal((await approve(link, account, tenant)).status, 200);
    const response = await exchange(link);
    assert.equal(response.status, 200);
    return (await response.json()) as Credential;
  }
  async function enroll(account: Awaited<ReturnType<typeof login>>) {
    const r = await request(
      `/v1/tenants/${account.tenant}/worker-enrollments`,
      { ...account.headers, "idempotency-key": crypto.randomUUID() },
      "POST",
      { name: "customer-worker" },
    );
    assert.equal(r.status, 201);
    return (await r.json()) as {
      enrollment_id: string;
      enrollment_secret: string;
      expires_at: number;
    };
  }
  async function register(
    e: Awaited<ReturnType<typeof enroll>>,
    k = crypto.randomUUID(),
  ) {
    return request(
      "/v1/workers/register",
      {
        authorization: `Enrollment ${e.enrollment_secret}`,
        "idempotency-key": k,
      },
      "POST",
      {
        enrollment_id: e.enrollment_id,
        name: "runtime-hint",
        runtime_version: "1",
        capabilities: [],
      },
    );
  }
  return {
    mf,
    db,
    request,
    login,
    start,
    approve,
    exchange,
    linked,
    enroll,
    register,
  };
}
export interface Credential {
  credential: string;
  credential_id: string;
  installation_id?: string;
  worker_id?: string;
  subject_id: string;
  tenant_id: string;
  expires_at: number;
  authorization_expires_at: number;
  scopes: string[];
}
export function bearer(c: Credential) {
  return { authorization: `Bearer ${c.credential}` };
}
export async function count(
  h: Awaited<ReturnType<typeof fixture>>,
  table: string,
) {
  return (await h.db
    .prepare(`SELECT count(*) n FROM ${table}`)
    .first<{ n: number }>())!.n;
}
