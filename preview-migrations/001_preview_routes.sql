-- Apply to the separate preview routing database, never the account database.
-- The gateway receives only this database and USER_CONTAINER bindings.
CREATE TABLE preview_routes (
  token_hash TEXT PRIMARY KEY CHECK(length(token_hash) = 64),
  preview_id TEXT NOT NULL UNIQUE CHECK(length(preview_id) = 32),
  container_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX preview_routes_expiry ON preview_routes(expires_at);
