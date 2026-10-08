-- Hosted identity only. D1 batch provides atomic application transactions.
CREATE TABLE users (
 user_id TEXT PRIMARY KEY, display_name TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('active','disabled','deleted')),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE external_identities (
 provider TEXT NOT NULL, subject_id TEXT NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(user_id), login TEXT NOT NULL,
 verified INTEGER NOT NULL CHECK(verified=1),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 PRIMARY KEY(provider,subject_id)
);
CREATE INDEX identity_user ON external_identities(user_id);
CREATE TABLE organizations (
 organization_id TEXT PRIMARY KEY, display_name TEXT NOT NULL,
 personal_user_id TEXT UNIQUE REFERENCES users(user_id),
 status TEXT NOT NULL CHECK(status IN ('active','disabled','deleted')),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE memberships (
 organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
 user_id TEXT NOT NULL REFERENCES users(user_id),
 role TEXT NOT NULL CHECK(role IN ('owner','admin','member')),
 status TEXT NOT NULL CHECK(status IN ('active','revoked')),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 PRIMARY KEY(organization_id,user_id)
);
CREATE INDEX membership_user ON memberships(user_id,status,organization_id);
CREATE INDEX membership_org ON memberships(organization_id,status,user_id);
CREATE TABLE sessions (
 session_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(user_id),
 token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
 revoked_at INTEGER, revocation_id TEXT
);
CREATE INDEX session_user ON sessions(user_id,session_id);
CREATE INDEX session_expiry ON sessions(expires_at);
CREATE TABLE oauth_transactions (
 state_hash TEXT PRIMARY KEY, browser_hash TEXT NOT NULL,
 verifier_ciphertext TEXT NOT NULL, created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL CHECK(expires_at>created_at), consumed_at INTEGER
);
CREATE INDEX oauth_expiry ON oauth_transactions(expires_at);
CREATE TABLE audit_events (
 event_id TEXT PRIMARY KEY, actor_user_id TEXT REFERENCES users(user_id) ON DELETE SET NULL,
 organization_id TEXT REFERENCES organizations(organization_id) ON DELETE SET NULL,
 action TEXT NOT NULL, resource TEXT NOT NULL,
 outcome TEXT NOT NULL CHECK(outcome IN ('success','denied','failure')),
 request_id TEXT NOT NULL, at INTEGER NOT NULL, metadata TEXT NOT NULL CHECK(json_valid(metadata))
);
CREATE INDEX audit_org_time ON audit_events(organization_id,at);
CREATE INDEX audit_actor_time ON audit_events(actor_user_id,at);
CREATE TABLE request_dedup (
 dedup_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
 session_id TEXT NOT NULL REFERENCES sessions(session_id), operation TEXT NOT NULL,
 idempotency_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
 result_json TEXT NOT NULL CHECK(json_valid(result_json)), status INTEGER NOT NULL CHECK(status=200),
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 UNIQUE(organization_id,session_id,operation,idempotency_key)
);
CREATE INDEX dedup_expiry ON request_dedup(expires_at);
