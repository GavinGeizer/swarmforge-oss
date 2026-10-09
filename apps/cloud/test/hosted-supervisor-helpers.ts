import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  convertV4MiniflareOptions,
  Miniflare,
  Response as RuntimeResponse,
} from "miniflare";
import { hash, sign, token } from "../src/crypto.ts";

// Test-only Miniflare adapter for the supervisor identity owner. The lead
// wires supervisorRoute into the global worker later; until then tests invoke
// the PRODUCTION supervisorRoute handler in real local Miniflare/workerd/D1
// through this minimal adapter. The error envelope mirrors src/index.ts.
const bundled = build({
  stdin: {
    contents: `
import { z } from "zod";
import { HttpError, json, type Context, type Env } from "../src/common.ts";
import { supervisorRoute } from "../src/hosted-supervisors.ts";
import { errorSchema } from "../src/schemas.ts";
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const ctx: Context = {
      request,
      env,
      request_id: crypto.randomUUID(),
      route: "supervisor-test",
      actor: null,
    };
    try {
      const response = await supervisorRoute(ctx);
      if (response) return response;
      throw new HttpError(404, "not_found", "Resource not found");
    } catch (error) {
      const failure =
        error instanceof HttpError
          ? error
          : error instanceof z.ZodError
            ? new HttpError(400, "invalid_request", "Request is invalid")
            : new HttpError(503, "temporarily_unavailable", "Service is temporarily unavailable");
      return json(
        errorSchema,
        { error: { code: failure.code, message: failure.message, request_id: ctx.request_id } },
        failure.status,
      );
    }
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

const AUTH_SECRET = "test-auth-secret-with-at-least-thirty-two-characters";

export async function supervisorFixture(
  origin = "https://api.example.invalid",
) {
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
        AUTH_SECRET,
      },
      outboundService: async (request) =>
        new RuntimeResponse(JSON.stringify({ unexpected: request.url }), {
          headers: { "content-type": "application/json" },
        }),
    }),
  );
  const db = await mf.getD1Database("DB");
  for (const migration of [
    "0001_identity.sql",
    "0002_machine_identity.sql",
    "0003_hosted_execution.sql",
  ]) {
    const sql = await readFile(
      new URL(`../migrations/${migration}`, import.meta.url),
      "utf8",
    );
    for (const stmt of sql
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
  // Seeds a real browser identity: user + tenant + owner membership + live
  // session, returning cookie/origin/CSRF headers that pass authentication().
  async function seedBrowser(
    id = 100,
    role: "owner" | "admin" | "member" = "owner",
  ) {
    const userId = crypto.randomUUID(),
      tenantId = crypto.randomUUID(),
      sessionId = crypto.randomUUID(),
      raw = token(),
      now = Date.now();
    await db.batch([
      db
        .prepare(
          "INSERT INTO users(user_id,display_name,status,created_at,updated_at) VALUES(?,?,?,?,?)",
        )
        .bind(userId, `user${id}`, "active", now, now),
      db
        .prepare(
          "INSERT INTO organizations(organization_id,display_name,personal_user_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?)",
        )
        .bind(tenantId, `org${id}`, null, "active", now, now),
      db
        .prepare(
          "INSERT INTO memberships(organization_id,user_id,role,status,created_at,updated_at) VALUES(?,?,?,?,?,?)",
        )
        .bind(tenantId, userId, role, "active", now, now),
      db
        .prepare(
          "INSERT INTO sessions(session_id,user_id,token_hash,created_at,expires_at,revoked_at,revocation_id) VALUES(?,?,?,?,?,?,?)",
        )
        .bind(
          sessionId,
          userId,
          await hash(raw),
          now,
          now + 43200000,
          null,
          null,
        ),
    ]);
    const headers = {
      cookie: `__Host-swarmforge=${raw}`,
      origin,
      "x-csrf-token": await sign(AUTH_SECRET, `csrf:${raw}`),
    };
    return { user: userId, tenant: tenantId, session: sessionId, headers };
  }
  // Seeds an enrolled tenant worker with a wide authorization window.
  async function seedWorker(
    tenant: string,
    user: string,
    session: string,
    name = "customer-worker",
  ) {
    const enrollmentId = crypto.randomUUID(),
      workerId = crypto.randomUUID(),
      now = Date.now();
    await db.batch([
      db
        .prepare(
          "INSERT INTO worker_enrollments(enrollment_id,organization_id,authorizing_user_id,session_id,name,secret_hash,idempotency_key,fingerprint,result_ciphertext,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          enrollmentId,
          tenant,
          user,
          session,
          name,
          await hash(`sfenroll_${token()}`),
          crypto.randomUUID(),
          "fp",
          "ct",
          now,
          now + 600000,
        ),
      db
        .prepare(
          "INSERT INTO cloud_workers(worker_id,organization_id,authorizing_user_id,enrollment_id,name,status,epoch,created_at,authorization_expires_at,revoked_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(
          workerId,
          tenant,
          user,
          enrollmentId,
          name,
          "registered",
          1,
          now,
          now + 30 * 86400000,
          null,
        ),
    ]);
    return workerId;
  }
  return { mf, db, request, seedBrowser, seedWorker };
}

export interface SupervisorCredential {
  credential: string;
  credential_id: string;
  supervisor_id: string;
  worker_id: string;
  subject_id: string;
  tenant_id: string;
  scopes: string[];
  expires_at: number;
  authorization_expires_at: number;
}

export function supervisorBearer(c: SupervisorCredential) {
  return { authorization: `Bearer ${c.credential}` };
}

export async function registerSupervisor(
  h: Awaited<ReturnType<typeof supervisorFixture>>,
  browser: { user: string; tenant: string; headers: Record<string, string> },
  workerId: string,
  name = "edge-supervisor",
  idempotencyKey = crypto.randomUUID(),
) {
  const response = await h.request(
    `/v1/tenants/${browser.tenant}/supervisors`,
    { ...browser.headers, "idempotency-key": idempotencyKey },
    "POST",
    { worker_id: workerId, name },
  );
  return response;
}
