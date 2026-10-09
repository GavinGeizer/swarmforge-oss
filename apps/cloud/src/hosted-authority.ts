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
  type HostedExecutionCredentialReply,
  hostedCliScopes,
  hostedExecutionCredentialReplySchema,
} from "./hosted-types.ts";
import { auditStatement, browserGuard, key } from "./machines.ts";
import { idSchema } from "./schemas.ts";

// Browser-authorized sfexec_ execution grants (audience `hosted-cli`).
// These bind an existing CLI installation, its epoch, user, active tenant and
// finite authorization. Only the installation's own user may authorize it via
// an authenticated session/CSRF. Existing sfcli_/sfworker_ grants/scopes are
// unchanged and insufficient for execution; machine_credentials is never
// widened. Raw secrets are never stored; issuance retries replay sealed
// ciphertext while the successor grant and authorization remain valid.

export const hostedGrantTtl = 3600000;

export interface HostedPrincipal {
  grant_id: string;
  credential_id: string;
  installation_id: string;
  organization_id: string;
  user_id: string;
  scopes: string;
  epoch: number;
  expires_at: number;
  authorization_expires_at: number;
}

// Live-grant predicate: unrevoked, unexpired, installation active in the same
// org, epoch match, CURRENT installation authorization window (not a stale
// copy: g.authorization_expires_at must equal the installation's live value),
// and the grant's user is the installation's CURRENT user with active
// membership in the active org. CLI rotation (epoch), reassignment (user),
// revocation (status), or authorization-window change all invalidate grants.
const hostedLiveGrant = `g.revoked_at IS NULL AND g.expires_at>? AND i.status='active' AND i.organization_id=g.organization_id AND g.epoch=i.epoch AND g.user_id=i.user_id AND g.authorization_expires_at=i.authorization_expires_at AND g.authorization_expires_at>? AND EXISTS(SELECT 1 FROM users u JOIN memberships m USING(user_id) JOIN organizations o USING(organization_id) WHERE u.user_id=g.user_id AND m.organization_id=g.organization_id AND u.status='active' AND m.status='active' AND o.status='active')`;

// Downstream single-batch admission/claim CAS must recheck the underlying
// grant + CLI installation epoch/user/membership/org at mutation time. This
// guard composes into conditional DML; it is never a preflight-only check.
export function hostedPrincipalGuard(p: HostedPrincipal, now = Date.now()) {
  return {
    sql: `EXISTS(SELECT 1 FROM hosted_execution_grants g JOIN cli_installations i USING(installation_id) WHERE g.grant_id=? AND g.organization_id=? AND g.user_id=? AND g.installation_id=? AND ${hostedLiveGrant})`,
    args: [
      p.grant_id,
      p.organization_id,
      p.user_id,
      p.installation_id,
      now,
      now,
    ],
  };
}

// Browser-session authority for direct (non-grant) hosted calls. Re-evaluated
// inside the write batch by downstream owners.
export function hostedSessionGuard(ctx: Context, tenant: string) {
  return browserGuard(ctx, tenant, false);
}

export async function hostedAuth(ctx: Context) {
  // Never fall through to cookie, instance, GitHub, sfcli_ or sfworker_ auth.
  const raw = ctx.request.headers.get("authorization") ?? "";
  if (!/^Bearer sfexec_[A-Za-z0-9_-]{43}$/.test(raw))
    throw new HttpError(
      401,
      "unauthenticated",
      "A valid execution credential is required",
    );
  const now = Date.now();
  const row = await ctx.env.DB.prepare(
    `SELECT g.grant_id,g.grant_id credential_id,g.installation_id,g.organization_id,g.user_id,g.scopes,g.epoch,g.expires_at,g.authorization_expires_at FROM hosted_execution_grants g JOIN cli_installations i USING(installation_id) WHERE g.token_hash=? AND ${hostedLiveGrant}`,
  )
    .bind(await hash(raw.slice(7)), now, now)
    .first<HostedPrincipal>();
  if (!row)
    throw new HttpError(
      401,
      "unauthenticated",
      "A valid execution credential is required",
    );
  if (
    JSON.stringify(JSON.parse(row.scopes)) !== JSON.stringify(hostedCliScopes)
  )
    throw new HttpError(401, "unauthenticated", "Credential scope is invalid");
  ctx.actor = row.user_id;
  return row;
}

async function issueExecutionGrant(
  tenant: string,
  installation: string,
  user: string,
  authorizationExpires: number,
) {
  const now = Date.now(),
    credential = `sfexec_${token()}`;
  const reply: HostedExecutionCredentialReply =
    hostedExecutionCredentialReplySchema.parse({
      credential,
      credential_id: crypto.randomUUID(),
      grant_id: crypto.randomUUID(),
      installation_id: installation,
      subject_id: user,
      tenant_id: tenant,
      scopes: [...hostedCliScopes],
      expires_at: Math.min(now + hostedGrantTtl, authorizationExpires),
      authorization_expires_at: authorizationExpires,
    });
  return { reply, hash: await hash(credential), now };
}

// Exact-context retry of issuance only; revoked/rotated grants never replay.
async function issuanceReplay(
  ctx: Context,
  tenant: string,
  installation: string,
) {
  const k = key(ctx);
  const s = ctx.session!;
  const row = await ctx.env.DB.prepare(
    "SELECT result_ciphertext FROM hosted_execution_grants WHERE organization_id=? AND installation_id=? AND session_id=? AND idempotency_key=? AND revoked_at IS NULL AND expires_at>?",
  )
    .bind(tenant, installation, s.session_id, k, Date.now())
    .first<{ result_ciphertext: string }>();
  if (!row) return null;
  const reply = hostedExecutionCredentialReplySchema.parse(
    JSON.parse(await open(ctx.env.AUTH_SECRET, row.result_ciphertext)),
  );
  await hostedAuth({
    ...ctx,
    request: new Request(ctx.request.url, {
      headers: { authorization: `Bearer ${reply.credential}` },
    }),
  });
  return json(hostedExecutionCredentialReplySchema, reply);
}

async function authorize(ctx: Context, tenant: string, installation: string) {
  // Browser session + CSRF only. authentication() rejects Authorization
  // headers, so machine credentials can never authorize execution grants.
  await authentication(ctx);
  await csrf(ctx);
  z.object({})
    .strict()
    .parse(await body(ctx));
  const replay = await issuanceReplay(ctx, tenant, installation);
  if (replay) return replay;
  const k = key(ctx);
  const s = ctx.session!;
  await membership(ctx, tenant);
  // Own installation only: the installation must belong to the caller's user,
  // tenant, and be active. Anything else is indistinguishable from missing.
  const target = await ctx.env.DB.prepare(
    "SELECT installation_id,user_id,organization_id,epoch,authorization_expires_at FROM cli_installations WHERE installation_id=? AND organization_id=? AND user_id=? AND status='active'",
  )
    .bind(installation, tenant, s.user_id)
    .first<{
      installation_id: string;
      user_id: string;
      organization_id: string;
      epoch: number;
      authorization_expires_at: number;
    }>();
  if (!target) throw notFound();
  const issued = await issueExecutionGrant(
    tenant,
    installation,
    s.user_id,
    target.authorization_expires_at,
  );
  const guard = browserGuard(ctx, tenant, false);
  const cipher = await seal(ctx.env.AUTH_SECRET, JSON.stringify(issued.reply));
  // Same-window predicates: browser session, installation epoch/user/status,
  // and installation authorization window are all rechecked inside the batch
  // (TOCTOU between the pre-read and the insert closes here). The
  // UNIQUE(installation_id, session_id, idempotency_key) loser inserts zero
  // rows; the final SELECT then returns the winner's ciphertext for clean
  // replay — but a replay that no longer passes hostedAuth (revoked/rotated)
  // is rejected, never resurrected.
  const result = await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      `INSERT INTO hosted_execution_grants SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL WHERE ${guard.sql} AND EXISTS(SELECT 1 FROM cli_installations WHERE installation_id=? AND organization_id=? AND user_id=? AND status='active' AND epoch=? AND authorization_expires_at=?)`,
    ).bind(
      issued.reply.grant_id,
      issued.hash,
      installation,
      tenant,
      s.user_id,
      s.session_id,
      JSON.stringify(issued.reply.scopes),
      target.epoch,
      k,
      await hash(installation),
      cipher,
      issued.now,
      issued.reply.expires_at,
      issued.reply.authorization_expires_at,
      ...guard.args,
      installation,
      tenant,
      s.user_id,
      target.epoch,
      target.authorization_expires_at,
    ),
    auditStatement(
      ctx,
      "hosted.execution_authorized",
      `grant:${issued.reply.grant_id}`,
      tenant,
      s.user_id,
      "FROM hosted_execution_grants WHERE grant_id=?",
      [issued.reply.grant_id],
    ),
    ctx.env.DB.prepare(
      `SELECT result_ciphertext FROM hosted_execution_grants WHERE organization_id=? AND installation_id=? AND session_id=? AND idempotency_key=? AND revoked_at IS NULL AND expires_at>? AND ${guard.sql}`,
    ).bind(tenant, installation, s.session_id, k, Date.now(), ...guard.args),
  ]);
  const saved = result.at(-1)?.results[0] as
    | { result_ciphertext: string }
    | undefined;
  if (!saved) {
    const retry = await issuanceReplay(ctx, tenant, installation);
    if (retry) return retry;
    throw new HttpError(
      409,
      "authorization_conflict",
      "Execution cannot be authorized with current authority",
    );
  }
  const value = hostedExecutionCredentialReplySchema.parse(
    JSON.parse(await open(ctx.env.AUTH_SECRET, saved.result_ciphertext)),
  );
  // Never replay a subsequently revoked/rotated grant merely because the key matches.
  await hostedAuth({
    ...ctx,
    request: new Request(ctx.request.url, {
      headers: { authorization: `Bearer ${value.credential}` },
    }),
  });
  return json(hostedExecutionCredentialReplySchema, value, 201);
}

export async function revokeExecutionGrant(ctx: Context, p: HostedPrincipal) {
  const guard = hostedPrincipalGuard(p);
  const now = Date.now();
  const result = await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      `UPDATE hosted_execution_grants SET revoked_at=COALESCE(revoked_at,?) WHERE grant_id=? AND organization_id=? AND ${guard.sql}`,
    ).bind(now, p.grant_id, p.organization_id, ...guard.args),
    ctx.env.DB.prepare(
      "SELECT grant_id,revoked_at FROM hosted_execution_grants WHERE grant_id=? AND revoked_at IS NOT NULL",
    ).bind(p.grant_id),
  ]);
  if (!result.at(-1)?.results.length) throw notFound();
  return result.at(-1)!.results[0];
}

export async function hostedAuthorityRoute(ctx: Context) {
  const url = new URL(ctx.request.url);
  const match = url.pathname.match(
    /^\/v1\/tenants\/([^/]+)\/cli-installations\/([^/]+)\/execution-authorizations$/,
  );
  if (!match || ctx.request.method !== "POST") return null;
  z.object({}).strict().parse(Object.fromEntries(url.searchParams));
  return authorize(ctx, idSchema.parse(match[1]), idSchema.parse(match[2]));
}
