-- Save successful reconciliations only. Stripe retries failed deliveries.
CREATE TABLE billing_webhook_events (
  event_id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  processed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Serialize account billing mutations, including competing checkout plans.
-- A lease recovers safely after a worker is interrupted; Stripe requests also
-- use idempotency keys to recover unknown purchase outcomes.
CREATE TABLE billing_operation_locks (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  lock_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
