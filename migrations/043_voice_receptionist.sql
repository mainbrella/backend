CREATE TABLE IF NOT EXISTS voice_agents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  business_name TEXT NOT NULL,
  greeting TEXT NOT NULL,
  instructions TEXT NOT NULL,
  voice TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS voice_calls (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES voice_agents(id),
  channel TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  started_at TEXT NOT NULL,
  ended_at TEXT,
  transcript_json TEXT NOT NULL DEFAULT '[]',
  config_json TEXT NOT NULL,
  provider_call_id TEXT UNIQUE,
  media_token_hash TEXT,
  media_token_expires_at TEXT,
  connected_at TEXT
);

CREATE INDEX IF NOT EXISTS voice_calls_user_started
  ON voice_calls(user_id, started_at DESC);
