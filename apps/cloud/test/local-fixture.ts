import assert from "node:assert/strict";
import { z } from "zod";
import { type Context, type Env, HttpError } from "../src/common.ts";
import { token } from "../src/crypto.ts";
import { createWorker } from "../src/index.ts";
import type { IdentityProvider } from "../src/provider.ts";
import { LocalD1 } from "./local-d1.ts";
import { applyMigrations, type FixtureSchema } from "./migrations.ts";

export type LocalHandler = (ctx: Context) => Promise<Response | null>;

// In-process production Worker + SQLite integration. Synthetic GitHub provider;
// no TCP, no Cloudflare edge or workerd, no live provider validation implied.
// Supplemental handler adapters are provisional until global routing lands.
export async function localFixture(
  options: { handlers?: LocalHandler[]; schema?: FixtureSchema } = {},
) {
  const origin = "https://api.example.invalid";
  const db = new LocalD1();
  await applyMigrations(db, options.schema ?? "phase2b2");
  let subject = 100;
  const provider: IdentityProvider = {
    async verify() {
      return { subject: String(subject), login: `user${subject}` };
    },
  };
  const env = {
    DB: db as unknown as Env["DB"],
    APP_ORIGIN: origin,
    WEBSITE_ORIGIN: origin,
    ENVIRONMENT: "local",
    AUTH_SECRET: "synthetic-auth-secret-with-more-than-32-characters",
    GITHUB_CLIENT_ID: "synthetic-client",
    GITHUB_CLIENT_SECRET: "synthetic-provider-secret",
  } as Env;
  const logs: Record<string, unknown>[] = [];
  const worker = createWorker({ provider, log: (entry) => logs.push(entry) });
  function context(
    path: string,
    headers: Record<string, string> = {},
    method = "GET",
    data?: unknown,
  ): Context {
    return {
      env,
      request: new Request(origin + path, {
        method,
        headers: {
          ...(data === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      }),
      request_id: crypto.randomUUID(),
      route: "local-sql-integration",
      actor: null,
    };
  }
  async function request(
    path: string,
    headers: Record<string, string> = {},
    method = "GET",
    data?: unknown,
  ): Promise<Response> {
    const ctx = context(path, headers, method, data);
    try {
      for (const handler of options.handlers ?? []) {
        const response = await handler(ctx);
        if (response) return response;
      }
      return await worker.fetch(ctx.request, env);
    } catch (error) {
      const failure =
        error instanceof HttpError
          ? error
          : error instanceof z.ZodError
            ? new HttpError(400, "invalid_request", "Request is invalid")
            : new HttpError(
                503,
                "temporarily_unavailable",
                "Service unavailable",
              );
      return Response.json(
        {
          error: {
            code: failure.code,
            message: failure.message,
            request_id: ctx.request_id,
          },
        },
        { status: failure.status },
      );
    }
  }
  async function login(id = 100) {
    subject = id;
    const started = await request("/v1/auth/github");
    assert.equal(started.status, 302);
    const state = new URL(started.headers.get("location")!).searchParams.get(
      "state",
    );
    const callback = await request(
      `/v1/auth/github/callback?code=synthetic-code&state=${state}`,
      { cookie: started.headers.get("set-cookie")!.split(";")[0]! },
    );
    assert.equal(callback.status, 302);
    const cookie = callback.headers.get("set-cookie")!.split(";")[0]!;
    const me = (await (await request("/v1/me", { cookie })).json()) as {
      subject_id: string;
      memberships: { tenant_id: string }[];
    };
    const session = (await (
      await request("/v1/session", { cookie })
    ).json()) as {
      session_id: string;
      csrf_token: string;
    };
    return {
      user: me.subject_id,
      tenant: me.memberships[0]!.tenant_id,
      sessionId: session.session_id,
      headers: { cookie, origin, "x-csrf-token": session.csrf_token },
    };
  }
  type Account = Awaited<ReturnType<typeof login>>;
  async function linked(account: Account) {
    const raw = token();
    const link = await request(
      "/v1/cli-links",
      {
        authorization: `LinkInitiator ${raw}`,
        "idempotency-key": crypto.randomUUID(),
      },
      "POST",
      {
        client_name: "local-sql-fixture",
        requested_scopes: ["identity:read", "devices:self"],
        tenant_id: account.tenant,
      },
    );
    assert.equal(link.status, 201);
    const value = (await link.json()) as { link_id: string; user_code: string };
    const approved = await request(
      `/v1/cli-links/${value.link_id}/approve`,
      {
        ...account.headers,
        "idempotency-key": crypto.randomUUID(),
      },
      "POST",
      { user_code: value.user_code, tenant_id: account.tenant },
    );
    assert.equal(approved.status, 200);
    const exchanged = await request(
      `/v1/cli-links/${value.link_id}/exchange`,
      {
        authorization: `LinkInitiator ${raw}`,
        "idempotency-key": crypto.randomUUID(),
      },
      "POST",
      {},
    );
    assert.equal(exchanged.status, 200);
    return (await exchanged.json()) as {
      credential: string;
      credential_id: string;
      installation_id: string;
      subject_id: string;
      tenant_id: string;
    };
  }
  async function enrolledWorker(account: Account) {
    const invite = await request(
      `/v1/tenants/${account.tenant}/worker-enrollments`,
      {
        ...account.headers,
        "idempotency-key": crypto.randomUUID(),
      },
      "POST",
      { name: "local-sql-worker" },
    );
    assert.equal(invite.status, 201);
    const enrollment = (await invite.json()) as {
      enrollment_id: string;
      enrollment_secret: string;
    };
    const registered = await request(
      "/v1/workers/register",
      {
        authorization: `Enrollment ${enrollment.enrollment_secret}`,
        "idempotency-key": crypto.randomUUID(),
      },
      "POST",
      {
        enrollment_id: enrollment.enrollment_id,
        name: "local-sql-worker",
        runtime_version: "1",
        capabilities: [],
      },
    );
    assert.equal(registered.status, 201);
    return (await registered.json()) as {
      credential: string;
      worker_id: string;
    };
  }
  async function registerSupervisor(account: Account, workerId: string) {
    const response = await request(
      `/v1/tenants/${account.tenant}/supervisors`,
      {
        ...account.headers,
        "idempotency-key": crypto.randomUUID(),
      },
      "POST",
      { worker_id: workerId, name: "local-sql-supervisor" },
    );
    assert.equal(response.status, 201);
    return (await response.json()) as {
      credential: string;
      credential_id: string;
      supervisor_id: string;
      worker_id: string;
      tenant_id: string;
      subject_id: string;
      expires_at: number;
      authorization_expires_at: number;
      scopes: string[];
    };
  }
  async function seedPolicy(tenant: string, input: unknown, operator?: string) {
    // Dynamic import keeps baseline identity-only fixtures usable before the
    // reviewed hosted policy implementation is integrated.
    const { putPolicy } = await import("../src/hosted-entitlements.ts");
    const user =
      operator ??
      (await db
        .prepare(
          "SELECT user_id FROM memberships WHERE organization_id=? ORDER BY user_id LIMIT 1",
        )
        .bind(tenant)
        .first<{ user_id: string }>())!.user_id;
    return putPolicy(
      context("/"),
      tenant,
      input as Parameters<typeof putPolicy>[2],
      user,
    );
  }
  return {
    db,
    env,
    context,
    request,
    fetch: (request: Request) => worker.fetch(request, env),
    scheduled: () => worker.scheduled({} as ScheduledController, env),
    logs,
    login,
    linked,
    enrolledWorker,
    registerSupervisor,
    seedPolicy,
    close: () => db.close(),
  };
}
