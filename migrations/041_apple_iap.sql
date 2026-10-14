-- App account tokens bind Apple purchases to the signed-in Mainbrella account.
CREATE TABLE apple_iap_accounts (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  app_account_token TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

-- Retain purchase evidence after account deletion and pin the original net credit.
-- Environment is part of the identity: Xcode transaction IDs restart at 0.
CREATE TABLE apple_iap_transactions (
  environment TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  app_account_token TEXT NOT NULL,
  product_id TEXT NOT NULL,
  storefront TEXT NOT NULL,
  currency TEXT NOT NULL,
  price_milliunits INTEGER NOT NULL,
  credit_cents INTEGER NOT NULL CHECK (credit_cents > 0),
  proceeds_policy TEXT NOT NULL CHECK (json_valid(proceeds_policy)),
  purchase_at INTEGER NOT NULL,
  refunded_cents INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (environment, transaction_id),
  CHECK (refunded_cents >= 0 AND refunded_cents <= credit_cents)
);
CREATE INDEX apple_iap_transactions_user ON apple_iap_transactions(user_id);
