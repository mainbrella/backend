-- Stripe collects one-time funding; compute balances live in the account DO.
CREATE TABLE prepaid_accounts (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  stripe_customer_id TEXT NOT NULL UNIQUE,
  payment_method_id TEXT,
  latest_payment_intent_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE prepaid_customer_requests (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
-- Persist the immutable request before Checkout. A lost Stripe response can be
-- recovered by metadata without relying on Stripe's expiring idempotency keys.
CREATE TABLE prepaid_topups (
  request_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stripe_customer_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents BETWEEN 500 AND 100000),
  checkout_session_id TEXT UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE INDEX prepaid_topups_user ON prepaid_topups(user_id, created_at);
