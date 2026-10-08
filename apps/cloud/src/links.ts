import { z } from "zod";
import {
  authentication,
  body,
  type Context,
  csrf,
  HttpError,
  json,
  membership,
  notFound,
} from "./common.ts";
import { hash, open, seal, token } from "./crypto.ts";
import {
  auditStatement,
  browserGuard,
  cliScopes,
  credentialInsert,
  credentialReply,
  grantTtl,
  issueCredential,
  key,
  machineAuth,
  nameSchema,
} from "./machines.ts";
import { idSchema } from "./schemas.ts";

const startSchema = z
  .object({
    client_name: nameSchema,
    requested_scopes: z.tuple([
      z.literal("identity:read"),
      z.literal("devices:self"),
    ]),
    tenant_id: idSchema.optional(),
  })
  .strict();
const startReply = z
  .object({
    link_id: idSchema,
    user_code: z.string().regex(/^[A-Za-z0-9_-]{12}$/),
    verification_url: z.url(),
    expires_at: z.number().int(),
    poll_interval_seconds: z.literal(5),
  })
  .strict();
const stateSchema = z.enum([
  "pending",
  "approved",
  "denied",
  "cancelled",
  "consumed",
]);
interface Link {
  link_id: string;
  proof_hash: string;
  start_key: string;
  fingerprint: string;
  client_name: string;
  code_hash: string;
  code_ciphertext: string;
  requested_tenant_id: string | null;
  scopes: string;
  state: z.infer<typeof stateSchema>;
  approving_user_id: string | null;
  organization_id: string | null;
  approving_session_id: string | null;
  approval_key: string | null;
  created_at: number;
  expires_at: number;
  next_poll_at: number;
  approval_attempts: number;
  exchange_key: string | null;
  result_ciphertext: string | null;
}
async function proof(ctx: Context) {
  const value = ctx.request.headers.get("authorization") ?? "";
  if (!/^LinkInitiator [A-Za-z0-9_-]{43}$/.test(value))
    throw new HttpError(
      401,
      "unauthenticated",
      "A valid initiating proof is required",
    );
  return hash(value.slice(14));
}
async function initiatingLink(ctx: Context, id: string) {
  idSchema.parse(id);
  const l = await ctx.env.DB.prepare(
    "SELECT * FROM cli_links WHERE link_id=? AND proof_hash=?",
  )
    .bind(id, await proof(ctx))
    .first<Link>();
  if (!l) throw notFound();
  if (l.expires_at <= Date.now())
    throw new HttpError(410, "link_expired", "Link has expired");
  return l;
}
async function startLink(ctx: Context) {
  const p = await proof(ctx),
    k = key(ctx),
    input = startSchema.parse(await body(ctx)),
    now = Date.now(),
    id = crypto.randomUUID(),
    code = token(9),
    fingerprint = await hash(JSON.stringify(input));
  await ctx.env.DB.prepare(
    "INSERT INTO cli_links(link_id,proof_hash,start_key,fingerprint,client_name,code_hash,code_ciphertext,requested_tenant_id,scopes,state,created_at,expires_at,next_poll_at) VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?,?) ON CONFLICT(proof_hash) DO NOTHING",
  )
    .bind(
      id,
      p,
      k,
      fingerprint,
      input.client_name,
      await hash(code),
      await seal(ctx.env.AUTH_SECRET, code),
      input.tenant_id ?? null,
      JSON.stringify(cliScopes),
      now,
      now + 600000,
      now,
    )
    .run();
  const l = await ctx.env.DB.prepare(
    "SELECT * FROM cli_links WHERE proof_hash=?",
  )
    .bind(p)
    .first<Link>();
  if (!l || l.start_key !== k || l.fingerprint !== fingerprint)
    throw new HttpError(
      409,
      "idempotency_conflict",
      "Initiating proof is already in use",
    );
  if (l.expires_at <= Date.now())
    throw new HttpError(410, "link_expired", "Link has expired");
  return json(
    startReply,
    {
      link_id: l.link_id,
      user_code: await open(ctx.env.AUTH_SECRET, l.code_ciphertext),
      verification_url: `${ctx.env.APP_ORIGIN}/cloud/connect?link_id=${l.link_id}`,
      expires_at: l.expires_at,
      poll_interval_seconds: 5,
    },
    201,
  );
}
async function approve(ctx: Context, id: string, denied = false) {
  await authentication(ctx);
  await csrf(ctx);
  const k = key(ctx);
  const input = (
    denied
      ? z
          .object({ user_code: z.string().regex(/^[A-Za-z0-9_-]{12}$/) })
          .strict()
      : z
          .object({
            user_code: z.string().regex(/^[A-Za-z0-9_-]{12}$/),
            tenant_id: idSchema,
          })
          .strict()
  ).parse(await body(ctx));
  const l = await ctx.env.DB.prepare(
    "SELECT * FROM cli_links WHERE link_id=? AND code_hash=?",
  )
    .bind(id, await hash(input.user_code))
    .first<Link>();
  if (!l) {
    await ctx.env.DB.prepare(
      "UPDATE cli_links SET approval_attempts=approval_attempts+1 WHERE link_id=? AND state='pending' AND expires_at>? AND approval_attempts<5",
    )
      .bind(id, Date.now())
      .run();
    throw new HttpError(400, "invalid_code", "Pairing code is invalid");
  }
  if (l.approval_attempts >= 5)
    throw new HttpError(
      403,
      "approval_locked",
      "Too many invalid pairing attempts; start a new link",
    );
  if (l.expires_at <= Date.now())
    throw new HttpError(410, "link_expired", "Link has expired");
  const tenant = "tenant_id" in input ? String(input.tenant_id) : null;
  if (!denied) {
    if (l.requested_tenant_id && tenant !== l.requested_tenant_id)
      throw new HttpError(
        403,
        "forbidden",
        "Requested organization must be explicitly approved",
      );
    await membership(ctx, tenant!);
  }
  const s = ctx.session!,
    now = Date.now(),
    guard = denied
      ? {
          sql: "EXISTS(SELECT 1 FROM sessions s JOIN users u USING(user_id) WHERE s.session_id=? AND s.user_id=? AND s.revoked_at IS NULL AND s.expires_at>? AND u.status='active')",
          args: [s.session_id, s.user_id, now],
        }
      : browserGuard(ctx, tenant!);
  const target = denied ? "denied" : "approved";
  const results = await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      `UPDATE cli_links SET state=?,approving_user_id=?,organization_id=?,approving_session_id=?,approval_key=? WHERE link_id=? AND state='pending' AND approval_attempts<5 AND expires_at>? AND ${guard.sql}`,
    ).bind(target, s.user_id, tenant, s.session_id, k, id, now, ...guard.args),
    ctx.env.DB.prepare(
      `INSERT OR IGNORE INTO audit_events SELECT ?,approving_user_id,organization_id,?,?,'success',?,?,'{}' FROM cli_links WHERE link_id=? AND approving_session_id=? AND approval_key=? AND state=?`,
    ).bind(
      `${id}:${target}`,
      denied ? "cli.link_denied" : "cli.link_approved",
      `cli-link:${id}`,
      ctx.request_id,
      now,
      id,
      s.session_id,
      k,
      target,
    ),
    ctx.env.DB.prepare(
      `SELECT state,organization_id tenant_id FROM cli_links WHERE link_id=? AND approving_user_id=? AND approving_session_id=? AND approval_key=? AND state=? AND organization_id IS ? AND ${guard.sql}`,
    ).bind(id, s.user_id, s.session_id, k, target, tenant, ...guard.args),
  ]);
  if (!results.at(-1)?.results.length)
    throw new HttpError(409, "link_conflict", "Link cannot be approved again");
  return json(
    z
      .object({
        link_id: idSchema,
        state: z.enum(["approved", "denied"]),
        tenant_id: idSchema.nullable(),
      })
      .strict(),
    { link_id: id, ...(results.at(-1)!.results[0] as Record<string, unknown>) },
  );
}
async function exchange(ctx: Context, l: Link) {
  const k = key(ctx);
  z.object({})
    .strict()
    .parse(await body(ctx));
  const now = Date.now();
  if (l.state === "pending") {
    const next = await ctx.env.DB.prepare(
      "UPDATE cli_links SET next_poll_at=? WHERE link_id=? AND next_poll_at<=? AND state='pending' RETURNING link_id",
    )
      .bind(now + 5000, l.link_id, now)
      .first();
    if (!next)
      throw new HttpError(429, "slow_down", "Wait before polling again");
    return json(
      z
        .object({
          state: z.literal("pending"),
          poll_interval_seconds: z.literal(5),
        })
        .strict(),
      { state: "pending", poll_interval_seconds: 5 },
      202,
    );
  }
  if (l.state === "denied" || l.state === "cancelled")
    throw new HttpError(403, "link_denied", "Link was denied or cancelled");
  if (l.state === "consumed" && l.exchange_key !== k)
    throw new HttpError(409, "link_consumed", "Link has already been consumed");
  const installation = crypto.randomUUID(),
    issued = await issueCredential(
      ctx,
      "cli",
      installation,
      l.approving_user_id!,
      l.organization_id!,
      1,
      now + grantTtl,
    ),
    cipher = await seal(ctx.env.AUTH_SECRET, JSON.stringify(issued.reply));
  // Approval session must still be active at initial exchange, as must membership.
  const authority =
    "EXISTS(SELECT 1 FROM sessions s JOIN users u USING(user_id) JOIN memberships m ON m.user_id=u.user_id JOIN organizations o USING(organization_id) WHERE s.session_id=cli_links.approving_session_id AND u.user_id=cli_links.approving_user_id AND s.revoked_at IS NULL AND s.expires_at>? AND u.status='active' AND m.organization_id=cli_links.organization_id AND m.status='active' AND o.status='active')";
  const results = await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      `UPDATE cli_links SET state='consumed',consumed_at=?,exchange_key=?,result_ciphertext=? WHERE link_id=? AND state='approved' AND expires_at>? AND ${authority} AND (SELECT count(*) FROM cli_installations WHERE organization_id=cli_links.organization_id AND status='active')<100`,
    ).bind(now, k, cipher, l.link_id, now, now),
    ctx.env.DB.prepare(
      "INSERT INTO cli_installations SELECT ?,organization_id,approving_user_id,link_id,client_name,'active',1,?,NULL,?,NULL FROM cli_links WHERE link_id=? AND exchange_key=? AND result_ciphertext=?",
    ).bind(
      installation,
      now,
      issued.reply.authorization_expires_at,
      l.link_id,
      k,
      cipher,
    ),
    credentialInsert(
      ctx,
      issued,
      "EXISTS(SELECT 1 FROM cli_installations WHERE installation_id=?)",
      [installation],
    ),
    auditStatement(
      ctx,
      "cli.link_consumed",
      `installation:${installation}`,
      l.organization_id!,
      l.approving_user_id!,
      "FROM cli_installations WHERE installation_id=?",
      [installation],
    ),
    ctx.env.DB.prepare(
      "SELECT exchange_key,result_ciphertext FROM cli_links WHERE link_id=? AND state='consumed' AND expires_at>?",
    ).bind(l.link_id, now),
  ]);
  const saved = results.at(-1)?.results[0] as
    | { exchange_key: string; result_ciphertext: string }
    | undefined;
  if (!saved)
    throw new HttpError(
      403,
      "authorization_changed",
      "Authorization changed; start a new link",
    );
  if (saved.exchange_key !== k)
    throw new HttpError(409, "link_consumed", "Link has already been consumed");
  const reply = credentialReply.parse(
    JSON.parse(await open(ctx.env.AUTH_SECRET, saved.result_ciphertext)),
  );
  // Never replay a subsequently revoked/rotated grant merely because the key matches.
  await machineAuth(
    {
      ...ctx,
      request: new Request(ctx.request.url, {
        headers: { authorization: `Bearer ${reply.credential}` },
      }),
    },
    "cloud-cli",
  );
  return json(credentialReply, reply);
}
export async function linkRoute(ctx: Context) {
  const path = new URL(ctx.request.url).pathname,
    method = ctx.request.method;
  if (path === "/v1/cli-links" && method === "POST") return startLink(ctx);
  const match = path.match(
    /^\/v1\/cli-links\/([^/]+)(?:\/(approve|deny|exchange|status))?$/,
  );
  if (!match) return null;
  const id = idSchema.parse(match[1]);
  if (match[2] === "approve" && method === "POST") return approve(ctx, id);
  if (match[2] === "deny" && method === "POST") return approve(ctx, id, true);
  if (!match[2] && method === "GET") {
    await authentication(ctx);
    const l = await ctx.env.DB.prepare(
      "SELECT * FROM cli_links WHERE link_id=? AND expires_at>?",
    )
      .bind(id, Date.now())
      .first<Link>();
    if (!l) throw notFound();
    return json(
      z
        .object({
          link_id: idSchema,
          client_name: nameSchema,
          scopes: z.array(z.enum(cliScopes)),
          requested_tenant_id: idSchema.nullable(),
          expires_at: z.number().int(),
          state: stateSchema,
        })
        .strict(),
      {
        link_id: id,
        client_name: l.client_name,
        scopes: JSON.parse(l.scopes),
        requested_tenant_id: l.requested_tenant_id,
        expires_at: l.expires_at,
        state: l.state,
      },
    );
  }
  const l = await initiatingLink(ctx, id);
  if (match[2] === "exchange" && method === "POST") return exchange(ctx, l);
  if (match[2] === "status" && method === "GET") {
    const now = Date.now();
    const row = await ctx.env.DB.prepare(
      "UPDATE cli_links SET next_poll_at=? WHERE link_id=? AND next_poll_at<=? RETURNING state,expires_at",
    )
      .bind(now + 5000, id, now)
      .first();
    if (!row)
      throw new HttpError(429, "slow_down", "Wait before polling again");
    return json(
      z
        .object({
          state: stateSchema,
          expires_at: z.number().int(),
          poll_interval_seconds: z.literal(5),
        })
        .strict(),
      { ...row, poll_interval_seconds: 5 },
    );
  }
  if (!match[2] && method === "DELETE") {
    const row = await ctx.env.DB.prepare(
      "UPDATE cli_links SET state='cancelled' WHERE link_id=? AND state IN ('pending','approved','cancelled') RETURNING state",
    )
      .bind(id)
      .first();
    if (!row)
      throw new HttpError(
        409,
        "link_consumed",
        "Consumed link cannot be cancelled",
      );
    return json(z.object({ state: z.literal("cancelled") }).strict(), row);
  }
  throw new HttpError(405, "method_not_allowed", "Method is not supported");
}
