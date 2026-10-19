-- Keep the owner and object key after project/account deletion so the scheduled
-- cleanup can remove cached objects. Public reads always join the live project.
CREATE TABLE bff_previews (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  url_hash TEXT NOT NULL,
  url TEXT NOT NULL,
  favicon TEXT,
  state TEXT NOT NULL CHECK(state IN ('pending','processing','ready','failed')),
  object_key TEXT,
  error TEXT,
  lease TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(project_id,url_hash)
);
CREATE INDEX bff_previews_expiry ON bff_previews(expires_at);
ALTER TABLE bff_daily_usage ADD COLUMN previews INTEGER NOT NULL DEFAULT 0 CHECK(previews >= 0);
