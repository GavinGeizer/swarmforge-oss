import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  convertV4MiniflareOptions,
  Miniflare,
  Response as RuntimeResponse,
} from "miniflare";
import { hash, token } from "../src/crypto.ts";
import type { PolicyInput } from "../src/hosted-entitlements.ts";

// Test-only router for the dispatch owner. Bundles ONLY the new dispatch
// production module plus the already-approved authority/entitlements/supervisor
// modules and shared code via an inline entry point, WITHOUT touching the
// lead-owned index.ts. Until lead integration, tests invoke production
// handlers through this minimal router over real D1/workerd. Temporary:
// deleted at global wiring.
const bundled = build({
  stdin: {
    contents: `
import { z } from "zod";
import { allowedOrigin, HttpError, json, type Context, type Env } from "../src/common.ts";
import { hostedAuthorityRoute } from "../src/hosted-authority.ts";
import { hostedDispatchRoute } from "../src/hosted-dispatch.ts";
import { entitlementsRoute } from "../src/hosted-entitlements.ts";
import { supervisorRoute } from "../src/hosted-supervisors.ts";
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
      route: "hosted-dispatch-test",
      actor: null,
    };
    for (const handler of [hostedDispatchRoute, supervisorRoute, hostedAuthorityRoute, entitlementsRoute]) {
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
`,
    loader: "ts",
    resolveDir: fileURLToPath(new URL(".", import.meta.url)),
  },
  bundle: true,
  write: false,
  format: "esm",
  target: "es2023",
});

async function dispatchBundleText() {
  return (await bundled).outputFiles[0]!.text;
}

export async function dispatchFixture(origin = "https://api.example.invalid") {
  let subject = 100;
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: await dispatchBundleText(),
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
  async function registerSupervisor(
    account: Account,
    workerId: string,
    name = "edge-supervisor",
    k = crypto.randomUUID(),
  ) {
    const response = await request(
      `/v1/tenants/${account.tenant}/supervisors`,
      { ...account.headers, "idempotency-key": k },
      "POST",
      { worker_id: workerId, name },
    );
    assert.equal(response.status, 201);
    return (await response.json()) as {
      credential: string;
      credential_id: string;
      supervisor_id: string;
      worker_id: string;
      subject_id: string;
      tenant_id: string;
      scopes: string[];
      expires_at: number;
      authorization_expires_at: number;
    };
  }
  // Explicit test seed of a VALID queued task + reservation + outbox row using
  // the actual DDL (NOT mocked algorithms) until the admission owner lands.
  // Mirrors the frozen schema defaults: controlled execution, active
  // reservation, queued outbox with fence 0.
  async function seedQueuedTask(
    tenant: string,
    workerId: string,
    userId: string,
    overrides: {
      runtime_ms?: number;
      controlled_duration_ms?: number;
      quantity?: string;
      withAllowance?: {
        allowed_quantity?: string;
        reserved_quantity?: string;
        consumed_quantity?: string;
      };
    } = {},
  ) {
    const now = Date.now();
    const runtime = overrides.runtime_ms ?? 10000;
    const controlled = overrides.controlled_duration_ms ?? 100;
    const taskId = crypto.randomUUID();
    const reservationId = crypto.randomUUID();
    const outboxId = crypto.randomUUID();
    const requestId = crypto.randomUUID();
    const opKey = crypto.randomUUID();
    let allowanceId: string | null = null;
    if (overrides.withAllowance) {
      const entitlement = await db
        .prepare(
          "SELECT entitlement_id FROM hosted_entitlements WHERE organization_id=? ORDER BY version DESC LIMIT 1",
        )
        .bind(tenant)
        .first<{ entitlement_id: string }>();
      assert.ok(entitlement, "seedQueuedTask withAllowance needs a policy");
      allowanceId = crypto.randomUUID();
      await db
        .prepare(
          "INSERT INTO hosted_allowances(allowance_id,organization_id,entitlement_id,resource,unit,resource_class,allowed_quantity,consumed_quantity,reserved_quantity,period_start,period_end,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          allowanceId,
          tenant,
          entitlement.entitlement_id,
          "compute_ms",
          "millisecond",
          "controlled",
          overrides.withAllowance.allowed_quantity ?? "60000",
          overrides.withAllowance.consumed_quantity ?? "0",
          overrides.withAllowance.reserved_quantity ?? "1",
          now,
          now + 86400000,
          now,
        )
        .run();
    }
    await db.batch([
      db
        .prepare(
          "INSERT INTO hosted_tasks(task_id,organization_id,worker_id,authorizing_user_id,request_id,principal_kind,principal_id,idempotency_key,fingerprint,execution_class,state,reservation_id,policy_version,runtime_ms,controlled_duration_ms,created_at,deadline_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          taskId,
          tenant,
          workerId,
          userId,
          requestId,
          "account",
          userId,
          opKey,
          await hash(requestId),
          "controlled",
          "queued",
          reservationId,
          1,
          runtime,
          controlled,
          now,
          now + 60000,
        ),
      db
        .prepare(
          "INSERT INTO hosted_reservations(reservation_id,organization_id,task_id,worker_id,allowance_id,kind,quantity,state,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          reservationId,
          tenant,
          taskId,
          workerId,
          allowanceId,
          "task_execution",
          overrides.quantity ?? "1",
          "active",
          now,
          now + 60000,
        ),
      db
        .prepare(
          "INSERT INTO hosted_outbox(outbox_id,organization_id,task_id,state,payload_json,created_at,fence,attempts) VALUES(?,?,?,?,?,?,?,?)",
        )
        .bind(
          outboxId,
          tenant,
          taskId,
          "queued",
          JSON.stringify({ task_id: taskId }),
          now,
          0,
          0,
        ),
    ]);
    return { taskId, reservationId, outboxId, allowanceId };
  }
  return {
    mf,
    db,
    request,
    login,
    linkedDevice,
    enrolledWorker,
    seedPolicy,
    registerSupervisor,
    seedQueuedTask,
  };
}

export const dispatchPolicy: PolicyInput = {
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

export function supervisorBearer(credential: string) {
  return { authorization: `Bearer ${credential}` };
}
