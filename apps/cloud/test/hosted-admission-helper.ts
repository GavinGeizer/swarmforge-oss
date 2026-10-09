import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  convertV4MiniflareOptions,
  Miniflare,
  Response as RuntimeResponse,
} from "miniflare";
import { token } from "../src/crypto.ts";
import type { PolicyInput } from "../src/hosted-entitlements.ts";

// Admission-test-only fixture. Bundles the NEW production admission module
// alongside the frozen authority/entitlement handlers through a stdin router,
// WITHOUT touching hosted-helpers.ts, hosted-test-router.ts, index.ts, the
// schema, or any existing fixture. Deleted/merged at lead integration.

const routerSource = `
import { z } from "zod";
import type { Context, Env } from "../src/common.ts";
import { allowedOrigin, HttpError, json } from "../src/common.ts";
import { hostedAdmissionRoute } from "../src/hosted-admission.ts";
import { hostedAuthorityRoute } from "../src/hosted-authority.ts";
import { entitlementsRoute } from "../src/hosted-entitlements.ts";
import { createWorker } from "../src/index.ts";
import { errorSchema } from "../src/schemas.ts";
const base = createWorker();
export default {
  async scheduled(event: ScheduledController, env: Env) {
    await base.scheduled(event, env);
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    const ctx: Context = {
      request,
      env,
      request_id: crypto.randomUUID(),
      route: "hosted-admission-test",
      actor: null,
    };
    for (const handler of [hostedAdmissionRoute, hostedAuthorityRoute, entitlementsRoute]) {
      try {
        const response = await handler(ctx);
        if (response) return response;
      } catch (error) {
        const failure =
          error instanceof HttpError
            ? error
            : error instanceof z.ZodError
              ? new HttpError(400, "invalid_request", "Request is invalid")
              : new HttpError(503, "temporarily_unavailable", "Service is temporarily unavailable");
        const response = json(
          errorSchema,
          { error: { code: failure.code, message: failure.message, request_id: ctx.request_id } },
          failure.status,
        );
        const origin = allowedOrigin(ctx);
        if (origin) {
          response.headers.set("access-control-allow-origin", origin);
          response.headers.set("access-control-allow-credentials", "true");
          response.headers.set("vary", "Origin");
        }
        for (const [key, value] of Object.entries({
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "x-request-id": ctx.request_id,
        }))
          if (!response.headers.has(key)) response.headers.set(key, value);
        return response;
      }
    }
    return base.fetch(request, env);
  },
};
`;

const bundled = build({
  stdin: {
    contents: routerSource,
    resolveDir: fileURLToPath(new URL(".", import.meta.url)),
    loader: "ts",
  },
  bundle: true,
  write: false,
  format: "esm",
  target: "es2023",
});

async function admissionBundleText() {
  return (await bundled).outputFiles[0]!.text;
}

export async function admissionFixture(origin = "https://api.example.invalid") {
  let subject = 100;
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: await admissionBundleText(),
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
  for (const migration of [
    "0001_identity.sql",
    "0002_machine_identity.sql",
    "0003_hosted_execution.sql",
  ]) {
    const text = await readFile(
      new URL(`../migrations/${migration}`, import.meta.url),
      "utf8",
    );
    for (const stmt of text
      .replace(/--[^\n]*/g, "")
      .split(";")
      .filter((x) => x.trim()))
      await db.prepare(stmt).run();
  }
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
      subject_id: string;
      tenant_id: string;
    };
  }
  async function enrolledWorker(account: Account, tenant = account.tenant) {
    const r = await request(
      `/v1/tenants/${tenant}/worker-enrollments`,
      { ...account.headers, "idempotency-key": crypto.randomUUID() },
      "POST",
      { name: "customer-worker" },
    );
    assert.equal(r.status, 201);
    const invite = (await r.json()) as {
      enrollment_id: string;
      enrollment_secret: string;
    };
    const reg = await request(
      "/v1/workers/register",
      {
        authorization: `Enrollment ${invite.enrollment_secret}`,
        "idempotency-key": crypto.randomUUID(),
      },
      "POST",
      {
        enrollment_id: invite.enrollment_id,
        name: "runtime-hint",
        runtime_version: "1",
        capabilities: [],
      },
    );
    assert.equal(reg.status, 201);
    return (await reg.json()) as { credential: string; worker_id: string };
  }
  async function seedPolicy(
    tenant: string,
    input: PolicyInput,
    operator?: string,
  ) {
    const { putPolicy } = await import("../src/hosted-entitlements.ts");
    const op =
      operator ??
      (await db
        .prepare(
          "SELECT user_id FROM memberships WHERE organization_id=? LIMIT 1",
        )
        .bind(tenant)
        .first<{ user_id: string }>())!.user_id;
    const ctx = {
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
    };
    return putPolicy(ctx as never, tenant, input, op);
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
  async function submitTask(
    headers: Record<string, string>,
    tenant: string,
    data: unknown,
    k = crypto.randomUUID(),
  ) {
    return request(
      `/v1/tenants/${tenant}/tasks`,
      { ...headers, "idempotency-key": k },
      "POST",
      data,
    );
  }
  return {
    mf,
    db,
    request,
    login,
    linkedDevice,
    enrolledWorker,
    seedPolicy,
    authorizeExecution,
    submitTask,
  };
}

export const admissionDefaultPolicy: PolicyInput = {
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

export function admissionSubmit(worker: string, runtime = 10000) {
  return {
    request_id: crypto.randomUUID(),
    worker_id: worker,
    execution_class: "controlled",
    runtime_ms: runtime,
    controlled_duration_ms: Math.min(100, runtime),
  };
}
