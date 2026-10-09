-- Preserve existing purchases while widening the checked plan column.
CREATE TABLE pro_billing_usage (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  stripe_customer_id TEXT NOT NULL UNIQUE,
  checkout_session_id TEXT,
  plan TEXT CHECK (plan IN ('usage', 'builder', 'pro', 'scale')),
  stripe_subscription_id TEXT,
  subscription_status TEXT,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  current_period_end INTEGER,
  synced_at TEXT
);
INSERT INTO pro_billing_usage SELECT user_id, stripe_customer_id, checkout_session_id,
  plan, stripe_subscription_id, subscription_status, cancel_at_period_end, current_period_end, synced_at FROM pro_billing;
DROP TABLE pro_billing;
ALTER TABLE pro_billing_usage RENAME TO pro_billing;
