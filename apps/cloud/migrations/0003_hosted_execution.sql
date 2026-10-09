-- Phase 2B.2 hosted execution foundation. Additive only; never modifies 0001/0002.
-- D1 batch provides atomic application transactions; every admission batch rechecks
-- authority inside conditional SQL. No existing machine_credentials audience CHECK
-- is widened: sfexec_/sfsuper_ credentials live in dedicated hashed-token tables.
--
-- Conventions: UUID TEXT primary keys, Unix-millisecond INTEGER times, safe-integer
-- counts, canonical bounded integer-string quantities (exact arithmetic, no floats:
-- digits only, no leading zeros unless "0", max 19 digits). D1 serializes batch
-- writes; all ceiling checks belong in conditional DML, never app-side counters.

-- Server-owned org capability policy, versioned history. Zero/absent policy denies
-- new work. One ACTIVE (unrevoked, in-window) row per org is chosen by conditional
-- application SQL; history is retained for audit/replay. No prices/plan names.
CREATE TABLE hosted_entitlements (
  entitlement_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
  version INTEGER NOT NULL CHECK(version > 0),
  hosted_control_plane INTEGER NOT NULL CHECK(hosted_control_plane IN (0,1)),
  remote_worker_enrollment INTEGER NOT NULL CHECK(remote_worker_enrollment IN (0,1)),
  hosted_task_execution INTEGER NOT NULL CHECK(hosted_task_execution IN (0,1)),
  max_concurrent_workers INTEGER CHECK(max_concurrent_workers IS NULL OR max_concurrent_workers >= 0),
  max_active_tasks INTEGER CHECK(max_active_tasks IS NULL OR max_active_tasks >= 0),
  max_task_runtime INTEGER CHECK(max_task_runtime IS NULL OR max_task_runtime > 0),
  maximum_resource_reservations INTEGER CHECK(maximum_resource_reservations IS NULL OR maximum_resource_reservations >= 0),
  valid_from INTEGER NOT NULL,
  valid_until INTEGER NOT NULL CHECK(valid_until > valid_from),
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  created_by TEXT,
  UNIQUE(organization_id, version)
);
CREATE INDEX hosted_entitlement_org_valid ON hosted_entitlements(organization_id, valid_from, valid_until);

-- Metered allowance definitions: explicit unit + period + canonical integer-string
-- quantity. No currency, no conversion, no cross-unit combination.
CREATE TABLE hosted_allowances (
  allowance_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
  entitlement_id TEXT NOT NULL REFERENCES hosted_entitlements(entitlement_id),
  resource TEXT NOT NULL,
  unit TEXT NOT NULL,
  resource_class TEXT NOT NULL CHECK(length(resource_class) BETWEEN 1 AND 128),
  allowed_quantity TEXT NOT NULL CHECK(
    allowed_quantity GLOB '[0-9]*' AND length(allowed_quantity) BETWEEN 1 AND 19
    AND (allowed_quantity = '0' OR substr(allowed_quantity, 1, 1) != '0')),
  consumed_quantity TEXT NOT NULL DEFAULT '0' CHECK(
    consumed_quantity GLOB '[0-9]*' AND length(consumed_quantity) BETWEEN 1 AND 19
    AND (consumed_quantity = '0' OR substr(consumed_quantity, 1, 1) != '0')),
  reserved_quantity TEXT NOT NULL DEFAULT '0' CHECK(
    reserved_quantity GLOB '[0-9]*' AND length(reserved_quantity) BETWEEN 1 AND 19
    AND (reserved_quantity = '0' OR substr(reserved_quantity, 1, 1) != '0')),
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL CHECK(period_end > period_start),
  created_at INTEGER NOT NULL,
  UNIQUE(organization_id, resource, resource_class, period_start)
);
CREATE INDEX hosted_allowance_period ON hosted_allowances(organization_id, resource, period_start, period_end);

-- Browser-authorized sfexec_ execution grants. Bind an existing CLI installation,
-- its epoch, user, active tenant and finite authorization. Only the
-- installation's own user may authorize it. sfcli_/sfworker_ remain unchanged
-- and insufficient. Raw secret is never stored; retry replays sealed ciphertext.
CREATE TABLE hosted_execution_grants (
  grant_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  installation_id TEXT NOT NULL REFERENCES cli_installations(installation_id),
  organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
  user_id TEXT NOT NULL REFERENCES users(user_id),
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  scopes TEXT NOT NULL CHECK(json_valid(scopes)),
  epoch INTEGER NOT NULL CHECK(epoch > 0),
  idempotency_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  result_ciphertext TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at > created_at),
  authorization_expires_at INTEGER NOT NULL CHECK(authorization_expires_at > created_at),
  revoked_at INTEGER,
  CHECK(expires_at <= authorization_expires_at),
  UNIQUE(installation_id, session_id, idempotency_key)
);
CREATE INDEX hosted_grant_org ON hosted_execution_grants(organization_id, grant_id);
CREATE INDEX hosted_grant_installation ON hosted_execution_grants(installation_id);
CREATE INDEX hosted_grant_expiry ON hosted_execution_grants(expires_at);

-- Supervisors: owner/admin-registered, bound to one enrolled tenant worker.
CREATE TABLE hosted_supervisors (
  supervisor_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
  worker_id TEXT NOT NULL REFERENCES cloud_workers(worker_id),
  authorizing_user_id TEXT NOT NULL REFERENCES users(user_id),
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('registered','revoked')),
  epoch INTEGER NOT NULL CHECK(epoch > 0),
  created_at INTEGER NOT NULL,
  authorization_expires_at INTEGER NOT NULL CHECK(authorization_expires_at > created_at),
  revoked_at INTEGER
);
CREATE INDEX hosted_supervisor_org ON hosted_supervisors(organization_id, supervisor_id);
CREATE INDEX hosted_supervisor_worker ON hosted_supervisors(worker_id);

-- sfsuper_ supervisor credentials. Separate tables/hashes/epochs/revocation from
-- machine_credentials; audience is fixed and never shared with worker/browser.
CREATE TABLE hosted_supervisor_credentials (
  credential_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  supervisor_id TEXT NOT NULL REFERENCES hosted_supervisors(supervisor_id),
  audience TEXT NOT NULL CHECK(audience = 'hosted-supervisor'),
  scopes TEXT NOT NULL CHECK(json_valid(scopes)),
  epoch INTEGER NOT NULL CHECK(epoch > 0),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at > created_at),
  revoked_at INTEGER
);
CREATE INDEX hosted_supervisor_credential_supervisor ON hosted_supervisor_credentials(supervisor_id);
CREATE INDEX hosted_supervisor_credential_expiry ON hosted_supervisor_credentials(expires_at);

-- Exact-context rotation retry only; old credentials never regain general access.
CREATE TABLE hosted_supervisor_rotations (
  previous_credential_id TEXT PRIMARY KEY REFERENCES hosted_supervisor_credentials(credential_id),
  idempotency_key TEXT NOT NULL,
  result_ciphertext TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at > created_at)
);
CREATE INDEX hosted_supervisor_rotation_expiry ON hosted_supervisor_rotations(expires_at);

-- Admitted tasks. Strict controlled inert workload only: execution_class is
-- fixed "controlled" with bounded runtime_ms/controlled_duration_ms and
-- duration <= runtime. No prompts/shell/repo/env/secrets enter hosted execution.
-- One reservation per task: reservation_id is UNIQUE here and task_id is UNIQUE
-- in hosted_reservations. Idempotency scope binds tenant + principal + operation.
CREATE TABLE hosted_tasks (
  task_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
  worker_id TEXT NOT NULL REFERENCES cloud_workers(worker_id),
  request_id TEXT NOT NULL,
  operation TEXT NOT NULL DEFAULT 'task.create',
  principal_kind TEXT NOT NULL CHECK(principal_kind IN ('account','cli','execution')),
  principal_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  execution_class TEXT NOT NULL CHECK(execution_class = 'controlled'),
  state TEXT NOT NULL CHECK(state IN ('queued','claimed','running','stop_requested','held','completed','failed','cancelled','expired')),
  reservation_id TEXT NOT NULL UNIQUE,
  policy_version INTEGER NOT NULL CHECK(policy_version > 0),
  runtime_ms INTEGER NOT NULL CHECK(runtime_ms > 0),
  controlled_duration_ms INTEGER NOT NULL CHECK(controlled_duration_ms > 0),
  created_at INTEGER NOT NULL,
  deadline_at INTEGER NOT NULL CHECK(deadline_at > created_at),
  lease_id TEXT,
  supervisor_id TEXT REFERENCES hosted_supervisors(supervisor_id),
  fence INTEGER NOT NULL DEFAULT 0 CHECK(fence >= 0),
  lease_expires_at INTEGER,
  CHECK(controlled_duration_ms <= runtime_ms),
  UNIQUE(organization_id, request_id),
  UNIQUE(organization_id, principal_id, operation, idempotency_key)
);
CREATE INDEX hosted_task_org_state ON hosted_tasks(organization_id, state, task_id);
CREATE INDEX hosted_task_lease ON hosted_tasks(lease_expires_at) WHERE state IN ('queued','claimed','running','stop_requested','held');

-- Capacity reservations. Active/quarantined counts are authoritative; uncertain
-- execution is retained (quarantined), never released by TTL alone. Exactly one
-- row per task. Release/consumption settles together with terminal task state.
CREATE TABLE hosted_reservations (
  reservation_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
  task_id TEXT NOT NULL UNIQUE REFERENCES hosted_tasks(task_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind = 'task_execution'),
  quantity TEXT NOT NULL CHECK(
    quantity GLOB '[0-9]*' AND length(quantity) BETWEEN 1 AND 19
    AND (quantity = '0' OR substr(quantity, 1, 1) != '0')),
  state TEXT NOT NULL CHECK(state IN ('active','quarantined','consumed','released')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at > created_at),
  released_at INTEGER
);
CREATE INDEX hosted_reservation_org_state ON hosted_reservations(organization_id, state);
CREATE INDEX hosted_reservation_task ON hosted_reservations(task_id);

-- Durable dispatch intent. Supervisor claims via CAS with monotonic fence and
-- finite lease; ack never reallocates. Exactly one outbox row per task.
CREATE TABLE hosted_outbox (
  outbox_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
  task_id TEXT NOT NULL UNIQUE REFERENCES hosted_tasks(task_id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK(state IN ('queued','claimed','acked','dead')),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_at INTEGER NOT NULL,
  claimed_by TEXT REFERENCES hosted_supervisors(supervisor_id),
  claim_expires_at INTEGER,
  lease_id TEXT,
  fence INTEGER NOT NULL DEFAULT 0 CHECK(fence >= 0),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0)
);
CREATE INDEX hosted_outbox_claim ON hosted_outbox(organization_id, state, created_at);

-- Typed idempotent operations/audit intent. Keys bind tenant + current
-- principal/resource + operation and canonical fingerprint; replays recheck
-- current authority and never allocate additional capacity.
CREATE TABLE hosted_operations (
  operation_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
  principal_key TEXT NOT NULL CHECK(length(principal_key) BETWEEN 1 AND 256),
  resource_id TEXT,
  operation TEXT NOT NULL CHECK(length(operation) BETWEEN 1 AND 128),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128),
  fingerprint TEXT NOT NULL,
  task_id TEXT REFERENCES hosted_tasks(task_id) ON DELETE SET NULL,
  result_ciphertext TEXT,
  status INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at > created_at),
  UNIQUE(organization_id, principal_key, operation, idempotency_key)
);
CREATE INDEX hosted_operation_expiry ON hosted_operations(expires_at);
CREATE INDEX hosted_operation_task ON hosted_operations(task_id);
