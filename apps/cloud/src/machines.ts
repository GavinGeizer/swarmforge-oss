import { z } from "zod";
import {
  body,
  type Context,
  cursor,
  HttpError,
  json,
  keyFormat,
  notFound,
  page,
} from "./common.ts";
import { hash, open, seal, token } from "./crypto.ts";
import { idSchema, roleSchema } from "./schemas.ts";
export const cliScopes = ["identity:read", "devices:self"] as const;
export const workerScopes = ["worker:identity", "worker:rotate"] as const;
export const grantTtl = 30 * 86400000;
export const cliTtl = 86400000;
export const workerTtl = 3600000;
export const nameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine(
    (v) =>
      ![...v].some((c) => {
        const n = c.codePointAt(0)!;
        return n < 32 || (n >= 127 && n <= 159);
      }),
  );
export const credentialReply = z
  .object({
    credential: z.string().regex(/^(sfcli_|sfworker_)[A-Za-z0-9_-]{43}$/),
    credential_id: idSchema,
    installation_id: idSchema.optional(),
    worker_id: idSchema.optional(),
    subject_id: idSchema,
    tenant_id: idSchema,
    scopes: z.array(z.string()),
    expires_at: z.number().int(),
    authorization_expires_at: z.number().int(),
  })
  .strict();
export interface Machine {
  credential_id: string;
  organization_id: string;
  user_id: string;
  resource_id: string;
  audience: "cloud-cli" | "worker-identity";
  scopes: string;
  epoch: number;
  expires_at: number;
  authorization_expires_at: number;
  name: string;
}
const machineSchema = z
  .object({
    installation_id: idSchema,
    subject_id: idSchema,
    tenant_id: idSchema,
    client_name: nameSchema,
    scopes: z.array(z.enum(cliScopes)),
    expires_at: z.number().int(),
    authorization_expires_at: z.number().int(),
  })
  .strict();
const workerSchema = z
  .object({
    worker_id: idSchema,
    tenant_id: idSchema,
    name: nameSchema,
    state: z.enum(["registered", "revoked"]),
    registration_epoch: z.number().int(),
    created_at: z.number().int(),
    revoked_at: z.number().int().nullable(),
  })
  .strict();
export function key(ctx: Context) {
  const k = ctx.request.headers.get("idempotency-key") ?? "";
  if (!keyFormat.test(k))
    throw new HttpError(400, "invalid_request", "Idempotency-Key is required");
  return k;
}
// Shared grant authority for website approvals. Re-evaluated in the write batch.
export function browserGuard(ctx: Context, tenant: string, admin = false) {
  const s = ctx.session!;
  return {
    sql: `EXISTS(SELECT 1 FROM sessions s JOIN users u USING(user_id) JOIN memberships m ON m.user_id=u.user_id JOIN organizations o USING(organization_id) WHERE s.session_id=? AND s.user_id=? AND s.revoked_at IS NULL AND s.expires_at>? AND u.status='active' AND m.organization_id=? AND m.status='active' AND o.status='active' ${admin ? "AND m.role IN ('owner','admin')" : ""})`,
    args: [s.session_id, s.user_id, Date.now(), tenant],
  };
}
// Existing grants depend continuously on their authorizing user's active membership.
// Workers additionally require that user to retain owner/admin authority.
export const activeMember = `EXISTS(SELECT 1 FROM users u JOIN memberships m USING(user_id) JOIN organizations o USING(organization_id) WHERE u.user_id=r.user_id AND m.organization_id=r.organization_id AND u.status='active' AND m.status='active' AND o.status='active')`;
const cliActive = `c.revoked_at IS NULL AND c.expires_at>? AND r.status='active' AND r.authorization_expires_at>? AND c.epoch=r.epoch AND ${activeMember}`;
const workerActive = `c.revoked_at IS NULL AND c.expires_at>? AND r.status='registered' AND r.authorization_expires_at>? AND c.epoch=r.epoch AND EXISTS(SELECT 1 FROM users u JOIN memberships m USING(user_id) JOIN organizations o USING(organization_id) WHERE u.user_id=r.authorizing_user_id AND m.organization_id=r.organization_id AND u.status='active' AND m.status='active' AND m.role IN ('owner','admin') AND o.status='active')`;
export function machineGuard(m: Machine, now = Date.now()) {
  const cli = m.audience === "cloud-cli";
  return {
    sql: `EXISTS(SELECT 1 FROM machine_credentials c JOIN ${cli ? "cli_installations" : "cloud_workers"} r ON r.${cli ? "installation_id" : "worker_id"}=c.${cli ? "installation_id" : "worker_id"} WHERE c.credential_id=? AND c.audience=? AND ${cli ? cliActive : workerActive})`,
    args: [m.credential_id, m.audience, now, now],
  };
}
export async function machineAuth(ctx: Context, audience: Machine["audience"]) {
  // Never fall through to cookie or instance/GitHub bearer authentication.
  const prefix = audience === "cloud-cli" ? "sfcli_" : "sfworker_";
  const raw = ctx.request.headers.get("authorization") ?? "";
  if (!new RegExp(`^Bearer ${prefix}[A-Za-z0-9_-]{43}$`).test(raw))
    throw new HttpError(
      401,
      "unauthenticated",
      "A valid machine credential is required",
    );
  const cli = audience === "cloud-cli",
    now = Date.now();
  const row = await ctx.env.DB.prepare(
    `SELECT c.credential_id,c.audience,c.scopes,c.epoch,c.expires_at,r.organization_id,r.${cli ? "user_id" : "authorizing_user_id"} user_id,r.${cli ? "installation_id" : "worker_id"} resource_id,r.${cli ? "client_name" : "name"} name,r.authorization_expires_at FROM machine_credentials c JOIN ${cli ? "cli_installations" : "cloud_workers"} r ON r.${cli ? "installation_id" : "worker_id"}=c.${cli ? "installation_id" : "worker_id"} WHERE c.token_hash=? AND c.audience=? AND ${cli ? cliActive : workerActive}`,
  )
    .bind(await hash(raw.slice(7)), audience, now, now)
    .first<Machine>();
  if (!row)
    throw new HttpError(
      401,
      "unauthenticated",
      "A valid machine credential is required",
    );
  const expected = cli ? cliScopes : workerScopes;
  if (JSON.stringify(JSON.parse(row.scopes)) !== JSON.stringify(expected))
    throw new HttpError(401, "unauthenticated", "Credential scope is invalid");
  if (cli) {
    // Activity metadata is approximate, never authority. Bound actual writes to
    // one per five minutes and recheck the credential before updating the row.
    const guard = machineGuard(row, now);
    await ctx.env.DB.prepare(
      `UPDATE cli_installations SET last_seen_at=? WHERE installation_id=? AND (last_seen_at IS NULL OR last_seen_at<=?) AND ${guard.sql}`,
    )
      .bind(now, row.resource_id, now - 300000, ...guard.args)
      .run();
  }
  ctx.actor = row.user_id;
  return row;
}
export function auditStatement(
  ctx: Context,
  action: string,
  resource: string,
  tenant: string,
  user: string,
  source: string,
  args: (string | number)[],
  event: string = crypto.randomUUID(),
) {
  return ctx.env.DB.prepare(
    `INSERT OR IGNORE INTO audit_events SELECT ?,?,?,?,?,'success',?,?,'{}' ${source}`,
  ).bind(
    event,
    user,
    tenant,
    action,
    resource,
    ctx.request_id,
    Date.now(),
    ...args,
  );
}
export async function issueCredential(
  _ctx: Context,
  kind: "cli" | "worker",
  resource: string,
  user: string,
  tenant: string,
  epoch: number,
  authorizationExpires: number,
) {
  const now = Date.now(),
    credential = (kind === "cli" ? "sfcli_" : "sfworker_") + token();
  return {
    reply: credentialReply.parse({
      credential,
      credential_id: crypto.randomUUID(),
      [kind === "cli" ? "installation_id" : "worker_id"]: resource,
      subject_id: user,
      tenant_id: tenant,
      scopes: kind === "cli" ? cliScopes : workerScopes,
      expires_at: Math.min(
        now + (kind === "cli" ? cliTtl : workerTtl),
        authorizationExpires,
      ),
      authorization_expires_at: authorizationExpires,
    }),
    hash: await hash(credential),
    epoch,
    now,
  };
}
export function credentialInsert(
  ctx: Context,
  issued: Awaited<ReturnType<typeof issueCredential>>,
  condition: string,
  args: (string | number)[],
) {
  const x = issued.reply,
    cli = Boolean(x.installation_id);
  return ctx.env.DB.prepare(
    `INSERT INTO machine_credentials SELECT ?,?,?,?,?,?,?,?,?,NULL WHERE ${condition}`,
  ).bind(
    x.credential_id,
    issued.hash,
    x.installation_id ?? null,
    x.worker_id ?? null,
    cli ? "cloud-cli" : "worker-identity",
    JSON.stringify(x.scopes),
    issued.epoch,
    issued.now,
    x.expires_at,
    ...args,
  );
}
// Exact-context retry of rotation only; old credentials never regain general access.
async function rotationReplay(ctx: Context, audience: Machine["audience"]) {
  const raw = ctx.request.headers.get("authorization") ?? "",
    prefix = audience === "cloud-cli" ? "sfcli_" : "sfworker_";
  if (!new RegExp(`^Bearer ${prefix}[A-Za-z0-9_-]{43}$`).test(raw)) return null;
  const k = key(ctx),
    now = Date.now();
  const row = await ctx.env.DB.prepare(
    "SELECT r.result_ciphertext FROM credential_rotations r JOIN machine_credentials c ON c.credential_id=r.previous_credential_id WHERE c.token_hash=? AND c.audience=? AND c.expires_at>? AND r.idempotency_key=? AND r.expires_at>?",
  )
    .bind(await hash(raw.slice(7)), audience, now, k, now)
    .first<{ result_ciphertext: string }>();
  if (!row) return null;
  const reply = credentialReply.parse(
    JSON.parse(await open(ctx.env.AUTH_SECRET, row.result_ciphertext)),
  );
  await machineAuth(
    {
      ...ctx,
      request: new Request(ctx.request.url, {
        headers: { authorization: `Bearer ${reply.credential}` },
      }),
    },
    audience,
  );
  return json(credentialReply, reply);
}
async function rotate(ctx: Context, m: Machine) {
  const k = key(ctx),
    now = Date.now();
  const cli = m.audience === "cloud-cli",
    table = cli ? "cli_installations" : "cloud_workers",
    column = cli ? "installation_id" : "worker_id";
  const issued = await issueCredential(
    ctx,
    cli ? "cli" : "worker",
    m.resource_id,
    m.user_id,
    m.organization_id,
    m.epoch + 1,
    m.authorization_expires_at,
  );
  const guard = machineGuard(m, now),
    cipher = await seal(ctx.env.AUTH_SECRET, JSON.stringify(issued.reply));
  const result = await ctx.env.DB.batch([
    // A guarded CAS on the old epoch chooses one rotation. No stale-token replay.
    ctx.env.DB.prepare(
      `UPDATE ${table} SET epoch=epoch+1 WHERE ${column}=? AND epoch=? AND ${guard.sql}`,
    ).bind(m.resource_id, m.epoch, ...guard.args),
    credentialInsert(
      ctx,
      issued,
      `EXISTS(SELECT 1 FROM ${table} WHERE ${column}=? AND epoch=?) AND EXISTS(SELECT 1 FROM machine_credentials WHERE credential_id=? AND revoked_at IS NULL AND epoch=?)`,
      [m.resource_id, m.epoch + 1, m.credential_id, m.epoch],
    ),
    ctx.env.DB.prepare(
      "UPDATE machine_credentials SET revoked_at=? WHERE credential_id=? AND EXISTS(SELECT 1 FROM machine_credentials WHERE credential_id=?)",
    ).bind(now, m.credential_id, issued.reply.credential_id),
    ctx.env.DB.prepare(
      "INSERT INTO credential_rotations SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM machine_credentials WHERE credential_id=?)",
    ).bind(
      m.credential_id,
      k,
      cipher,
      now,
      now + 600000,
      issued.reply.credential_id,
    ),
    auditStatement(
      ctx,
      "credential.rotated",
      `credential:${issued.reply.credential_id}`,
      m.organization_id,
      m.user_id,
      "FROM machine_credentials WHERE credential_id=?",
      [issued.reply.credential_id],
    ),
    ctx.env.DB.prepare(
      "SELECT credential_id FROM machine_credentials WHERE credential_id=?",
    ).bind(issued.reply.credential_id),
  ]);
  if (!result.at(-1)?.results.length) {
    const replay = await rotationReplay(ctx, m.audience);
    if (replay) return replay;
    throw new HttpError(
      409,
      "rotation_conflict",
      "Credential has changed; reauthorize if response was lost",
    );
  }
  return json(credentialReply, issued.reply);
}
async function revokeMachine(ctx: Context, m: Machine) {
  const cli = m.audience === "cloud-cli",
    table = cli ? "cli_installations" : "cloud_workers",
    column = cli ? "installation_id" : "worker_id",
    guard = machineGuard(m),
    now = Date.now();
  const result = await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      `UPDATE ${table} SET status='revoked',revoked_at=?,epoch=epoch+1 WHERE ${column}=? AND organization_id=? AND ${guard.sql}`,
    ).bind(now, m.resource_id, m.organization_id, ...guard.args),
    ctx.env.DB.prepare(
      `UPDATE machine_credentials SET revoked_at=COALESCE(revoked_at,?) WHERE ${column}=? AND EXISTS(SELECT 1 FROM ${table} WHERE ${column}=? AND status='revoked')`,
    ).bind(now, m.resource_id, m.resource_id),
    auditStatement(
      ctx,
      cli ? "cli.revoked" : "worker.revoked",
      `${column}:${m.resource_id}`,
      m.organization_id,
      m.user_id,
      `FROM ${table} WHERE ${column}=? AND status='revoked'`,
      [m.resource_id],
      `${m.resource_id}:revoked`,
    ),
    ctx.env.DB.prepare(
      `SELECT ${column},revoked_at FROM ${table} WHERE ${column}=? AND organization_id=? AND status='revoked'`,
    ).bind(m.resource_id, m.organization_id),
  ]);
  if (!result.at(-1)?.results.length) throw notFound();
  return json(
    z.object({ [column]: idSchema, revoked_at: z.number().int() }).strict(),
    result.at(-1)!.results[0],
  );
}
export async function machineRoute(ctx: Context) {
  const url = new URL(ctx.request.url),
    path = url.pathname,
    method = ctx.request.method;
  if (path.startsWith("/v1/cli/") || path.startsWith("/v1/workers/me")) {
    if (path !== "/v1/cli/organizations")
      z.object({}).strict().parse(Object.fromEntries(url.searchParams));
  }
  if (path.startsWith("/v1/cli/")) {
    if (path === "/v1/cli/me/rotate" && method === "POST") {
      z.object({})
        .strict()
        .parse(await body(ctx));
      const replay = await rotationReplay(ctx, "cloud-cli");
      if (replay) return replay;
    }
    const m = await machineAuth(ctx, "cloud-cli");
    if (path === "/v1/cli/me" && method === "GET")
      return json(machineSchema, {
        installation_id: m.resource_id,
        subject_id: m.user_id,
        tenant_id: m.organization_id,
        client_name: m.name,
        scopes: JSON.parse(m.scopes),
        expires_at: m.expires_at,
        authorization_expires_at: m.authorization_expires_at,
      });
    if (path === "/v1/cli/me" && method === "DELETE")
      return revokeMachine(ctx, m);
    if (path === "/v1/cli/me/rotate" && method === "POST")
      return rotate(ctx, m);
    if (path === "/v1/cli/organizations" && method === "GET") {
      // Listing own memberships is for re-pairing, never permission to switch grants.
      const scope = `cli:${m.resource_id}`;
      const p = await page(ctx, scope, "cli-organizations");
      const rows = await ctx.env.DB.prepare(
        "SELECT m.organization_id tenant_id,o.display_name,m.role FROM memberships m JOIN organizations o USING(organization_id) WHERE m.user_id=? AND m.status='active' AND o.status='active' AND m.organization_id>? ORDER BY m.organization_id LIMIT ?",
      )
        .bind(m.user_id, p.after, p.limit + 1)
        .all<{ tenant_id: string }>();
      const items = rows.results.slice(0, p.limit);
      return json(
        z
          .object({
            items: z.array(
              z
                .object({
                  tenant_id: idSchema,
                  display_name: z.string(),
                  role: roleSchema,
                })
                .strict(),
            ),
            next_cursor: z.string().nullable(),
          })
          .strict(),
        {
          items,
          next_cursor:
            rows.results.length > p.limit
              ? await cursor(
                  ctx,
                  scope,
                  "cli-organizations",
                  items.at(-1)!.tenant_id,
                )
              : null,
        },
      );
    }
    throw new HttpError(405, "method_not_allowed", "Method is not supported");
  }
  if (path.startsWith("/v1/workers/me")) {
    if (path === "/v1/workers/me/rotate" && method === "POST") {
      z.object({})
        .strict()
        .parse(await body(ctx));
      const replay = await rotationReplay(ctx, "worker-identity");
      if (replay) return replay;
    }
    const m = await machineAuth(ctx, "worker-identity");
    if (path === "/v1/workers/me" && method === "GET")
      return json(
        z
          .object({
            worker_id: idSchema,
            tenant_id: idSchema,
            audience: z.literal("worker-identity"),
            scopes: z.array(z.enum(workerScopes)),
            registration_epoch: z.number().int(),
            expires_at: z.number().int(),
            authorization_expires_at: z.number().int(),
          })
          .strict(),
        {
          worker_id: m.resource_id,
          tenant_id: m.organization_id,
          audience: m.audience,
          scopes: JSON.parse(m.scopes),
          registration_epoch: m.epoch,
          expires_at: m.expires_at,
          authorization_expires_at: m.authorization_expires_at,
        },
      );
    if (path === "/v1/workers/me/rotate" && method === "POST")
      return rotate(ctx, m);
    throw new HttpError(405, "method_not_allowed", "Method is not supported");
  }
  return null;
}
export { workerSchema };
