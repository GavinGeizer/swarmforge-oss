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
  hostedSupervisorCredentialReplySchema,
  hostedSupervisorScopes,
} from "./hosted-types.ts";
import { auditStatement, browserGuard, key, nameSchema } from "./machines.ts";
import { idSchema } from "./schemas.ts";

// Phase 2B.2 supervisor identity: registration, authentication, rotation and
// revocation. New supervisor authorization is separate from workload
// eligibility: registration grants no capabilities and admits no tasks. Cloud
// claim/ack/renew/settle and task admission live with other owners; this
// module only owns supervisor credentials and their lifecycle.

// Finite TTLs: supervisor credentials are short-lived bearer secrets, the
// authorization window mirrors the bound worker's enrollment window, duplicate
// deliveries replay sealed ciphertext inside finite idempotency windows, and a
// lost rotation reply is recoverable only briefly.
export const supervisorCredentialTtl = 3600000;
export const supervisorAuthorizationTtl = 30 * 86400000;
export const supervisorOperationTtl = 86400000;
export const supervisorRotationRecoveryTtl = 600000;

const supervisorScopesJson = JSON.stringify([...hostedSupervisorScopes]);
const supervisorBearerFormat = /^Bearer sfsuper_[A-Za-z0-9_-]{43}$/;

// Explicitly typed supervisor principal: the credential, the supervisor row,
// the tenant, the bound worker, the authorizing user, the epoch both must
// share, the exact scope list and both expiries.
export interface HostedSupervisorPrincipal {
  credential_id: string;
  supervisor_id: string;
  organization_id: string;
  worker_id: string;
  authorizing_user_id: string;
  epoch: number;
  scopes: string[];
  expires_at: number;
  authorization_expires_at: number;
}

export type SupervisorAuthMode = "execution" | "cleanup";

const emptyQuerySchema = z.object({}).strict();
const emptyBodySchema = z.object({}).strict();
const registerBodySchema = z
  .object({ worker_id: idSchema, name: nameSchema })
  .strict();
const revokeReplySchema = z
  .object({ supervisor_id: idSchema, revoked_at: z.number().int() })
  .strict();
export const supervisorIdentitySchema = z
  .object({
    credential_id: idSchema,
    supervisor_id: idSchema,
    tenant_id: idSchema,
    worker_id: idSchema,
    subject_id: idSchema,
    scopes: z.tuple([
      z.literal("supervisor:claim"),
      z.literal("supervisor:renew"),
      z.literal("supervisor:report"),
      z.literal("supervisor:cleanup"),
    ]),
    expires_at: z.number().int(),
    authorization_expires_at: z.number().int(),
  })
  .strict();
export type SupervisorIdentity = z.infer<typeof supervisorIdentitySchema>;

function deny(): HttpError {
  return new HttpError(
    401,
    "unauthenticated",
    "A valid supervisor credential is required",
  );
}

interface SupervisorAuthRow {
  credential_id: string;
  supervisor_id: string;
  organization_id: string;
  worker_id: string;
  authorizing_user_id: string;
  epoch: number;
  supervisor_epoch: number;
  scopes: string;
  expires_at: number;
  authorization_expires_at: number;
  supervisor_status: string;
  supervisor_revoked_at: number | null;
  credential_revoked_at: number | null;
  worker_status: string;
  worker_authorization_expires_at: number;
  user_status: string;
  membership_status: string;
  membership_role: string;
  organization_status: string;
}

// Bearer-only supervisor authentication. Never falls through to cookie,
// machine (sfcli_/sfworker_), execution-grant (sfexec_), enrollment or
// instance/GitHub credentials: the strict sfsuper_ shape plus the fixed
// audience predicate reject every other audience before any authority check.
//
// Execution mode requires the full chain: current unrevoked sfsuper_
// credential with the exact scope list, matching epoch, live
// credential/supervisor expiry, an active owning user with owner/admin
// membership, an active tenant and an enrolled unrevoked worker inside its
// authorization window. Cleanup mode deliberately permits worker revocation
// or worker/commercial expiry (trusted stop reporting must survive losing
// the worker) but never a revoked/expired supervisor credential, a revoked/
// expired supervisor authorization, or an inactive org/user/admin.
export async function supervisorAuth(
  ctx: Context,
  mode: SupervisorAuthMode = "execution",
): Promise<HostedSupervisorPrincipal> {
  const raw = ctx.request.headers.get("authorization") ?? "";
  if (!supervisorBearerFormat.test(raw)) throw deny();
  const now = Date.now();
  const row = await ctx.env.DB.prepare(
    `SELECT c.credential_id,c.supervisor_id,c.organization_id,s.worker_id,s.authorizing_user_id,c.epoch,s.epoch supervisor_epoch,c.scopes,c.expires_at,s.authorization_expires_at,s.status supervisor_status,s.revoked_at supervisor_revoked_at,c.revoked_at credential_revoked_at,w.status worker_status,w.authorization_expires_at worker_authorization_expires_at,u.status user_status,m.status membership_status,m.role membership_role,o.status organization_status FROM hosted_supervisor_credentials c JOIN hosted_supervisors s ON s.supervisor_id=c.supervisor_id AND s.organization_id=c.organization_id JOIN cloud_workers w ON w.worker_id=s.worker_id AND w.organization_id=s.organization_id JOIN users u ON u.user_id=s.authorizing_user_id JOIN memberships m ON m.user_id=u.user_id AND m.organization_id=s.organization_id JOIN organizations o ON o.organization_id=s.organization_id WHERE c.token_hash=? AND c.audience='hosted-supervisor'`,
  )
    .bind(await hash(raw.slice(7)))
    .first<SupervisorAuthRow>();
  if (!row) throw deny();
  if (JSON.stringify(JSON.parse(row.scopes)) !== supervisorScopesJson)
    throw deny();
  if (
    row.credential_revoked_at !== null ||
    row.expires_at <= now ||
    row.epoch !== row.supervisor_epoch
  )
    throw deny();
  if (
    row.supervisor_status !== "registered" ||
    row.supervisor_revoked_at !== null ||
    row.authorization_expires_at <= now
  )
    throw deny();
  if (
    row.user_status !== "active" ||
    row.membership_status !== "active" ||
    (row.membership_role !== "owner" && row.membership_role !== "admin") ||
    row.organization_status !== "active"
  )
    throw deny();
  if (
    mode === "execution" &&
    (row.worker_status !== "registered" ||
      row.worker_authorization_expires_at <= now)
  )
    throw deny();
  ctx.actor = row.authorizing_user_id;
  return {
    credential_id: row.credential_id,
    supervisor_id: row.supervisor_id,
    organization_id: row.organization_id,
    worker_id: row.worker_id,
    authorizing_user_id: row.authorizing_user_id,
    epoch: row.epoch,
    scopes: JSON.parse(row.scopes) as string[],
    expires_at: row.expires_at,
    authorization_expires_at: row.authorization_expires_at,
  };
}

// Authority recheck for use inside D1 write batches: the same predicate as
// supervisorAuth, evaluated atomically with the mutation so a batch that
// loses authority writes nothing.
export function supervisorGuard(
  auth: HostedSupervisorPrincipal,
  now: number = Date.now(),
  mode: SupervisorAuthMode = "execution",
): { sql: string; args: (string | number)[] } {
  const worker =
    mode === "execution"
      ? " JOIN cloud_workers w ON w.worker_id=s.worker_id AND w.organization_id=s.organization_id"
      : "";
  const workerCheck =
    mode === "execution"
      ? " AND w.status='registered' AND w.authorization_expires_at>?"
      : "";
  return {
    sql: `EXISTS(SELECT 1 FROM hosted_supervisor_credentials c JOIN hosted_supervisors s ON s.supervisor_id=c.supervisor_id AND s.organization_id=c.organization_id${worker} JOIN users u ON u.user_id=s.authorizing_user_id JOIN memberships m ON m.user_id=u.user_id AND m.organization_id=s.organization_id JOIN organizations o ON o.organization_id=s.organization_id WHERE c.credential_id=? AND c.audience='hosted-supervisor' AND c.revoked_at IS NULL AND c.expires_at>? AND c.epoch=s.epoch AND c.scopes=? AND s.status='registered' AND s.revoked_at IS NULL AND s.authorization_expires_at>? AND u.status='active' AND m.status='active' AND m.role IN ('owner','admin') AND o.status='active'${workerCheck})`,
    args:
      mode === "execution"
        ? [auth.credential_id, now, supervisorScopesJson, now, now]
        : [auth.credential_id, now, supervisorScopesJson, now],
  };
}

async function registerSupervisor(ctx: Context, tenant: string) {
  await authentication(ctx);
  await membership(ctx, tenant, true);
  await csrf(ctx);
  const input = registerBodySchema.parse(await body(ctx)),
    k = key(ctx),
    now = Date.now(),
    s = ctx.session!;
  const worker = await ctx.env.DB.prepare(
    "SELECT worker_id,organization_id,status,authorization_expires_at FROM cloud_workers WHERE worker_id=? AND organization_id=?",
  )
    .bind(input.worker_id, tenant)
    .first<{
      worker_id: string;
      organization_id: string;
      status: string;
      authorization_expires_at: number;
    }>();
  // Cross-tenant or unknown workers are indistinguishable from missing so a
  // caller cannot probe another tenant's enrollment.
  if (!worker) throw notFound();
  if (worker.status !== "registered")
    throw new HttpError(409, "worker_unavailable", "Worker is not available");
  const authorizationExpires = Math.min(
    worker.authorization_expires_at,
    now + supervisorAuthorizationTtl,
  );
  if (authorizationExpires <= now)
    throw new HttpError(
      409,
      "worker_unavailable",
      "Worker authorization has expired",
    );
  const supervisorId = crypto.randomUUID(),
    credential = `sfsuper_${token()}`;
  const reply = hostedSupervisorCredentialReplySchema.parse({
    credential,
    credential_id: crypto.randomUUID(),
    supervisor_id: supervisorId,
    worker_id: worker.worker_id,
    subject_id: s.user_id,
    tenant_id: tenant,
    scopes: [...hostedSupervisorScopes],
    expires_at: Math.min(now + supervisorCredentialTtl, authorizationExpires),
    authorization_expires_at: authorizationExpires,
  });
  const fp = await hash(JSON.stringify(input)),
    cipher = await seal(ctx.env.AUTH_SECRET, JSON.stringify(reply)),
    guard = browserGuard(ctx, tenant, true),
    principalKey = `session:${s.session_id}`,
    opId = crypto.randomUUID();
  const result = await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      `INSERT INTO hosted_operations(operation_id,organization_id,principal_key,resource_id,operation,idempotency_key,fingerprint,result_ciphertext,status,created_at,expires_at) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE ${guard.sql} AND EXISTS(SELECT 1 FROM cloud_workers WHERE worker_id=? AND organization_id=? AND status='registered') ON CONFLICT(organization_id,principal_key,operation,idempotency_key) DO NOTHING`,
    ).bind(
      opId,
      tenant,
      principalKey,
      worker.worker_id,
      "supervisor.register",
      k,
      fp,
      cipher,
      201,
      now,
      now + supervisorOperationTtl,
      ...guard.args,
      worker.worker_id,
      tenant,
    ),
    ctx.env.DB.prepare(
      "INSERT INTO hosted_supervisors(supervisor_id,organization_id,worker_id,authorizing_user_id,name,status,epoch,created_at,authorization_expires_at) SELECT ?,?,?,?,?,'registered',1,?,? WHERE EXISTS(SELECT 1 FROM hosted_operations WHERE operation_id=?)",
    ).bind(
      supervisorId,
      tenant,
      worker.worker_id,
      s.user_id,
      input.name,
      now,
      authorizationExpires,
      opId,
    ),
    ctx.env.DB.prepare(
      "INSERT INTO hosted_supervisor_credentials(credential_id,token_hash,supervisor_id,organization_id,audience,scopes,epoch,created_at,expires_at) SELECT ?,?,?,?,'hosted-supervisor',?,?,?,? WHERE EXISTS(SELECT 1 FROM hosted_supervisors WHERE supervisor_id=?)",
    ).bind(
      reply.credential_id,
      await hash(credential),
      supervisorId,
      tenant,
      supervisorScopesJson,
      1,
      now,
      reply.expires_at,
      supervisorId,
    ),
    auditStatement(
      ctx,
      "supervisor.registered",
      `supervisor:${supervisorId}`,
      tenant,
      s.user_id,
      "FROM hosted_supervisors WHERE supervisor_id=?",
      [supervisorId],
    ),
    // The encrypted replay rechecks CURRENT browser authority and the
    // worker binding; a lost reply never allocates a second supervisor.
    ctx.env.DB.prepare(
      `SELECT fingerprint,result_ciphertext,expires_at FROM hosted_operations WHERE organization_id=? AND principal_key=? AND operation='supervisor.register' AND idempotency_key=? AND ${guard.sql} AND EXISTS(SELECT 1 FROM cloud_workers WHERE worker_id=? AND organization_id=? AND status='registered')`,
    ).bind(tenant, principalKey, k, ...guard.args, worker.worker_id, tenant),
  ]);
  const saved = result.at(-1)?.results[0] as
    | { fingerprint: string; result_ciphertext: string; expires_at: number }
    | undefined;
  if (!saved)
    throw new HttpError(
      409,
      "registration_conflict",
      "Supervisor cannot be registered with current authority or key",
    );
  if (saved.fingerprint !== fp || saved.expires_at <= now)
    throw new HttpError(
      409,
      "idempotency_conflict",
      "Idempotency key is already used or expired",
    );
  return json(
    hostedSupervisorCredentialReplySchema,
    JSON.parse(await open(ctx.env.AUTH_SECRET, saved.result_ciphertext)),
    201,
  );
}

async function revokeSupervisor(
  ctx: Context,
  tenant: string,
  supervisorId: string,
) {
  await authentication(ctx);
  await membership(ctx, tenant, true);
  await csrf(ctx);
  const k = key(ctx),
    now = Date.now(),
    s = ctx.session!,
    guard = browserGuard(ctx, tenant, true),
    principalKey = `session:${s.session_id}`,
    opId = crypto.randomUUID(),
    fp = await hash(JSON.stringify({ supervisor_id: supervisorId }));
  const result = await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      `INSERT INTO hosted_operations(operation_id,organization_id,principal_key,resource_id,operation,idempotency_key,fingerprint,status,created_at,expires_at) SELECT ?,?,?,?,?,?,?,200,?,? WHERE ${guard.sql} ON CONFLICT(organization_id,principal_key,operation,idempotency_key) DO NOTHING`,
    ).bind(
      opId,
      tenant,
      principalKey,
      supervisorId,
      "supervisor.revoke",
      k,
      fp,
      now,
      now + supervisorOperationTtl,
      ...guard.args,
    ),
    // Durable revocation: the supervisor row flips to revoked and its epoch
    // advances so every live credential fails the epoch check. Repeat calls
    // are a no-op on an already revoked row.
    ctx.env.DB.prepare(
      `UPDATE hosted_supervisors SET status='revoked',revoked_at=COALESCE(revoked_at,?),epoch=epoch+CASE WHEN status='revoked' THEN 0 ELSE 1 END WHERE supervisor_id=? AND organization_id=? AND EXISTS(SELECT 1 FROM hosted_operations WHERE operation_id=?) AND ${guard.sql}`,
    ).bind(now, supervisorId, tenant, opId, ...guard.args),
    ctx.env.DB.prepare(
      "UPDATE hosted_supervisor_credentials SET revoked_at=COALESCE(revoked_at,?) WHERE supervisor_id=? AND organization_id=? AND EXISTS(SELECT 1 FROM hosted_supervisors WHERE supervisor_id=? AND status='revoked')",
    ).bind(now, supervisorId, tenant, supervisorId),
    // Assignments owned by this supervisor stop or hold: claimed/running
    // work moves to held so a trusted operator can reauthorize cleanup.
    // stop_requested duty is preserved (never falsely confirmed), queued
    // unassigned work is untouched, and reservations stay put: uncertain
    // execution is retained, never released or confirmed stopped here.
    ctx.env.DB.prepare(
      "UPDATE hosted_tasks SET state='held' WHERE supervisor_id=? AND organization_id=? AND state IN ('claimed','running') AND EXISTS(SELECT 1 FROM hosted_supervisors WHERE supervisor_id=? AND status='revoked')",
    ).bind(supervisorId, tenant, supervisorId),
    auditStatement(
      ctx,
      "supervisor.revoked",
      `supervisor:${supervisorId}`,
      tenant,
      s.user_id,
      "FROM hosted_supervisors WHERE supervisor_id=? AND status='revoked'",
      [supervisorId],
      `${supervisorId}:revoked`,
    ),
    ctx.env.DB.prepare(
      "SELECT fingerprint FROM hosted_operations WHERE organization_id=? AND principal_key=? AND operation='supervisor.revoke' AND idempotency_key=?",
    ).bind(tenant, principalKey, k),
    ctx.env.DB.prepare(
      `SELECT supervisor_id,revoked_at FROM hosted_supervisors WHERE supervisor_id=? AND organization_id=? AND status='revoked' AND ${guard.sql}`,
    ).bind(supervisorId, tenant, ...guard.args),
  ]);
  const op = result.at(-2)?.results[0] as { fingerprint: string } | undefined;
  if (!op || op.fingerprint !== fp)
    throw new HttpError(
      409,
      "idempotency_conflict",
      "Idempotency key is already used or expired",
    );
  const saved = result.at(-1)?.results[0];
  if (!saved) throw notFound();
  return json(revokeReplySchema, saved);
}

// Exact-context recovery of a lost rotation reply. Returns the successor
// only while that successor (and its authorization) is still valid; the old
// key never regains general authority because every other path rechecks the
// revoked old credential first.
async function rotationReplay(ctx: Context) {
  const raw = ctx.request.headers.get("authorization") ?? "";
  if (!supervisorBearerFormat.test(raw)) return null;
  const k = key(ctx),
    now = Date.now();
  const row = await ctx.env.DB.prepare(
    "SELECT r.result_ciphertext FROM hosted_supervisor_rotations r JOIN hosted_supervisor_credentials c ON c.credential_id=r.previous_credential_id WHERE c.token_hash=? AND c.audience='hosted-supervisor' AND c.expires_at>? AND r.idempotency_key=? AND r.expires_at>?",
  )
    .bind(await hash(raw.slice(7)), now, k, now)
    .first<{ result_ciphertext: string }>();
  if (!row) return null;
  const reply = hostedSupervisorCredentialReplySchema.parse(
    JSON.parse(await open(ctx.env.AUTH_SECRET, row.result_ciphertext)),
  );
  await supervisorAuth(
    {
      ...ctx,
      request: new Request(ctx.request.url, {
        headers: { authorization: `Bearer ${reply.credential}` },
      }),
    },
    "execution",
  );
  return json(hostedSupervisorCredentialReplySchema, reply);
}

async function rotateSupervisor(ctx: Context, auth: HostedSupervisorPrincipal) {
  const k = key(ctx),
    now = Date.now();
  const credential = `sfsuper_${token()}`;
  const reply = hostedSupervisorCredentialReplySchema.parse({
    credential,
    credential_id: crypto.randomUUID(),
    supervisor_id: auth.supervisor_id,
    worker_id: auth.worker_id,
    subject_id: auth.authorizing_user_id,
    tenant_id: auth.organization_id,
    scopes: [...hostedSupervisorScopes],
    expires_at: Math.min(
      now + supervisorCredentialTtl,
      auth.authorization_expires_at,
    ),
    authorization_expires_at: auth.authorization_expires_at,
  });
  const guard = supervisorGuard(auth, now, "execution"),
    cipher = await seal(ctx.env.AUTH_SECRET, JSON.stringify(reply));
  const result = await ctx.env.DB.batch([
    // A guarded CAS on the old epoch chooses one rotation. No stale-token
    // replay: the successor is only inserted when the epoch advanced here.
    ctx.env.DB.prepare(
      `UPDATE hosted_supervisors SET epoch=epoch+1 WHERE supervisor_id=? AND epoch=? AND ${guard.sql}`,
    ).bind(auth.supervisor_id, auth.epoch, ...guard.args),
    ctx.env.DB.prepare(
      "INSERT INTO hosted_supervisor_credentials(credential_id,token_hash,supervisor_id,organization_id,audience,scopes,epoch,created_at,expires_at) SELECT ?,?,?,?,'hosted-supervisor',?,?,?,? WHERE EXISTS(SELECT 1 FROM hosted_supervisors WHERE supervisor_id=? AND epoch=?) AND EXISTS(SELECT 1 FROM hosted_supervisor_credentials WHERE credential_id=? AND revoked_at IS NULL AND epoch=?)",
    ).bind(
      reply.credential_id,
      await hash(credential),
      auth.supervisor_id,
      auth.organization_id,
      supervisorScopesJson,
      auth.epoch + 1,
      now,
      reply.expires_at,
      auth.supervisor_id,
      auth.epoch + 1,
      auth.credential_id,
      auth.epoch,
    ),
    ctx.env.DB.prepare(
      "UPDATE hosted_supervisor_credentials SET revoked_at=? WHERE credential_id=? AND EXISTS(SELECT 1 FROM hosted_supervisor_credentials WHERE credential_id=?)",
    ).bind(now, auth.credential_id, reply.credential_id),
    ctx.env.DB.prepare(
      "INSERT INTO hosted_supervisor_rotations(previous_credential_id,idempotency_key,result_ciphertext,created_at,expires_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM hosted_supervisor_credentials WHERE credential_id=?)",
    ).bind(
      auth.credential_id,
      k,
      cipher,
      now,
      now + supervisorRotationRecoveryTtl,
      reply.credential_id,
    ),
    auditStatement(
      ctx,
      "supervisor.rotated",
      `credential:${reply.credential_id}`,
      auth.organization_id,
      auth.authorizing_user_id,
      "FROM hosted_supervisor_credentials WHERE credential_id=?",
      [reply.credential_id],
    ),
    ctx.env.DB.prepare(
      "SELECT credential_id FROM hosted_supervisor_credentials WHERE credential_id=?",
    ).bind(reply.credential_id),
  ]);
  if (!result.at(-1)?.results.length) {
    const replay = await rotationReplay(ctx);
    if (replay) return replay;
    throw new HttpError(
      409,
      "rotation_conflict",
      "Credential has changed; reauthorize if response was lost",
    );
  }
  return json(hostedSupervisorCredentialReplySchema, reply);
}

export async function supervisorRoute(ctx: Context): Promise<Response | null> {
  const url = new URL(ctx.request.url),
    path = url.pathname,
    method = ctx.request.method;
  const tenantMatch = path.match(
    /^\/v1\/tenants\/([^/]+)\/supervisors(?:\/([^/]+))?$/,
  );
  if (tenantMatch) {
    emptyQuerySchema.parse(Object.fromEntries(url.searchParams));
    const tenant = idSchema.parse(tenantMatch[1]);
    if (!tenantMatch[2] && method === "POST")
      return registerSupervisor(ctx, tenant);
    if (tenantMatch[2] && method === "DELETE") {
      const supervisorId = idSchema.parse(tenantMatch[2]);
      return revokeSupervisor(ctx, tenant, supervisorId);
    }
    throw new HttpError(405, "method_not_allowed", "Method is not supported");
  }
  if (path === "/v1/supervisor/me" || path === "/v1/supervisor/me/rotate") {
    emptyQuerySchema.parse(Object.fromEntries(url.searchParams));
    if (path === "/v1/supervisor/me/rotate" && method === "POST") {
      emptyBodySchema.parse(await body(ctx));
      const replay = await rotationReplay(ctx);
      if (replay) return replay;
    }
    // Supervisor identity reads and rotation require a live execution
    // credential; cleanup-mode tolerance applies to dispatch operations
    // owned by other modules, never to identity lifecycle here.
    const auth = await supervisorAuth(ctx, "execution");
    if (path === "/v1/supervisor/me" && method === "GET")
      return json(supervisorIdentitySchema, {
        credential_id: auth.credential_id,
        supervisor_id: auth.supervisor_id,
        tenant_id: auth.organization_id,
        worker_id: auth.worker_id,
        subject_id: auth.authorizing_user_id,
        scopes: auth.scopes,
        expires_at: auth.expires_at,
        authorization_expires_at: auth.authorization_expires_at,
      });
    if (path === "/v1/supervisor/me/rotate" && method === "POST")
      return rotateSupervisor(ctx, auth);
    throw new HttpError(405, "method_not_allowed", "Method is not supported");
  }
  return null;
}
