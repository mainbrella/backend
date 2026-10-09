-- Separate public routing database; never bind the account/session database to ingress.
CREATE TABLE project_endpoints (
  project_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  target_json TEXT NOT NULL,
  container_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  port INTEGER,
  revision TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE project_hosts (
  hostname TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending_tls', 'active', 'disabled')),
  verification_token TEXT NOT NULL
);
CREATE INDEX project_hosts_project ON project_hosts(project_id);
-- Persistent fencing prevents delayed publications from overriding a newer operation.
CREATE TABLE project_route_versions (project_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, revision TEXT NOT NULL);
-- Retain exact-generation cleanup metadata when an RPC or database response is lost.
CREATE TABLE project_binding_operations (
  revision TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  route_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX project_binding_operations_project ON project_binding_operations(project_id, user_id);
