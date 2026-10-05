-- Test-only schema for retained legacy handlers. These are not Mainbrella
-- production migrations; native/community feature migrations live elsewhere.
ALTER TABLE users ADD COLUMN supabase_user_id TEXT;
ALTER TABLE users ADD COLUMN supabase_transfer_confirmed_at TEXT;
ALTER TABLE users ADD COLUMN apple_sub TEXT;
CREATE UNIQUE INDEX users_apple_sub ON users(apple_sub) WHERE apple_sub IS NOT NULL;
CREATE TABLE app_access_tokens (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE app_refresh_tokens (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL, revoked_at TEXT
);
CREATE TABLE herds (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, city_id TEXT, created_by TEXT, media_enabled INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE herd_memberships (herd_id TEXT, user_id TEXT, username TEXT, role TEXT);
CREATE TABLE herd_chat_messages (id INTEGER PRIMARY KEY, herd_id TEXT, user_id TEXT, message TEXT, sent_at TEXT, image_path TEXT);
