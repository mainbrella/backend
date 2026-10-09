CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_user_created_at
  ON projects(user_id, created_at DESC, id DESC);
