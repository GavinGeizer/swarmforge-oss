import { z } from "zod";
import type { CloudBindings } from "./bindings.ts";
import { decode, encode, hash, sign, verify } from "./crypto.ts";
import { idSchema, querySchema } from "./schemas.ts";
export type Env = CloudBindings;
export interface AccountSession {
  session_id: string;
  user_id: string;
  display_name: string;
  status: string;
  token_hash: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
}
export interface Organization {
  organization_id: string;
  display_name: string;
  status: "active" | "disabled" | "deleted";
  created_at: number;
  updated_at: number;
}
export interface Context {
  env: Env;
  request: Request;
  request_id: string;
  route: string;
  actor: string | null;
  session?: AccountSession;
  rawToken?: string;
}
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly auditReason: string;
  constructor(
    status: number,
    code: string,
    message: string,
    auditReason = code,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.auditReason = auditReason;
  }
}
export const unauthenticated = () =>
  new HttpError(401, "unauthenticated", "A valid account session is required");
export const notFound = () =>
  new HttpError(404, "not_found", "Resource not found");
export const cookieName = "__Host-swarmforge";
export const browserCookie = "__Host-swarmforge-oauth";
export const secretFormat = /^[A-Za-z0-9_-]{43}$/;
export const keyFormat = /^[a-zA-Z0-9_.:-]{1,128}$/;
export function cookie(name: string, value: string, seconds: number) {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${seconds}`;
}
export function readCookie(request: Request, name: string) {
  const values = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.startsWith(`${name}=`));
  if (values.length > 1)
    throw new HttpError(400, "invalid_request", "Ambiguous cookie");
  const value = values[0]?.slice(name.length + 1);
  return value && secretFormat.test(value) ? value : null;
}
export function config(env: Env, oauth = false) {
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
export function allowedOrigin(ctx: Context) {
  const value = ctx.request.headers.get("origin");
  return value === ctx.env.APP_ORIGIN || value === ctx.env.WEBSITE_ORIGIN
    ? value
    : null;
}
export function json<T>(schema: z.ZodType<T>, value: unknown, status = 200) {
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
export function organization(row: Organization) {
  return {
    tenant_id: row.organization_id,
    display_name: row.display_name,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
export async function audit(
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
export async function authentication(ctx: Context) {
  if (ctx.request.headers.has("authorization")) throw unauthenticated();
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
export async function membership(ctx: Context, id: string, privileged = false) {
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
export async function csrf(ctx: Context) {
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
export async function body(ctx: Context) {
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
export const cursorSchema = z
  .object({
    subject: idSchema,
    scope: z.string(),
    purpose: z.string(),
    after: z.string(),
    expires: z.number().int(),
  })
  .strict();
export async function page(ctx: Context, scope: string, purpose: string) {
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
      data.subject !== ctx.actor! ||
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
export async function cursor(
  ctx: Context,
  scope: string,
  purpose: string,
  after: string,
) {
  const encoded = encode(
    new TextEncoder().encode(
      JSON.stringify({
        subject: ctx.actor!,
        scope,
        purpose,
        after,
        expires: Date.now() + 600000,
      }),
    ),
  );
  return `${encoded}.${await sign(ctx.env.AUTH_SECRET, `cursor:${encoded}`)}`;
}
