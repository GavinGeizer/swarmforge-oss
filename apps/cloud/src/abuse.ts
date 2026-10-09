import { type Context, type Env, HttpError } from "./common.ts";
import { sign } from "./crypto.ts";

// CF-Connecting-IP is trusted only at the Cloudflare edge. Local mode is private;
// never use user-agent/X-Forwarded-For as authority or as a bypass of this budget.
export async function budget(
  ctx: Context,
  group: string,
  limit: number,
  identity?: string,
) {
  const now = Date.now(),
    minute = Math.floor(now / 60000);
  const source =
    identity ?? ctx.request.headers.get("cf-connecting-ip") ?? "unknown";
  const bucket = await sign(
    ctx.env.AUTH_SECRET,
    `rate:${group}:${source}:${minute}`,
  );
  const row = await ctx.env.DB.prepare(
    "INSERT INTO identity_rate_limits VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=count+1 WHERE count<? RETURNING count",
  )
    .bind(bucket, (minute + 2) * 60000, limit)
    .first();
  return Boolean(row);
}
export async function rateLimit(ctx: Context) {
  const path = new URL(ctx.request.url).pathname;
  if (
    path === "/health" ||
    path === "/ready" ||
    ctx.request.method === "OPTIONS"
  )
    return;
  const group =
    path === "/v1/auth/github"
      ? "oauth-start"
      : path === "/v1/auth/github/callback"
        ? "oauth-callback"
        : path === "/v1/cli-links"
          ? "link-start"
          : path.includes("/cli-links/")
            ? "link"
            : path.includes("worker")
              ? "worker"
              : "private";
  const limit =
    group === "oauth-start"
      ? 20
      : group === "oauth-callback"
        ? 60
        : group === "link-start"
          ? 10
          : group === "link"
            ? 90
            : group === "worker"
              ? 60
              : 120;
  if (!(await budget(ctx, group, limit)))
    throw new HttpError(429, "rate_limited", "Request rate limit exceeded");
}
// Operator/local scheduled maintenance; deliberately bounded per invocation.
// Preserve identity/revocation records and referenced sessions for audit/recovery.
// Phase 2B.1 session guard: only the request_dedup/cli_links/worker_enrollments
// legs existed. Kept for databases that have not applied 0003 yet.
const legacySessionDelete =
  "DELETE FROM sessions WHERE session_id IN (SELECT session_id FROM sessions s WHERE expires_at<=? AND NOT EXISTS(SELECT 1 FROM request_dedup d WHERE d.session_id=s.session_id) AND NOT EXISTS(SELECT 1 FROM cli_links l WHERE l.approving_session_id=s.session_id) AND NOT EXISTS(SELECT 1 FROM worker_enrollments e WHERE e.session_id=s.session_id) LIMIT 500)";
// Phase 2B.2 adds hosted_execution_grants.session_id and
// hosted_tasks.authorizing_session_id FK references to sessions. An expired
// session that authorized hosted work must survive expiry cleanup; deleting it
// fails with SQLITE_CONSTRAINT_FOREIGNKEY and rolls back the entire batch.
const sessionDelete =
  "DELETE FROM sessions WHERE session_id IN (SELECT session_id FROM sessions s WHERE expires_at<=? AND NOT EXISTS(SELECT 1 FROM request_dedup d WHERE d.session_id=s.session_id) AND NOT EXISTS(SELECT 1 FROM cli_links l WHERE l.approving_session_id=s.session_id) AND NOT EXISTS(SELECT 1 FROM worker_enrollments e WHERE e.session_id=s.session_id) AND NOT EXISTS(SELECT 1 FROM hosted_execution_grants g WHERE g.session_id=s.session_id) AND NOT EXISTS(SELECT 1 FROM hosted_tasks t WHERE t.authorizing_session_id=s.session_id) LIMIT 500)";
function buildCleanupStatements(
  sessionStatement: string,
  auditBefore?: number,
) {
  const statements = [
    "DELETE FROM identity_rate_limits WHERE bucket IN (SELECT bucket FROM identity_rate_limits WHERE expires_at<=? LIMIT 500)",
    "DELETE FROM oauth_transactions WHERE state_hash IN (SELECT state_hash FROM oauth_transactions WHERE expires_at<=? LIMIT 500)",
    "DELETE FROM request_dedup WHERE dedup_id IN (SELECT dedup_id FROM request_dedup WHERE expires_at<=? LIMIT 500)",
    "DELETE FROM credential_rotations WHERE previous_credential_id IN (SELECT previous_credential_id FROM credential_rotations WHERE expires_at<=? LIMIT 500)",
    "UPDATE cli_links SET code_ciphertext='',result_ciphertext=NULL WHERE link_id IN (SELECT link_id FROM cli_links WHERE expires_at<=? AND (code_ciphertext<>'' OR result_ciphertext IS NOT NULL) LIMIT 500)",
    "UPDATE worker_enrollments SET result_ciphertext='',exchange_ciphertext=NULL WHERE enrollment_id IN (SELECT enrollment_id FROM worker_enrollments WHERE expires_at<=? AND (result_ciphertext<>'' OR exchange_ciphertext IS NOT NULL) LIMIT 500)",
    "DELETE FROM cli_links WHERE link_id IN (SELECT link_id FROM cli_links l WHERE expires_at<=? AND NOT EXISTS(SELECT 1 FROM cli_installations i WHERE i.link_id=l.link_id) LIMIT 500)",
    "DELETE FROM worker_enrollments WHERE enrollment_id IN (SELECT enrollment_id FROM worker_enrollments e WHERE expires_at<=? AND NOT EXISTS(SELECT 1 FROM cloud_workers w WHERE w.enrollment_id=e.enrollment_id) LIMIT 500)",
    sessionStatement,
  ];
  if (auditBefore !== undefined) {
    if (!Number.isSafeInteger(auditBefore) || auditBefore < 0)
      throw new Error("Invalid audit retention boundary");
    statements.push(
      `DELETE FROM audit_events WHERE event_id IN (SELECT event_id FROM audit_events WHERE at<=${auditBefore} ORDER BY at LIMIT 500)`,
    );
  }
  return statements;
}
export function cleanupStatements(auditBefore?: number) {
  return buildCleanupStatements(sessionDelete, auditBefore);
}
export async function cleanupIdentity(
  env: Env,
  now = Date.now(),
  auditBefore?: number,
) {
  if (!Number.isSafeInteger(now) || now < 0)
    throw new Error("Invalid cleanup boundary");
  // Phase 2B.1 databases predate the hosted tables; referencing them would
  // fail at prepare time. Probe sqlite_master so a single worker build serves
  // both schema generations without disabling FKs or swallowing SQL errors.
  const hosted = await env.DB.prepare(
    "SELECT count(*) n FROM sqlite_master WHERE type='table' AND name IN ('hosted_execution_grants','hosted_tasks')",
  ).first<{ n: number }>();
  const statements = buildCleanupStatements(
    hosted !== null && hosted.n === 2 ? sessionDelete : legacySessionDelete,
    auditBefore,
  );
  return env.DB.batch(
    statements.map((sql) =>
      sql.includes("?") ? env.DB.prepare(sql).bind(now) : env.DB.prepare(sql),
    ),
  );
}
