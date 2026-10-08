import { z } from "zod";
import type { CloudBindings } from "./bindings.ts";
import {
  decode,
  encode,
  hash,
  open,
  seal,
  sign,
  token,
  verify,
} from "./crypto.ts";
import {
  GitHubIdentityProvider,
  type IdentityProvider,
  type VerifiedIdentity,
} from "./provider.ts";
import {
  errorSchema,
  idSchema,
  membershipSchema,
  meSchema,
  organizationSchema,
  patchSchema,
  querySchema,
  sessionSchema,
} from "./schemas.ts";
export type Env = CloudBindings;
interface AccountSession {
  session_id: string;
  user_id: string;
  display_name: string;
  status: string;
  token_hash: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
}
interface Organization {
  organization_id: string;
  display_name: string;
  status: "active" | "disabled" | "deleted";
  created_at: number;
  updated_at: number;
}
interface Context {
  env: Env;
  request: Request;
  request_id: string;
  route: string;
  actor: string | null;
  session?: AccountSession;
  rawToken?: string;
}
class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const unauthenticated = () =>
  new HttpError(401, "unauthenticated", "A valid account session is required");
const notFound = () => new HttpError(404, "not_found", "Resource not found");
const ttl = 12 * 60 * 60 * 1000;
const cookieName = "__Host-swarmforge";
const browserCookie = "__Host-swarmforge-oauth";
const secretFormat = /^[A-Za-z0-9_-]{43}$/;
const keyFormat = /^[a-zA-Z0-9_.:-]{1,128}$/;
function cookie(name: string, value: string, seconds: number) {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${seconds}`;
}
function readCookie(request: Request, name: string) {
  const values = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.startsWith(`${name}=`));
  if (values.length > 1)
    throw new HttpError(400, "invalid_request", "Ambiguous cookie");
  const value = values[0]?.slice(name.length + 1);
  return value && secretFormat.test(value) ? value : null;
}
function config(env: Env, oauth = false) {
  try {
    for (const origin of [env.APP_ORIGIN, env.WEBSITE_ORIGIN]) {
      const url = new URL(origin);
      if (
        url.origin !== origin ||
        url.username ||
        url.password ||
        (url.protocol !== "https:" &&
          !(
            env.ENVIRONMENT === "local" &&
            url.protocol === "http:" &&
            ["localhost", "127.0.0.1"].includes(url.hostname)
          ))
      )
        throw new Error();
    }
    if (
      !["local", "preview"].includes(env.ENVIRONMENT) ||
      typeof env.AUTH_SECRET !== "string" ||
      env.AUTH_SECRET.length < 32 ||
      !env.DB
    )
      throw new Error();
    if (oauth && (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET))
      throw new Error();
  } catch {
    throw new HttpError(
      503,
      "temporarily_unavailable",
      "Authentication service is unavailable",
    );
  }
}
function allowedOrigin(ctx: Context) {
  const value = ctx.request.headers.get("origin");
  return value === ctx.env.APP_ORIGIN || value === ctx.env.WEBSITE_ORIGIN
    ? value
    : null;
}
function json<T>(schema: z.ZodType<T>, value: unknown, status = 200) {
  try {
    return Response.json(schema.parse(value), { status });
  } catch {
    throw new HttpError(
      503,
      "temporarily_unavailable",
      "Response data is unavailable",
    );
  }
}
function organization(row: Organization) {
  return {
    tenant_id: row.organization_id,
    display_name: row.display_name,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
async function audit(
  ctx: Context,
  action: string,
  outcome: "success" | "denied" | "failure",
  reason: string,
  org: string | null = null,
) {
  await ctx.env.DB.prepare("INSERT INTO audit_events VALUES(?,?,?,?,?,?,?,?,?)")
    .bind(
      crypto.randomUUID(),
      ctx.actor,
      org,
      action,
      ctx.route,
      outcome,
      ctx.request_id,
      Date.now(),
      JSON.stringify({ reason }),
    )
    .run();
}
async function authentication(ctx: Context) {
  const value = readCookie(ctx.request, cookieName);
  if (!value) throw unauthenticated();
  const session = await ctx.env.DB.prepare(
    "SELECT s.*,u.display_name,u.status FROM sessions s JOIN users u USING(user_id) WHERE s.token_hash=?",
  )
    .bind(await hash(value))
    .first<AccountSession>();
  if (
    !session ||
    session.revoked_at !== null ||
    session.expires_at <= Date.now()
  )
    throw unauthenticated();
  ctx.actor = session.user_id;
  if (session.status !== "active")
    throw new HttpError(403, "account_disabled", "Account is disabled");
  ctx.session = session;
  ctx.rawToken = value;
  return session;
}
async function membership(ctx: Context, id: string, privileged = false) {
  idSchema.parse(id);
  const session = ctx.session!;
  const member = await ctx.env.DB.prepare(
    "SELECT m.role FROM memberships m JOIN organizations o USING(organization_id) WHERE m.organization_id=? AND m.user_id=? AND m.status='active' AND o.status='active'",
  )
    .bind(id, session.user_id)
    .first<{ role: "owner" | "admin" | "member" }>();
  if (!member) throw notFound();
  if (privileged && member.role === "member")
    throw new HttpError(
      403,
      "forbidden",
      "Organization administrator access is required",
    );
  return member;
}
async function csrf(ctx: Context) {
  if (
    !allowedOrigin(ctx) ||
    !(await verify(
      ctx.env.AUTH_SECRET,
      `csrf:${ctx.rawToken}`,
      ctx.request.headers.get("x-csrf-token") ?? "",
    ))
  )
    throw new HttpError(
      403,
      "csrf_denied",
      "Valid origin and CSRF proof are required",
    );
}
async function body(ctx: Context) {
  if (
    !/^application\/json(?:\s*;.*)?$/i.test(
      ctx.request.headers.get("content-type") ?? "",
    )
  )
    throw new HttpError(
      400,
      "invalid_request",
      "JSON content type is required",
    );
  const declared = ctx.request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > 131072))
    throw new HttpError(413, "body_too_large", "Request body exceeds limit");
  const reader = ctx.request.body?.getReader();
  if (!reader)
    throw new HttpError(400, "invalid_request", "JSON body is required");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > 131072) {
        await reader.cancel();
        throw new HttpError(
          413,
          "body_too_large",
          "Request body exceeds limit",
        );
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    throw new HttpError(400, "invalid_request", "Valid JSON is required");
  }
}
const cursorSchema = z
  .object({
    subject: idSchema,
    scope: z.string(),
    purpose: z.string(),
    after: z.string(),
    expires: z.number().int(),
  })
  .strict();
async function page(ctx: Context, scope: string, purpose: string) {
  const input = querySchema.parse(
    Object.fromEntries(new URL(ctx.request.url).searchParams),
  );
  if (!input.cursor) return { limit: input.limit, after: "" };
  try {
    const [encoded, signature, ...rest] = input.cursor.split(".");
    if (
      !encoded ||
      !signature ||
      rest.length ||
      !(await verify(ctx.env.AUTH_SECRET, `cursor:${encoded}`, signature))
    )
      throw new Error();
    const data = cursorSchema.parse(
      JSON.parse(new TextDecoder().decode(decode(encoded))),
    );
    if (
      data.subject !== ctx.session!.user_id ||
      data.scope !== scope ||
      data.purpose !== purpose ||
      data.expires <= Date.now()
    )
      throw new Error();
    return { limit: input.limit, after: data.after };
  } catch {
    throw new HttpError(
      400,
      "invalid_cursor",
      "Cursor is invalid for this account and resource",
    );
  }
}
async function cursor(
  ctx: Context,
  scope: string,
  purpose: string,
  after: string,
) {
  const encoded = encode(
    new TextEncoder().encode(
      JSON.stringify({
        subject: ctx.session!.user_id,
        scope,
        purpose,
        after,
        expires: Date.now() + 600000,
      }),
    ),
  );
  return `${encoded}.${await sign(ctx.env.AUTH_SECRET, `cursor:${encoded}`)}`;
}
async function start(ctx: Context) {
  config(ctx.env, true);
  const state = token(),
    browser = token(),
    verifier = token();
  const now = Date.now();
  await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      "INSERT INTO oauth_transactions VALUES(?,?,?,?,?,NULL)",
    ).bind(
      await hash(state),
      await hash(browser),
      await seal(ctx.env.AUTH_SECRET, verifier),
      now,
      now + 600000,
    ),
    ctx.env.DB.prepare(
      "INSERT INTO audit_events VALUES(?,NULL,NULL,?,?,?,?,?,?)",
    ).bind(
      crypto.randomUUID(),
      "oauth.started",
      ctx.route,
      "success",
      ctx.request_id,
      now,
      "{}",
    ),
  ]);
  const url = new URL("https://github.com/login/oauth/authorize");
  url.search = new URLSearchParams({
    client_id: ctx.env.GITHUB_CLIENT_ID,
    redirect_uri: `${ctx.env.APP_ORIGIN}/v1/auth/github/callback`,
    scope: "read:user",
    state,
    code_challenge: await hash(verifier),
    code_challenge_method: "S256",
  }).toString();
  return new Response(null, {
    status: 302,
    headers: {
      location: url.toString(),
      "set-cookie": cookie(browserCookie, browser, 600),
    },
  });
}
async function callback(ctx: Context, provider: IdentityProvider) {
  config(ctx.env, true);
  const data = z
    .object({
      code: z.string().min(1).max(1024),
      state: z.string().regex(secretFormat),
    })
    .strict()
    .safeParse(Object.fromEntries(new URL(ctx.request.url).searchParams));
  const browser = readCookie(ctx.request, browserCookie);
  if (!data.success || !browser)
    throw new HttpError(400, "invalid_state", "OAuth callback is invalid");
  const transaction = await ctx.env.DB.prepare(
    "UPDATE oauth_transactions SET consumed_at=? WHERE state_hash=? AND browser_hash=? AND expires_at>? AND consumed_at IS NULL RETURNING verifier_ciphertext",
  )
    .bind(
      Date.now(),
      await hash(data.data.state),
      await hash(browser),
      Date.now(),
    )
    .first<{ verifier_ciphertext: string }>();
  if (!transaction)
    throw new HttpError(
      400,
      "invalid_state",
      "OAuth callback is invalid or expired",
    );
  let identity: VerifiedIdentity;
  try {
    identity = await provider.verify(
      data.data.code,
      await open(ctx.env.AUTH_SECRET, transaction.verifier_ciphertext),
      `${ctx.env.APP_ORIGIN}/v1/auth/github/callback`,
      {
        GITHUB_CLIENT_ID: ctx.env.GITHUB_CLIENT_ID,
        GITHUB_CLIENT_SECRET: ctx.env.GITHUB_CLIENT_SECRET,
      },
    );
    identity = z
      .object({
        subject: z.string().regex(/^[1-9][0-9]{0,19}$/),
        login: z
          .string()
          .min(1)
          .max(39)
          .regex(/^[a-zA-Z0-9-]+$/),
      })
      .strict()
      .parse(identity);
  } catch {
    throw new HttpError(
      502,
      "identity_provider_unavailable",
      "Identity provider could not verify sign-in",
    );
  }
  const now = Date.now(),
    userId = crypto.randomUUID(),
    orgId = crypto.randomUUID(),
    sessionId = crypto.randomUUID(),
    raw = token();
  const statements = [
    ctx.env.DB.prepare(
      "INSERT INTO users SELECT ?,?,'active',?,? WHERE NOT EXISTS(SELECT 1 FROM external_identities WHERE provider='github' AND subject_id=?)",
    ).bind(userId, identity.login, now, now, identity.subject),
    ctx.env.DB.prepare(
      "INSERT INTO external_identities SELECT 'github',?,?,?,1,?,? FROM users WHERE user_id=? ON CONFLICT(provider,subject_id) DO NOTHING",
    ).bind(identity.subject, userId, identity.login, now, now, userId),
    ctx.env.DB.prepare(
      "UPDATE external_identities SET login=?,updated_at=? WHERE provider='github' AND subject_id=?",
    ).bind(identity.login, now, identity.subject),
    ctx.env.DB.prepare(
      "UPDATE users SET display_name=?,updated_at=? WHERE user_id=(SELECT user_id FROM external_identities WHERE provider='github' AND subject_id=?)",
    ).bind(identity.login, now, identity.subject),
    ctx.env.DB.prepare(
      "INSERT INTO organizations SELECT ?,?,?,'active',?,? FROM users WHERE user_id=?",
    ).bind(
      orgId,
      `${identity.login} personal organization`,
      userId,
      now,
      now,
      userId,
    ),
    ctx.env.DB.prepare(
      "INSERT INTO memberships SELECT ?,?,'owner','active',?,? FROM organizations WHERE organization_id=?",
    ).bind(orgId, userId, now, now, orgId),
    ctx.env.DB.prepare(
      "INSERT INTO sessions SELECT ?,e.user_id,?,?,?,NULL,NULL FROM external_identities e JOIN users u USING(user_id) WHERE e.provider='github' AND e.subject_id=? AND u.status='active'",
    ).bind(sessionId, await hash(raw), now, now + ttl, identity.subject),
    ctx.env.DB.prepare(
      "INSERT INTO audit_events SELECT ?,user_id,NULL,'account.created',?,'success',?,?,'{}' FROM users WHERE user_id=?",
    ).bind(crypto.randomUUID(), `user:${userId}`, ctx.request_id, now, userId),
    ctx.env.DB.prepare(
      "INSERT INTO audit_events SELECT ?,personal_user_id,organization_id,'organization.created',?,'success',?,?,'{}' FROM organizations WHERE organization_id=?",
    ).bind(
      crypto.randomUUID(),
      `organization:${orgId}`,
      ctx.request_id,
      now,
      orgId,
    ),
    ctx.env.DB.prepare(
      "INSERT INTO audit_events SELECT ?,user_id,organization_id,'membership.created',?,'success',?,?,'{}' FROM memberships WHERE organization_id=? AND user_id=?",
    ).bind(
      crypto.randomUUID(),
      `membership:${orgId}/${userId}`,
      ctx.request_id,
      now,
      orgId,
      userId,
    ),
    ctx.env.DB.prepare(
      "INSERT INTO audit_events SELECT ?,user_id,NULL,'identity.linked',?,'success',?,?,'{}' FROM external_identities WHERE provider='github' AND subject_id=? AND user_id=?",
    ).bind(
      crypto.randomUUID(),
      `github:${identity.subject}`,
      ctx.request_id,
      now,
      identity.subject,
      userId,
    ),
    ctx.env.DB.prepare(
      "INSERT INTO audit_events SELECT ?,user_id,NULL,'login.success',?,'success',?,?,'{}' FROM sessions WHERE session_id=?",
    ).bind(
      crypto.randomUUID(),
      `session:${sessionId}`,
      ctx.request_id,
      now,
      sessionId,
    ),
    ctx.env.DB.prepare(
      "SELECT session_id FROM sessions WHERE session_id=?",
    ).bind(sessionId),
  ];
  const result = await ctx.env.DB.batch(statements);
  if (!result.at(-1)?.results.length)
    throw new HttpError(403, "account_disabled", "Account is disabled");
  return new Response(null, {
    status: 302,
    headers: {
      location: `${ctx.env.APP_ORIGIN}/v1/me`,
      "set-cookie": cookie(cookieName, raw, ttl / 1000),
    },
  });
}
const liveSession =
  "EXISTS(SELECT 1 FROM sessions s JOIN users u USING(user_id) WHERE s.session_id=? AND s.user_id=? AND s.revoked_at IS NULL AND s.expires_at>? AND u.status='active')";
const liveAdmin =
  "EXISTS(SELECT 1 FROM memberships m JOIN organizations o USING(organization_id) WHERE m.organization_id=? AND m.user_id=? AND m.status='active' AND o.status='active' AND m.role IN ('owner','admin'))";
async function patch(ctx: Context, tenant: string) {
  await membership(ctx, tenant, true);
  await csrf(ctx);
  const input = patchSchema.parse(await body(ctx));
  const key = ctx.request.headers.get("idempotency-key") ?? "";
  if (!keyFormat.test(key))
    throw new HttpError(400, "invalid_request", "Idempotency-Key is required");
  const row = await ctx.env.DB.prepare(
    "SELECT * FROM organizations WHERE organization_id=?",
  )
    .bind(tenant)
    .first<Organization>();
  if (!row) throw notFound();
  const now = Date.now(),
    dedup = crypto.randomUUID(),
    session = ctx.session!,
    fingerprint = await hash(JSON.stringify(input));
  const response = organizationSchema.parse(
    organization({ ...row, display_name: input.display_name, updated_at: now }),
  );
  const guard = () => [
    session.session_id,
    session.user_id,
    now,
    tenant,
    session.user_id,
  ];
  const result = await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      `INSERT INTO request_dedup SELECT ?,?,?,'organization.patch',?,?,?,?,?,? WHERE ${liveSession} AND ${liveAdmin} ON CONFLICT(organization_id,session_id,operation,idempotency_key) DO NOTHING`,
    ).bind(
      dedup,
      tenant,
      session.session_id,
      key,
      fingerprint,
      JSON.stringify(response),
      200,
      now,
      now + 86400000,
      ...guard(),
    ),
    ctx.env.DB.prepare(
      "UPDATE organizations SET display_name=?,updated_at=? WHERE organization_id=? AND EXISTS(SELECT 1 FROM request_dedup WHERE dedup_id=?)",
    ).bind(input.display_name, now, tenant, dedup),
    ctx.env.DB.prepare(
      "INSERT INTO audit_events SELECT ?,?,?, 'organization.updated',?,'success',?,?,'{}' FROM request_dedup WHERE dedup_id=?",
    ).bind(
      crypto.randomUUID(),
      session.user_id,
      tenant,
      `organization:${tenant}`,
      ctx.request_id,
      now,
      dedup,
    ),
    ctx.env.DB.prepare(
      `SELECT fingerprint,result_json,expires_at FROM request_dedup WHERE organization_id=? AND session_id=? AND operation='organization.patch' AND idempotency_key=? AND ${liveSession} AND ${liveAdmin}`,
    ).bind(tenant, session.session_id, key, ...guard()),
  ]);
  const saved = result.at(-1)?.results[0] as
    | { fingerprint: string; result_json: string; expires_at: number }
    | undefined;
  if (!saved) throw notFound();
  if (saved.fingerprint !== fingerprint || saved.expires_at <= now)
    throw new HttpError(
      409,
      "idempotency_conflict",
      "Idempotency key is already used or expired",
    );
  return json(organizationSchema, JSON.parse(saved.result_json));
}
async function revoke(ctx: Context, id: string) {
  idSchema.parse(id);
  await csrf(ctx);
  const session = ctx.session!,
    now = Date.now(),
    marker = crypto.randomUUID();
  const result = await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      `UPDATE sessions SET revoked_at=?,revocation_id=? WHERE session_id=? AND user_id=? AND revoked_at IS NULL AND ${liveSession}`,
    ).bind(
      now,
      marker,
      id,
      session.user_id,
      session.session_id,
      session.user_id,
      now,
    ),
    ctx.env.DB.prepare(
      "INSERT INTO audit_events SELECT ?,user_id,NULL,'session.revoked',?,'success',?,?,'{}' FROM sessions WHERE revocation_id=?",
    ).bind(crypto.randomUUID(), `session:${id}`, ctx.request_id, now, marker),
    ctx.env.DB.prepare(
      "SELECT session_id,revoked_at FROM sessions WHERE session_id=? AND user_id=?",
    ).bind(id, session.user_id),
  ]);
  const saved = result.at(-1)?.results[0];
  if (!saved) throw notFound();
  return json(
    z.object({ session_id: idSchema, revoked_at: z.number().int() }).strict(),
    saved,
  );
}
function routeTemplate(path: string) {
  if (
    [
      "/health",
      "/ready",
      "/v1/auth/github",
      "/v1/auth/github/callback",
      "/v1/auth/logout",
      "/v1/me",
      "/v1/me/personal-organization",
      "/v1/session",
      "/v1/sessions",
    ].includes(path)
  )
    return path;
  if (/^\/v1\/tenants\/[^/]+\/memberships$/.test(path))
    return "/v1/tenants/:tenant_id/memberships";
  if (/^\/v1\/tenants\/[^/]+$/.test(path)) return "/v1/tenants/:tenant_id";
  if (/^\/v1\/sessions\/[^/]+$/.test(path)) return "/v1/sessions/:session_id";
  return "unknown";
}
async function route(ctx: Context, provider: IdentityProvider) {
  const { request, env } = ctx;
  const method = request.method;
  const url = new URL(request.url);
  const path = url.pathname;
  const queryKeys = [...url.searchParams.keys()];
  if (new Set(queryKeys).size !== queryKeys.length)
    throw new HttpError(
      400,
      "invalid_request",
      "Duplicate query parameters are not accepted",
    );
  if (path === "/health" && method === "GET")
    return json(z.object({ status: z.literal("ok") }).strict(), {
      status: "ok",
    });
  config(env);
  if (url.origin !== env.APP_ORIGIN)
    throw new HttpError(403, "forbidden", "Invalid API origin");
  const origin = request.headers.get("origin");
  if (origin && !allowedOrigin(ctx))
    throw new HttpError(403, "forbidden", "Origin is not allowed");
  if (method === "OPTIONS") {
    const requested = request.headers.get("access-control-request-method");
    const headers = (
      request.headers.get("access-control-request-headers") ?? ""
    )
      .toLowerCase()
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    if (
      !allowedOrigin(ctx) ||
      !["GET", "POST", "PATCH", "DELETE"].includes(requested ?? "") ||
      headers.some(
        (x) => !["content-type", "x-csrf-token", "idempotency-key"].includes(x),
      )
    )
      throw new HttpError(403, "forbidden", "Preflight is not allowed");
    return new Response(null, { status: 204 });
  }
  if (path === "/ready" && method === "GET") {
    config(env, true);
    await env.DB.prepare("SELECT user_id FROM users LIMIT 1").all();
    await env.DB.prepare("SELECT dedup_id FROM request_dedup LIMIT 1").all();
    return json(z.object({ status: z.literal("ready") }).strict(), {
      status: "ready",
    });
  }
  if (path === "/v1/auth/github" && method === "GET") return start(ctx);
  if (path === "/v1/auth/github/callback" && method === "GET")
    return callback(ctx, provider);
  if (ctx.route === "unknown") throw notFound();
  const session = await authentication(ctx);
  if (path === "/v1/me" && method === "GET") {
    const paging = await page(ctx, session.user_id, "me");
    const result = await env.DB.prepare(
      "SELECT m.organization_id tenant_id,m.role FROM memberships m JOIN organizations o USING(organization_id) WHERE m.user_id=? AND m.status='active' AND o.status='active' AND m.organization_id>? ORDER BY m.organization_id LIMIT ?",
    )
      .bind(session.user_id, paging.after, paging.limit + 1)
      .all<{ tenant_id: string; role: string }>();
    const rows = result.results.slice(0, paging.limit);
    return json(meSchema, {
      subject_id: session.user_id,
      display_name: session.display_name,
      memberships: rows,
      next_cursor:
        result.results.length > paging.limit
          ? await cursor(ctx, session.user_id, "me", rows.at(-1)!.tenant_id)
          : null,
    });
  }
  if (path === "/v1/me/personal-organization" && method === "GET") {
    const row = await env.DB.prepare(
      "SELECT o.* FROM organizations o JOIN memberships m USING(organization_id) WHERE o.personal_user_id=? AND m.user_id=? AND o.status='active' AND m.status='active'",
    )
      .bind(session.user_id, session.user_id)
      .first<Organization>();
    if (!row) throw notFound();
    return json(organizationSchema, organization(row));
  }
  if (path === "/v1/session" && method === "GET")
    return json(sessionSchema.extend({ csrf_token: z.string() }).strict(), {
      session_id: session.session_id,
      created_at: session.created_at,
      expires_at: session.expires_at,
      revoked_at: session.revoked_at,
      csrf_token: await sign(env.AUTH_SECRET, `csrf:${ctx.rawToken}`),
    });
  if (path === "/v1/sessions" && method === "GET") {
    const paging = await page(ctx, session.user_id, "sessions");
    const result = await env.DB.prepare(
      "SELECT session_id,created_at,expires_at,revoked_at FROM sessions WHERE user_id=? AND session_id>? ORDER BY session_id LIMIT ?",
    )
      .bind(session.user_id, paging.after, paging.limit + 1)
      .all<{ session_id: string }>();
    const rows = result.results.slice(0, paging.limit);
    return json(
      z
        .object({
          items: z.array(sessionSchema),
          next_cursor: z.string().nullable(),
        })
        .strict(),
      {
        items: rows,
        next_cursor:
          result.results.length > paging.limit
            ? await cursor(
                ctx,
                session.user_id,
                "sessions",
                rows.at(-1)!.session_id,
              )
            : null,
      },
    );
  }
  if (path === "/v1/auth/logout" && method === "POST") {
    const response = await revoke(ctx, session.session_id);
    response.headers.set("set-cookie", cookie(cookieName, "", 0));
    return response;
  }
  const sessionMatch = path.match(/^\/v1\/sessions\/([^/]+)$/);
  if (sessionMatch && method === "DELETE") return revoke(ctx, sessionMatch[1]!);
  const match = path.match(/^\/v1\/tenants\/([^/]+)(\/memberships)?$/);
  if (match) {
    const tenant = match[1]!;
    await membership(ctx, tenant, Boolean(match[2]));
    if (!match[2] && method === "GET") {
      const row = await env.DB.prepare(
        "SELECT * FROM organizations WHERE organization_id=?",
      )
        .bind(tenant)
        .first<Organization>();
      if (!row) throw notFound();
      return json(organizationSchema, organization(row));
    }
    if (!match[2] && method === "PATCH") return patch(ctx, tenant);
    if (match[2] && method === "GET") {
      const paging = await page(ctx, tenant, "memberships");
      const result = await env.DB.prepare(
        "SELECT m.user_id subject_id,u.display_name,m.role FROM memberships m JOIN users u USING(user_id) WHERE m.organization_id=? AND m.status='active' AND u.status='active' AND m.user_id>? ORDER BY m.user_id LIMIT ?",
      )
        .bind(tenant, paging.after, paging.limit + 1)
        .all<{ subject_id: string }>();
      const rows = result.results.slice(0, paging.limit);
      return json(
        z
          .object({
            items: z.array(membershipSchema),
            next_cursor: z.string().nullable(),
          })
          .strict(),
        {
          items: rows,
          next_cursor:
            result.results.length > paging.limit
              ? await cursor(
                  ctx,
                  tenant,
                  "memberships",
                  rows.at(-1)!.subject_id,
                )
              : null,
        },
      );
    }
  }
  throw new HttpError(405, "method_not_allowed", "Method is not supported");
}
export function createWorker(
  options: {
    provider?: IdentityProvider;
    log?: (value: Record<string, unknown>) => void;
  } = {},
) {
  const provider = options.provider ?? new GitHubIdentityProvider();
  const logger =
    options.log ??
    ((data: Record<string, unknown>) => console.log(JSON.stringify(data)));
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const ctx: Context = {
        request,
        env,
        request_id: crypto.randomUUID(),
        route: routeTemplate(new URL(request.url).pathname),
        actor: null,
      };
      let response: Response;
      try {
        response = await route(ctx, provider);
      } catch (error) {
        let failure =
          error instanceof HttpError
            ? error
            : error instanceof z.ZodError
              ? new HttpError(400, "invalid_request", "Request is invalid")
              : new HttpError(
                  503,
                  "temporarily_unavailable",
                  "Service is temporarily unavailable",
                );
        try {
          if (env.DB)
            await audit(
              ctx,
              ctx.route === "/v1/auth/github/callback"
                ? "login.failure"
                : "request.denied",
              failure.status >= 500 ? "failure" : "denied",
              failure.code,
            );
        } catch {
          failure = new HttpError(
            503,
            "temporarily_unavailable",
            "Service is temporarily unavailable",
          );
        }
        response = json(
          errorSchema,
          {
            error: {
              code: failure.code,
              message: failure.message,
              request_id: ctx.request_id,
            },
          },
          failure.status,
        );
      }
      const origin = allowedOrigin(ctx);
      if (origin) {
        response.headers.set("access-control-allow-origin", origin);
        response.headers.set("access-control-allow-credentials", "true");
        response.headers.set("vary", "Origin");
        if (request.method === "OPTIONS") {
          response.headers.set(
            "access-control-allow-methods",
            "GET, POST, PATCH, DELETE",
          );
          response.headers.set(
            "access-control-allow-headers",
            "Content-Type, X-CSRF-Token, Idempotency-Key",
          );
        }
      }
      for (const [key, value] of Object.entries({
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "x-frame-options": "DENY",
        "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
        "x-request-id": ctx.request_id,
      }))
        response.headers.set(key, value);
      if (new URL(request.url).protocol === "https:")
        response.headers.set("strict-transport-security", "max-age=31536000");
      logger({
        request_id: ctx.request_id,
        route: ctx.route,
        method: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"].includes(
          request.method,
        )
          ? request.method
          : "other",
        status: response.status,
      });
      return response;
    },
  };
}
export default createWorker();
