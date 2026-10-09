import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanupIdentity, cleanupStatements } from "../src/abuse.ts";
import type { Env } from "../src/index.ts";
import { fixture } from "./machine-helpers.ts";

// Phase 2B.2 cleanup compatibility regression (real D1/workerd, FKs enforced).
//
// Pre-fix, the session expiry DELETE excluded only the legacy
// request_dedup/cli_links/worker_enrollments reference legs. Hosted
// execution grants (hosted_execution_grants.session_id) and admitted tasks
// (hosted_tasks.authorizing_session_id) may reference distinct, newer
// authorizing browser sessions. Expiry cleanup then tried to delete a
// still-referenced session, failed with SQLITE_CONSTRAINT_FOREIGNKEY, and
// rolled back the ENTIRE cleanup batch (unrelated expired state survived).
//
// Seeding below is strictly TEST-ONLY: rows carry valid FK parents and obey
// the approved schema CHECKs. No commercial policy/entitlement rows are
// seeded. No FK pragmas are disabled and no SQL errors are swallowed.

// Frozen pre-fix session DELETE, kept as the regression oracle. Any edit to
// the production statement must keep this copy stale-on-purpose: it proves
// the old batch failed on hosted references.
const legacySessionDelete =
  "DELETE FROM sessions WHERE session_id IN (SELECT session_id FROM sessions s WHERE expires_at<=? AND NOT EXISTS(SELECT 1 FROM request_dedup d WHERE d.session_id=s.session_id) AND NOT EXISTS(SELECT 1 FROM cli_links l WHERE l.approving_session_id=s.session_id) AND NOT EXISTS(SELECT 1 FROM worker_enrollments e WHERE e.session_id=s.session_id) LIMIT 500)";

type H = Awaited<ReturnType<typeof fixture>>;

async function sessionIds(h: H) {
  return (
    await h.db
      .prepare("SELECT session_id FROM sessions ORDER BY rowid")
      .all<{ session_id: string }>()
  ).results.map((r) => r.session_id);
}

async function freshSession(h: H, known: string[]) {
  await h.login();
  const ids = await sessionIds(h);
  const fresh = ids.find((id) => !known.includes(id));
  assert.ok(fresh, "login must create a new session row");
  return { id: fresh, known: ids };
}

async function errorMessage(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (error) {
    return String((error as Error)?.message ?? error);
  }
  return null;
}

test("cleanup statements guard hosted grant/task session references without disabling FKs", async () => {
  const statements = cleanupStatements();
  const session = statements.find((s) => s.includes("DELETE FROM sessions"));
  assert.ok(session, "expected a session expiry DELETE");
  // Both new reference legs are guarded...
  assert.ok(
    session.includes(
      "NOT EXISTS(SELECT 1 FROM hosted_execution_grants g WHERE g.session_id=s.session_id)",
    ),
  );
  assert.ok(
    session.includes(
      "NOT EXISTS(SELECT 1 FROM hosted_tasks t WHERE t.authorizing_session_id=s.session_id)",
    ),
  );
  // ...while every legacy leg is retained, and FK enforcement is never
  // relaxed nor are SQL errors swallowed inside the statement set.
  for (const leg of [
    "FROM request_dedup d WHERE d.session_id=s.session_id",
    "FROM cli_links l WHERE l.approving_session_id=s.session_id",
    "FROM worker_enrollments e WHERE e.session_id=s.session_id",
  ])
    assert.ok(session.includes(leg), `legacy leg lost: ${leg}`);
  assert.doesNotMatch(
    statements.join(";"),
    /PRAGMA|defer_foreign|foreign_keys\s*=\s*0|OR IGNORE|INSERT OR IGNORE/i,
  );
});

test("hosted cleanup compatibility: legacy batch fails FK and rolls back; corrected cleanup preserves authorizer evidence", async () => {
  const h = await fixture();
  try {
    const base = await h.login();
    const device = await h.linked(base);
    const invite = await h.enroll(base);
    const reg = await h.register(invite);
    assert.equal(reg.status, 201);
    const worker = (await reg.json()) as { worker_id: string };
    const installation = (await h.db
      .prepare(
        "SELECT installation_id, organization_id, epoch FROM cli_installations WHERE installation_id=?",
      )
      .bind(device.installation_id)
      .first<{
        installation_id: string;
        organization_id: string;
        epoch: number;
      }>())!;
    // Two distinct authorizing browser sessions, neither otherwise referenced:
    // one behind a hosted execution grant, one behind an admitted task.
    let known = await sessionIds(h);
    const grantSession = await freshSession(h, known);
    known = grantSession.known;
    const taskSession = await freshSession(h, known);
    known = taskSession.known;
    const unrelated = await freshSession(h, known);

    const t0 = Date.now();
    const grantId = crypto.randomUUID();
    await h.db
      .prepare(
        "INSERT INTO hosted_execution_grants(grant_id,token_hash,installation_id,organization_id,user_id,session_id,scopes,epoch,idempotency_key,fingerprint,result_ciphertext,created_at,expires_at,authorization_expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        grantId,
        `hash-${crypto.randomUUID()}`,
        installation.installation_id,
        installation.organization_id,
        base.user,
        grantSession.id,
        "[]",
        installation.epoch,
        crypto.randomUUID(),
        "fp",
        "sealed-result",
        t0,
        t0 + 30 * 86400000,
        t0 + 30 * 86400000,
      )
      .run();
    const taskId = crypto.randomUUID();
    await h.db
      .prepare(
        "INSERT INTO hosted_tasks(task_id,organization_id,worker_id,authorizing_user_id,installation_id,execution_grant_id,authorizing_session_id,request_id,principal_kind,principal_id,idempotency_key,fingerprint,execution_class,state,reservation_id,policy_version,runtime_ms,controlled_duration_ms,created_at,deadline_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        taskId,
        installation.organization_id,
        worker.worker_id,
        base.user,
        installation.installation_id,
        grantId,
        taskSession.id,
        crypto.randomUUID(),
        "execution",
        "principal-1",
        crypto.randomUUID(),
        "fp",
        "controlled",
        "queued",
        crypto.randomUUID(),
        1,
        10000,
        100,
        t0,
        t0 + 60000,
      )
      .run();
    // Audit evidence present before cleanup; retention is untouched by the
    // default (auditBefore-less) cleanup path.
    await h.db
      .prepare(
        "INSERT INTO audit_events(event_id,action,resource,outcome,request_id,at,metadata) VALUES(?,?,?,?,?,?,?)",
      )
      .bind(
        crypto.randomUUID(),
        "hosted.authorize",
        taskId,
        "success",
        crypto.randomUUID(),
        t0,
        "{}",
      )
      .run();
    const auditBefore = (await h.db
      .prepare("SELECT count(*) n FROM audit_events")
      .first<{ n: number }>())!.n;
    assert.ok(auditBefore > 0);
    // Unrelated expired state plus the three expired sessions.
    await h.db
      .prepare(
        "INSERT INTO identity_rate_limits(bucket,count,expires_at) VALUES(?,?,?)",
      )
      .bind("compat-bucket", 1, t0 + 1000)
      .run();
    await h.db
      .prepare("UPDATE sessions SET expires_at=? WHERE session_id IN (?,?,?)")
      .bind(t0 + 1000, grantSession.id, taskSession.id, unrelated.id)
      .run();
    const now = t0 + 2 * 86400000;
    const env = { DB: h.db } as Env;

    // RED: the pre-fix batch (verbatim legacy session DELETE) fails with an
    // FK error and rolls back the ENTIRE batch: the individually-deletable
    // unrelated session and rate-limit row both survive.
    const red = await errorMessage(() =>
      h.db.batch([
        h.db
          .prepare("DELETE FROM identity_rate_limits WHERE expires_at<=?")
          .bind(now),
        h.db.prepare(legacySessionDelete).bind(now),
      ]),
    );
    assert.ok(
      red?.includes("FOREIGN KEY"),
      `legacy cleanup must fail FK, got: ${red}`,
    );
    assert.ok(
      await h.db
        .prepare("SELECT session_id FROM sessions WHERE session_id=?")
        .bind(unrelated.id)
        .first(),
      "rolled-back batch must not delete the unrelated expired session",
    );
    assert.ok(
      await h.db
        .prepare("SELECT bucket FROM identity_rate_limits WHERE bucket=?")
        .bind("compat-bucket")
        .first(),
      "rolled-back batch must not delete unrelated expired state",
    );

    // GREEN: the corrected cleanup completes. Both authorizing sessions, the
    // grant, the task and the audit evidence survive; unrelated expired state
    // is removed.
    await cleanupIdentity(env, now);
    for (const id of [grantSession.id, taskSession.id])
      assert.ok(
        await h.db
          .prepare("SELECT session_id FROM sessions WHERE session_id=?")
          .bind(id)
          .first(),
        `referenced authorizing session must survive: ${id}`,
      );
    assert.equal(
      (await h.db
        .prepare("SELECT session_id FROM sessions WHERE session_id=?")
        .bind(unrelated.id)
        .first()) ?? null,
      null,
      "unreferenced expired session must be removed",
    );
    assert.ok(
      await h.db
        .prepare(
          "SELECT grant_id FROM hosted_execution_grants WHERE grant_id=?",
        )
        .bind(grantId)
        .first(),
      "execution grant evidence must survive",
    );
    assert.ok(
      await h.db
        .prepare("SELECT task_id FROM hosted_tasks WHERE task_id=?")
        .bind(taskId)
        .first(),
      "admitted task evidence must survive",
    );
    assert.equal(
      (await h.db
        .prepare("SELECT count(*) n FROM audit_events")
        .first<{ n: number }>())!.n,
      auditBefore,
      "audit evidence must survive default cleanup",
    );
    assert.equal(
      (await h.db
        .prepare("SELECT bucket FROM identity_rate_limits WHERE bucket=?")
        .bind("compat-bucket")
        .first()) ?? null,
      null,
      "unrelated expired state must be removed once the batch completes",
    );
    // Cleanup is idempotent and still validates its boundary.
    await cleanupIdentity(env, now);
    await assert.rejects(() => cleanupIdentity(env, Number.NaN));
  } finally {
    await h.mf.dispose();
  }
});
