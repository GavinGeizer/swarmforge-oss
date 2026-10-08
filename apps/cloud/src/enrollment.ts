import { z } from "zod";
import {
  authentication,
  body,
  type Context,
  csrf,
  cursor,
  HttpError,
  json,
  membership,
  notFound,
  page,
} from "./common.ts";
import { hash, open, seal, token } from "./crypto.ts";
import {
  auditStatement,
  browserGuard,
  credentialInsert,
  credentialReply,
  grantTtl,
  issueCredential,
  key,
  machineAuth,
  nameSchema,
  workerSchema,
} from "./machines.ts";
import { idSchema } from "./schemas.ts";

const invitationReply = z
  .object({
    enrollment_id: idSchema,
    enrollment_secret: z.string().regex(/^sfenroll_[A-Za-z0-9_-]{43}$/),
    expires_at: z.number().int(),
  })
  .strict();
const registrationReply = credentialReply
  .extend({ worker: workerSchema })
  .strict();
interface Enrollment {
  enrollment_id: string;
  organization_id: string;
  authorizing_user_id: string;
  session_id: string;
  name: string;
  secret_hash: string;
  idempotency_key: string;
  fingerprint: string;
  result_ciphertext: string;
  expires_at: number;
  consumed_at: number | null;
  revoked_at: number | null;
  exchange_key: string | null;
  exchange_fingerprint: string | null;
  exchange_ciphertext: string | null;
}
async function createInvitation(ctx: Context, tenant: string) {
  const input = z
      .object({ name: nameSchema })
      .strict()
      .parse(await body(ctx)),
    k = key(ctx),
    now = Date.now(),
    id = crypto.randomUUID(),
    secret = `sfenroll_${token()}`,
    fp = await hash(JSON.stringify(input)),
    s = ctx.session!,
    guard = browserGuard(ctx, tenant, true);
  const reply = invitationReply.parse({
    enrollment_id: id,
    enrollment_secret: secret,
    expires_at: now + 600000,
  });
  const results = await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      `INSERT INTO worker_enrollments(enrollment_id,organization_id,authorizing_user_id,session_id,name,secret_hash,idempotency_key,fingerprint,result_ciphertext,created_at,expires_at) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE ${guard.sql} AND (SELECT count(*) FROM worker_enrollments WHERE organization_id=? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>?)<25 ON CONFLICT(organization_id,session_id,idempotency_key) DO NOTHING`,
    ).bind(
      id,
      tenant,
      s.user_id,
      s.session_id,
      input.name,
      await hash(secret),
      k,
      fp,
      await seal(ctx.env.AUTH_SECRET, JSON.stringify(reply)),
      now,
      now + 600000,
      ...guard.args,
      tenant,
      now,
    ),
    auditStatement(
      ctx,
      "worker.enrollment_created",
      `enrollment:${id}`,
      tenant,
      s.user_id,
      "FROM worker_enrollments WHERE enrollment_id=?",
      [id],
    ),
    ctx.env.DB.prepare(
      `SELECT * FROM worker_enrollments WHERE organization_id=? AND session_id=? AND idempotency_key=? AND ${guard.sql}`,
    ).bind(tenant, s.session_id, k, ...guard.args),
  ]);
  const saved = results.at(-1)?.results[0] as unknown as Enrollment | undefined;
  if (!saved)
    throw new HttpError(
      409,
      "enrollment_limit",
      "Enrollment cannot be created with current authority or limits",
    );
  if (saved.fingerprint !== fp)
    throw new HttpError(
      409,
      "idempotency_conflict",
      "Idempotency key is already in use",
    );
  if (
    saved.revoked_at !== null ||
    saved.consumed_at !== null ||
    saved.expires_at <= Date.now()
  )
    throw new HttpError(
      410,
      "enrollment_expired",
      "Enrollment is no longer available",
    );
  return json(
    invitationReply,
    JSON.parse(await open(ctx.env.AUTH_SECRET, saved.result_ciphertext)),
    201,
  );
}
async function register(ctx: Context) {
  const input = z
      .object({
        enrollment_id: idSchema,
        name: nameSchema,
        runtime_version: z.string().min(1).max(64),
        capabilities: z.array(z.string().min(1).max(64)).max(20),
      })
      .strict()
      .parse(await body(ctx)),
    k = key(ctx),
    now = Date.now();
  const auth = ctx.request.headers.get("authorization") ?? "";
  if (!/^Enrollment sfenroll_[A-Za-z0-9_-]{43}$/.test(auth))
    throw new HttpError(
      401,
      "unauthenticated",
      "A valid enrollment credential is required",
    );
  const e = await ctx.env.DB.prepare(
    "SELECT * FROM worker_enrollments WHERE enrollment_id=? AND secret_hash=?",
  )
    .bind(input.enrollment_id, await hash(auth.slice(11)))
    .first<Enrollment>();
  if (!e) throw notFound();
  if (e.revoked_at !== null || e.expires_at <= now)
    throw new HttpError(
      410,
      "enrollment_expired",
      "Enrollment has expired or been revoked",
    );
  const fp = await hash(JSON.stringify(input));
  if (
    e.consumed_at !== null &&
    (e.exchange_key !== k || e.exchange_fingerprint !== fp)
  )
    throw new HttpError(
      409,
      "enrollment_consumed",
      "Enrollment has already been consumed",
    );
  const id = crypto.randomUUID(),
    issued = await issueCredential(
      ctx,
      "worker",
      id,
      e.authorizing_user_id,
      e.organization_id,
      1,
      now + grantTtl,
    );
  const reply = registrationReply.parse({
      ...issued.reply,
      worker: {
        worker_id: id,
        tenant_id: e.organization_id,
        name: e.name,
        state: "registered",
        registration_epoch: 1,
        created_at: now,
        revoked_at: null,
      },
    }),
    cipher = await seal(ctx.env.AUTH_SECRET, JSON.stringify(reply));
  const authority =
    "EXISTS(SELECT 1 FROM users u JOIN memberships m USING(user_id) JOIN organizations o USING(organization_id) JOIN sessions s ON s.user_id=u.user_id WHERE u.user_id=worker_enrollments.authorizing_user_id AND s.session_id=worker_enrollments.session_id AND s.revoked_at IS NULL AND s.expires_at>? AND m.organization_id=worker_enrollments.organization_id AND m.status='active' AND m.role IN ('owner','admin') AND u.status='active' AND o.status='active')";
  const result = await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      `UPDATE worker_enrollments SET consumed_at=?,exchange_key=?,exchange_fingerprint=?,exchange_ciphertext=? WHERE enrollment_id=? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>? AND ${authority} AND (SELECT count(*) FROM cloud_workers WHERE organization_id=worker_enrollments.organization_id AND status='registered')<100`,
    ).bind(now, k, fp, cipher, e.enrollment_id, now, now),
    ctx.env.DB.prepare(
      "INSERT INTO cloud_workers SELECT ?,organization_id,authorizing_user_id,enrollment_id,name,'registered',1,?,?,NULL FROM worker_enrollments WHERE enrollment_id=? AND exchange_ciphertext=?",
    ).bind(
      id,
      now,
      issued.reply.authorization_expires_at,
      e.enrollment_id,
      cipher,
    ),
    credentialInsert(
      ctx,
      issued,
      "EXISTS(SELECT 1 FROM cloud_workers WHERE worker_id=?)",
      [id],
    ),
    auditStatement(
      ctx,
      "worker.enrolled",
      `worker:${id}`,
      e.organization_id,
      e.authorizing_user_id,
      "FROM cloud_workers WHERE worker_id=?",
      [id],
    ),
    ctx.env.DB.prepare(
      "SELECT exchange_key,exchange_fingerprint,exchange_ciphertext FROM worker_enrollments WHERE enrollment_id=? AND consumed_at IS NOT NULL AND revoked_at IS NULL AND expires_at>?",
    ).bind(e.enrollment_id, now),
  ]);
  const saved = result.at(-1)?.results[0] as
    | {
        exchange_key: string;
        exchange_fingerprint: string;
        exchange_ciphertext: string;
      }
    | undefined;
  if (!saved)
    throw new HttpError(
      403,
      "authorization_changed",
      "Enrollment authority changed or worker limit was reached",
    );
  if (saved.exchange_key !== k || saved.exchange_fingerprint !== fp)
    throw new HttpError(
      409,
      "enrollment_consumed",
      "Enrollment has already been consumed",
    );
  const value = registrationReply.parse(
    JSON.parse(await open(ctx.env.AUTH_SECRET, saved.exchange_ciphertext)),
  );
  await machineAuth(
    {
      ...ctx,
      request: new Request(ctx.request.url, {
        headers: { authorization: `Bearer ${value.credential}` },
      }),
    },
    "worker-identity",
  );
  return json(registrationReply, value, 201);
}
export async function enrollmentRoute(ctx: Context) {
  const path = new URL(ctx.request.url).pathname,
    method = ctx.request.method;
  if (path === "/v1/workers/register" && method === "POST")
    return register(ctx);
  const match = path.match(
    /^\/v1\/tenants\/([^/]+)\/(worker-enrollments|workers|cli-installations)(?:\/([^/]+))?$/,
  );
  if (!match) return null;
  const tenant = idSchema.parse(match[1]),
    type = match[2]!,
    id = match[3] ? idSchema.parse(match[3]) : null;
  await authentication(ctx);
  const mem = await membership(ctx, tenant, type !== "cli-installations");
  const s = ctx.session!,
    now = Date.now();
  if (type === "worker-enrollments" && !id && method === "POST") {
    await csrf(ctx);
    return createInvitation(ctx, tenant);
  }
  if (type === "worker-enrollments" && id && method === "DELETE") {
    await csrf(ctx);
    const guard = browserGuard(ctx, tenant, true);
    const result = await ctx.env.DB.batch([
      ctx.env.DB.prepare(
        `UPDATE worker_enrollments SET revoked_at=COALESCE(revoked_at,?) WHERE enrollment_id=? AND organization_id=? AND ${guard.sql}`,
      ).bind(now, id, tenant, ...guard.args),
      auditStatement(
        ctx,
        "worker.enrollment_revoked",
        `enrollment:${id}`,
        tenant,
        s.user_id,
        "FROM worker_enrollments WHERE enrollment_id=? AND organization_id=? AND revoked_at IS NOT NULL",
        [id, tenant],
        `${id}:revoked`,
      ),
      ctx.env.DB.prepare(
        `SELECT enrollment_id,revoked_at FROM worker_enrollments WHERE enrollment_id=? AND organization_id=? AND revoked_at IS NOT NULL AND ${guard.sql}`,
      ).bind(id, tenant, ...guard.args),
    ]);
    if (!result.at(-1)?.results.length) throw notFound();
    return json(
      z
        .object({ enrollment_id: idSchema, revoked_at: z.number().int() })
        .strict(),
      result.at(-1)!.results[0],
    );
  }
  const cli = type === "cli-installations",
    table = cli ? "cli_installations" : "cloud_workers",
    column = cli ? "installation_id" : "worker_id";
  if ((cli || type === "workers") && !id && method === "GET") {
    const p = await page(ctx, tenant, type);
    const query = cli
      ? `SELECT installation_id,organization_id tenant_id,user_id subject_id,client_name,status,created_at,last_seen_at,authorization_expires_at,revoked_at FROM cli_installations WHERE organization_id=? ${mem.role === "member" ? "AND user_id=?" : ""} AND installation_id>? ORDER BY installation_id LIMIT ?`
      : `SELECT worker_id,organization_id tenant_id,name,status state,epoch registration_epoch,created_at,revoked_at FROM cloud_workers WHERE organization_id=? AND worker_id>? ORDER BY worker_id LIMIT ?`;
    const rows = await ctx.env.DB.prepare(query)
      .bind(
        tenant,
        ...(cli && mem.role === "member" ? [s.user_id] : []),
        p.after,
        p.limit + 1,
      )
      .all<Record<string, unknown>>();
    const items = rows.results.slice(0, p.limit);
    const installation = z
      .object({
        installation_id: idSchema,
        tenant_id: idSchema,
        subject_id: idSchema,
        client_name: nameSchema,
        status: z.enum(["active", "revoked"]),
        created_at: z.number().int(),
        last_seen_at: z.number().int().nullable(),
        authorization_expires_at: z.number().int(),
        revoked_at: z.number().int().nullable(),
      })
      .strict();
    return json(
      z
        .object({
          items: z.array(cli ? installation : workerSchema),
          next_cursor: z.string().nullable(),
        })
        .strict(),
      {
        items,
        next_cursor:
          rows.results.length > p.limit
            ? await cursor(ctx, tenant, type, String(items.at(-1)![column]))
            : null,
      },
    );
  }
  if ((cli || type === "workers") && id && method === "DELETE") {
    await csrf(ctx);
    const guard = browserGuard(ctx, tenant, !cli || mem.role !== "member");
    const owner = cli && mem.role === "member" ? "AND user_id=?" : "";
    const args = [id, tenant, ...(owner ? [s.user_id] : [])];
    const result = await ctx.env.DB.batch([
      ctx.env.DB.prepare(
        `UPDATE ${table} SET status='revoked',revoked_at=COALESCE(revoked_at,?),epoch=epoch+CASE WHEN status='revoked' THEN 0 ELSE 1 END WHERE ${column}=? AND organization_id=? ${owner} AND ${guard.sql}`,
      ).bind(now, ...args, ...guard.args),
      ctx.env.DB.prepare(
        `UPDATE machine_credentials SET revoked_at=COALESCE(revoked_at,?) WHERE ${column}=? AND EXISTS(SELECT 1 FROM ${table} WHERE ${column}=? AND organization_id=? ${owner} AND status='revoked' AND ${guard.sql})`,
      ).bind(now, id, ...args, ...guard.args),
      auditStatement(
        ctx,
        cli ? "cli.revoked" : "worker.revoked",
        `${column}:${id}`,
        tenant,
        s.user_id,
        `FROM ${table} WHERE ${column}=? AND organization_id=? ${owner} AND status='revoked' AND ${guard.sql}`,
        [...args, ...guard.args],
        `${id}:revoked`,
      ),
      ctx.env.DB.prepare(
        `SELECT ${column},revoked_at FROM ${table} WHERE ${column}=? AND organization_id=? ${owner} AND status='revoked' AND ${guard.sql}`,
      ).bind(...args, ...guard.args),
    ]);
    if (!result.at(-1)?.results.length) throw notFound();
    return json(
      z.object({ [column]: idSchema, revoked_at: z.number().int() }).strict(),
      result.at(-1)!.results[0],
    );
  }
  throw new HttpError(405, "method_not_allowed", "Method is not supported");
}
