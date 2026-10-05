-- Codes are stored as SHA-256 hashes of trimmed uppercase values.
CREATE TABLE trial_coupons (
  code_hash TEXT PRIMARY KEY,
  plan TEXT NOT NULL CHECK (plan IN ('builder', 'pro', 'scale')),
  trial_days INTEGER NOT NULL CHECK (trial_days BETWEEN 1 AND 90),
  expires_at INTEGER NOT NULL,
  max_redemptions INTEGER NOT NULL CHECK (max_redemptions > 0),
  redeemed_count INTEGER NOT NULL DEFAULT 0 CHECK (redeemed_count >= 0 AND redeemed_count <= max_redemptions),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
);
CREATE TABLE trial_redemptions (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL REFERENCES trial_coupons(code_hash),
  plan TEXT NOT NULL CHECK (plan IN ('builder', 'pro', 'scale')),
  redeemed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX trial_redemptions_code ON trial_redemptions(code_hash);

-- Historical uses are retained even if an account is later deleted.
CREATE TRIGGER trial_coupon_redeemed AFTER INSERT ON trial_redemptions
BEGIN
  UPDATE trial_coupons SET redeemed_count = redeemed_count + 1 WHERE code_hash = NEW.code_hash;
END;
