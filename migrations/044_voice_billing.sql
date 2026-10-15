-- Financial receipts deliberately survive call/account deletion.
CREATE TABLE voice_usage (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  model TEXT NOT NULL,
  reserved_micro_usd INTEGER NOT NULL,
  cost_micro_usd INTEGER,
  usage_json TEXT,
  status TEXT NOT NULL CHECK(status IN ('reserved','running','reported','settled','denied')),
  created_at INTEGER NOT NULL,
  reported_at INTEGER
);
CREATE INDEX voice_usage_pending ON voice_usage(status, created_at);
CREATE INDEX voice_usage_call ON voice_usage(call_id);
