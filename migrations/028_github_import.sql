-- Import authorization is separate from any future write-capable Build app.
CREATE TABLE github_import_connections (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  github_user_id TEXT NOT NULL,
  github_login TEXT NOT NULL,
  credentials TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  refresh_lock TEXT,
  refresh_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE github_import_states (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repo TEXT NOT NULL,
  return_origin TEXT NOT NULL,
  return_path TEXT NOT NULL,
  verifier TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('authorize', 'install')),
  expires_at INTEGER NOT NULL
);
CREATE INDEX github_import_states_expiry ON github_import_states(expires_at);
