CREATE TABLE repo_launches (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  request_json TEXT NOT NULL,
  state_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  lock_token TEXT,
  lock_until INTEGER NOT NULL DEFAULT 0,
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX repo_launches_owner ON repo_launches(user_id, created_at);
