ALTER TABLE users ADD COLUMN marketing_email_unsubscribed INTEGER NOT NULL DEFAULT 0
  CHECK (marketing_email_unsubscribed IN (0, 1));

CREATE INDEX idx_users_marketing_email_unsubscribed
  ON users(lower(trim(email))) WHERE marketing_email_unsubscribed = 1;

-- Marketing recipients may not have an account. Keep their opt-out by address.
CREATE TABLE marketing_email_unsubscribes (
  email TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
