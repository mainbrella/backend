CREATE TABLE IF NOT EXISTS ssh_access_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  container_created_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ssh_access_tokens_expires_at
  ON ssh_access_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_ssh_access_tokens_user_id
  ON ssh_access_tokens(user_id);
