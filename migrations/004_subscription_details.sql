-- Stripe remains the source of truth; these fields sync on checkout completion
-- and subscription status requests. A plan alone does not indicate paid access.
ALTER TABLE pro_billing ADD COLUMN plan TEXT CHECK (plan IN ('builder', 'pro', 'scale'));
ALTER TABLE pro_billing ADD COLUMN stripe_subscription_id TEXT;
ALTER TABLE pro_billing ADD COLUMN subscription_status TEXT;
ALTER TABLE pro_billing ADD COLUMN cancel_at_period_end INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pro_billing ADD COLUMN current_period_end INTEGER;
ALTER TABLE pro_billing ADD COLUMN synced_at TEXT;
