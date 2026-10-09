import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  convertV4MiniflareOptions,
  Miniflare,
  Response as RuntimeResponse,
} from "miniflare";
import { token } from "../src/crypto.ts";
import type { PolicyInput } from "../src/hosted-entitlements.ts";

// Uniquely-named helper for the hosted-status packet: bundles ONLY the new
// production hostedStatusRoute through a TEMPORARY status router plus the
// shared lead-owned worker, over real workerd D1. This is NOT a global
// integration: the lead wires hostedStatusRoute into the global router after
// prerequisites. Existing fixtures (machine-helpers, hosted-helpers,
// hosted-test-router) are untouched.
const statusBundled = build({
  entryPoints: [
    fileURLToPath(new URL("./hosted-status-router.ts", import.meta.url)),
  ],
  bundle: true,
  write: false,
  format: "esm",
  target: "es2023",
});

export async function hostedStatusFixture(
  origin = "https://api.example.invalid",
) {
  let subject = 100;
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: (await statusBundled).outputFiles[0]!.text,
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
  const { applyMigrations } = await import("./migrations.ts");
  await applyMigrations(db, "phase2b2");
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
  type Account = Awaited<ReturnType<typeof login>>;
  async function linkedDevice(account: Account, tenant = account.tenant) {
    const secret = token();
    const headers = {
      authorization: `LinkInitiator ${secret}`,
      "idempotency-key": crypto.randomUUID(),
    };
    const r = await request("/v1/cli-links", headers, "POST", {
      client_name: "workstation",
      requested_scopes: ["identity:read", "devices:self"],
      tenant_id: tenant,
    });
    assert.equal(r.status, 201);
    const link = (await r.json()) as { link_id: string; user_code: string };
    const approve = await request(
      `/v1/cli-links/${link.link_id}/approve`,
      { ...account.headers, "idempotency-key": crypto.randomUUID() },
      "POST",
      { user_code: link.user_code, tenant_id: tenant },
    );
    assert.equal(approve.status, 200);
    const exchange = await request(
      `/v1/cli-links/${link.link_id}/exchange`,
      { ...headers, "idempotency-key": crypto.randomUUID() },
      "POST",
      {},
    );
    assert.equal(exchange.status, 200);
    return (await exchange.json()) as {
      credential: string;
      credential_id: string;
      installation_id: string;
    };
  }
  async function seedPolicy(tenant: string, input: PolicyInput) {
    const { putPolicy } = await import("../src/hosted-entitlements.ts");
    const op = (await db
      .prepare(
        "SELECT user_id FROM memberships WHERE organization_id=? LIMIT 1",
      )
      .bind(tenant)
      .first<{ user_id: string }>())!.user_id;
    return putPolicy(
      {
        env: {
          DB: db,
          AUTH_SECRET: "test-auth-secret-with-at-least-thirty-two-characters",
          APP_ORIGIN: origin,
          WEBSITE_ORIGIN: origin,
          ENVIRONMENT: "local",
        },
        request: new Request(`${origin}/`),
        request_id: crypto.randomUUID(),
        route: "operator.policy",
        actor: op,
      } as never,
      tenant,
      input,
      op,
    );
  }
  async function authorizeExecution(
    account: Account,
    tenant: string,
    installation: string,
    k = crypto.randomUUID(),
  ) {
    return request(
      `/v1/tenants/${tenant}/cli-installations/${installation}/execution-authorizations`,
      { ...account.headers, "idempotency-key": k },
      "POST",
      {},
    );
  }
  return {
    mf,
    db,
    request,
    login,
    linkedDevice,
    seedPolicy,
    authorizeExecution,
  };
}

export const statusDefaultPolicy: PolicyInput = {
  capabilities: {
    hosted_control_plane: true,
    remote_worker_enrollment: true,
    hosted_task_execution: true,
  },
  max_concurrent_workers: 4,
  max_active_tasks: 8,
  max_task_runtime: 60000,
  maximum_resource_reservations: 16,
  valid_for_ms: 86400000,
};
