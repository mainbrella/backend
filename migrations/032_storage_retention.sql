ALTER TABLE r2_accounts ADD COLUMN blocked_since INTEGER;
ALTER TABLE r2_accounts ADD COLUMN delete_after INTEGER;
ALTER TABLE r2_accounts ADD COLUMN warned_at INTEGER;
ALTER TABLE r2_accounts ADD COLUMN email_warned_at INTEGER;
ALTER TABLE r2_accounts ADD COLUMN reminder_seven_at INTEGER;
ALTER TABLE r2_accounts ADD COLUMN reminder_one_at INTEGER;
ALTER TABLE r2_accounts ADD COLUMN expired_at INTEGER;
ALTER TABLE r2_accounts ADD COLUMN expiration_token TEXT;

CREATE TABLE r2_rate_windows (
  scope TEXT NOT NULL,
  window INTEGER NOT NULL,
  requests INTEGER NOT NULL,
  PRIMARY KEY(scope, window)
);
CREATE TABLE r2_export_leases (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX r2_export_lease_owner ON r2_export_leases(user_id, expires_at);

-- Physical growth is bounded across accounts, including simultaneous writers.
CREATE TRIGGER r2_platform_limit BEFORE INSERT ON r2_objects WHEN NEW.state='pending'
 AND COALESCE((SELECT SUM(size) FROM r2_objects WHERE deleted_at IS NULL),0) + NEW.size
 > CAST(COALESCE((SELECT value FROM r2_meter_state WHERE id='platform_max_bytes'),'1000000000000') AS INTEGER)
BEGIN SELECT RAISE(ABORT,'storage_platform_limit_exceeded'); END;
CREATE TRIGGER r2_platform_limit_restore BEFORE UPDATE ON r2_objects WHEN NEW.state='pending'
 AND NEW.deleted_at IS NULL AND OLD.deleted_at IS NOT NULL
 AND COALESCE((SELECT SUM(size) FROM r2_objects WHERE deleted_at IS NULL),0) + NEW.size
 > CAST(COALESCE((SELECT value FROM r2_meter_state WHERE id='platform_max_bytes'),'1000000000000') AS INTEGER)
BEGIN SELECT RAISE(ABORT,'storage_platform_limit_exceeded'); END;
