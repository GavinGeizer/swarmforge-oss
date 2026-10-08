-- Separate machine identities; no execution, repository or billing authority.
ALTER TABLE oauth_transactions ADD COLUMN return_path TEXT;
CREATE TABLE cli_links (
 link_id TEXT PRIMARY KEY, proof_hash TEXT NOT NULL UNIQUE,
 start_key TEXT NOT NULL, fingerprint TEXT NOT NULL, client_name TEXT NOT NULL,
 code_hash TEXT NOT NULL, code_ciphertext TEXT NOT NULL,
 requested_tenant_id TEXT, scopes TEXT NOT NULL CHECK(json_valid(scopes)),
 state TEXT NOT NULL CHECK(state IN ('pending','approved','denied','cancelled','consumed')),
 approving_user_id TEXT REFERENCES users(user_id), organization_id TEXT REFERENCES organizations(organization_id),
 approving_session_id TEXT REFERENCES sessions(session_id), approval_key TEXT,
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
 next_poll_at INTEGER NOT NULL, approval_attempts INTEGER NOT NULL DEFAULT 0 CHECK(approval_attempts BETWEEN 0 AND 5), consumed_at INTEGER,
 exchange_key TEXT, result_ciphertext TEXT,
 CHECK((state IN ('approved','consumed') AND approving_user_id IS NOT NULL AND organization_id IS NOT NULL AND approving_session_id IS NOT NULL) OR state IN ('pending','denied','cancelled'))
);
CREATE INDEX cli_link_expiry ON cli_links(expires_at);
CREATE TABLE cli_installations (
 installation_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
 user_id TEXT NOT NULL REFERENCES users(user_id), link_id TEXT NOT NULL UNIQUE REFERENCES cli_links(link_id),
 client_name TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','revoked')),
 epoch INTEGER NOT NULL CHECK(epoch>0), created_at INTEGER NOT NULL,
 last_seen_at INTEGER, authorization_expires_at INTEGER NOT NULL CHECK(authorization_expires_at>created_at), revoked_at INTEGER
);
CREATE INDEX cli_installation_org ON cli_installations(organization_id,installation_id);
CREATE INDEX cli_installation_user ON cli_installations(user_id,installation_id);
CREATE TABLE worker_enrollments (
 enrollment_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
 authorizing_user_id TEXT NOT NULL REFERENCES users(user_id), session_id TEXT NOT NULL REFERENCES sessions(session_id),
 name TEXT NOT NULL, secret_hash TEXT NOT NULL UNIQUE,
 idempotency_key TEXT NOT NULL, fingerprint TEXT NOT NULL, result_ciphertext TEXT NOT NULL,
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
 consumed_at INTEGER, revoked_at INTEGER, exchange_key TEXT, exchange_fingerprint TEXT, exchange_ciphertext TEXT,
 UNIQUE(organization_id,session_id,idempotency_key)
);
CREATE INDEX worker_enrollment_expiry ON worker_enrollments(expires_at);
CREATE TABLE cloud_workers (
 worker_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
 authorizing_user_id TEXT NOT NULL REFERENCES users(user_id), enrollment_id TEXT NOT NULL UNIQUE REFERENCES worker_enrollments(enrollment_id),
 name TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('registered','revoked')),
 epoch INTEGER NOT NULL CHECK(epoch>0), created_at INTEGER NOT NULL,
 authorization_expires_at INTEGER NOT NULL CHECK(authorization_expires_at>created_at), revoked_at INTEGER
);
CREATE INDEX cloud_worker_org ON cloud_workers(organization_id,worker_id);
CREATE TABLE machine_credentials (
 credential_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
 installation_id TEXT REFERENCES cli_installations(installation_id), worker_id TEXT REFERENCES cloud_workers(worker_id),
 audience TEXT NOT NULL CHECK(audience IN ('cloud-cli','worker-identity')),
 scopes TEXT NOT NULL CHECK(json_valid(scopes)), epoch INTEGER NOT NULL CHECK(epoch>0),
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK(expires_at>created_at), revoked_at INTEGER,
 CHECK((audience='cloud-cli' AND installation_id IS NOT NULL AND worker_id IS NULL) OR
       (audience='worker-identity' AND worker_id IS NOT NULL AND installation_id IS NULL))
);
CREATE INDEX machine_credential_installation ON machine_credentials(installation_id);
CREATE INDEX machine_credential_worker ON machine_credentials(worker_id);
CREATE INDEX machine_credential_expiry ON machine_credentials(expires_at);
CREATE TABLE credential_rotations (
 previous_credential_id TEXT PRIMARY KEY REFERENCES machine_credentials(credential_id),
 idempotency_key TEXT NOT NULL, result_ciphertext TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX rotation_expiry ON credential_rotations(expires_at);
CREATE TABLE identity_rate_limits (
 bucket TEXT PRIMARY KEY, count INTEGER NOT NULL CHECK(count>0), expires_at INTEGER NOT NULL
);
CREATE INDEX identity_rate_expiry ON identity_rate_limits(expires_at);
