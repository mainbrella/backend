-- Browser keys grant only named table operations and pinned function versions.
-- Secrets are returned once; only their SHA-256 digest is retained.
CREATE TABLE bff_api_keys (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES bff_projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  origins TEXT NOT NULL CHECK(json_valid(origins)),
  tables TEXT NOT NULL CHECK(json_valid(tables)),
  functions TEXT NOT NULL CHECK(json_valid(functions)),
  created_at TEXT NOT NULL
);
CREATE INDEX bff_api_keys_project ON bff_api_keys(project_id, created_at);
