-- Physical inventory and financial evidence outlive account/project deletion.
CREATE TABLE r2_accounts (
  user_id TEXT PRIMARY KEY,
  max_bytes INTEGER NOT NULL DEFAULT 10000000000,
  funded_through INTEGER,
  writes_blocked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE r2_objects (
  key TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('source','assets','history','diagnostics','platform')),
  size INTEGER NOT NULL CHECK(size >= 0),
  state TEXT NOT NULL CHECK(state IN ('pending','live')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX r2_objects_owner ON r2_objects(user_id,app_id,deleted_at);
CREATE TRIGGER r2_storage_limit BEFORE INSERT ON r2_objects WHEN NEW.state='pending' AND NEW.user_id <> 'mainbrella'
 AND COALESCE((SELECT SUM(size) FROM r2_objects WHERE user_id=NEW.user_id AND deleted_at IS NULL),0) + NEW.size
 > COALESCE((SELECT max_bytes FROM r2_accounts WHERE user_id=NEW.user_id),10000000000)
BEGIN SELECT RAISE(ABORT,'storage_limit_exceeded'); END;
CREATE TRIGGER r2_storage_limit_restore BEFORE UPDATE ON r2_objects WHEN NEW.state='pending' AND NEW.deleted_at IS NULL AND OLD.deleted_at IS NOT NULL AND NEW.user_id<>'mainbrella'
 AND COALESCE((SELECT SUM(size) FROM r2_objects WHERE user_id=NEW.user_id AND deleted_at IS NULL),0) + NEW.size
 > COALESCE((SELECT max_bytes FROM r2_accounts WHERE user_id=NEW.user_id),10000000000)
BEGIN SELECT RAISE(ABORT,'storage_limit_exceeded'); END;
CREATE TABLE r2_object_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  key TEXT NOT NULL,
  at INTEGER NOT NULL,
  delta INTEGER NOT NULL
);
CREATE INDEX r2_object_events_owner ON r2_object_events(user_id,app_id,at,sequence);
CREATE TRIGGER r2_object_insert AFTER INSERT ON r2_objects WHEN NEW.state='live' AND NEW.deleted_at IS NULL
BEGIN INSERT INTO r2_object_events(user_id,app_id,key,at,delta) VALUES(NEW.user_id,NEW.app_id,NEW.key,NEW.updated_at,NEW.size); END;
CREATE TRIGGER r2_object_live AFTER UPDATE ON r2_objects WHEN NEW.state='live' AND NEW.deleted_at IS NULL
 AND (OLD.state='pending' OR OLD.deleted_at IS NOT NULL)
BEGIN INSERT INTO r2_object_events(user_id,app_id,key,at,delta) VALUES(NEW.user_id,NEW.app_id,NEW.key,NEW.updated_at,NEW.size); END;
CREATE TRIGGER r2_object_deleted AFTER UPDATE ON r2_objects WHEN OLD.state='live' AND OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
BEGIN INSERT INTO r2_object_events(user_id,app_id,key,at,delta) VALUES(NEW.user_id,NEW.app_id,NEW.key,NEW.deleted_at,-NEW.size); END;
CREATE TABLE r2_operations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('put','get','head','list','delete')),
  category TEXT NOT NULL CHECK(category IN ('a','b','free')),
  started_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'attempted' CHECK(status IN ('attempted','completed','unknown'))
);
CREATE INDEX r2_operations_date ON r2_operations(started_at,user_id,app_id);
CREATE TABLE r2_daily_usage (
  day TEXT NOT NULL,
  user_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  peak_bytes INTEGER NOT NULL,
  class_a INTEGER NOT NULL,
  class_b INTEGER NOT NULL,
  markup_bps INTEGER NOT NULL,
  provider_nano_usd INTEGER NOT NULL,
  cost_nano_usd INTEGER NOT NULL,
  billable INTEGER NOT NULL,
  settled INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(day,user_id,app_id)
);
CREATE TABLE r2_receipts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  cost_nano_usd INTEGER NOT NULL,
  evidence TEXT NOT NULL CHECK(json_valid(evidence)),
  settled INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE r2_invoices (
  id TEXT PRIMARY KEY,
  month TEXT NOT NULL UNIQUE,
  evidence TEXT NOT NULL CHECK(json_valid(evidence)),
  created_at INTEGER NOT NULL
);
CREATE TABLE r2_meter_state (id TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE r2_project_locks (app_id TEXT PRIMARY KEY, token TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TRIGGER build_storage_cleanup_busy BEFORE INSERT ON build_turns WHEN
 EXISTS(SELECT 1 FROM r2_project_locks WHERE app_id=NEW.app_id AND expires_at>CAST(strftime('%s','now') AS INTEGER)*1000)
BEGIN SELECT RAISE(ABORT,'build_busy'); END;

DROP TRIGGER accounting_ledger_no_update;
DROP TRIGGER accounting_ledger_no_delete;
ALTER TABLE accounting_ledger RENAME TO accounting_ledger_previous;
CREATE TABLE accounting_ledger (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('funding','refund','stripe_balance','funding_state','compute','inference','storage','storage_adjustment','legacy_usage','wallet_checkpoint')),
  occurred_at INTEGER NOT NULL CHECK(occurred_at > 0),
  recorded_at INTEGER NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload))
);
INSERT INTO accounting_ledger SELECT * FROM accounting_ledger_previous;
DROP TABLE accounting_ledger_previous;
CREATE INDEX accounting_ledger_account ON accounting_ledger(user_id,sequence);
CREATE INDEX accounting_ledger_date ON accounting_ledger(occurred_at,sequence);
CREATE TRIGGER accounting_ledger_no_update BEFORE UPDATE ON accounting_ledger BEGIN SELECT RAISE(ABORT,'accounting_ledger_is_append_only'); END;
CREATE TRIGGER accounting_ledger_no_delete BEFORE DELETE ON accounting_ledger BEGIN SELECT RAISE(ABORT,'accounting_ledger_is_append_only'); END;
