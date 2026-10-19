-- Extend the append-only ledger's event types without changing its identities.
DROP TRIGGER accounting_ledger_no_update;
DROP TRIGGER accounting_ledger_no_delete;
ALTER TABLE accounting_ledger RENAME TO accounting_ledger_previous;
CREATE TABLE accounting_ledger (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('funding','refund','stripe_balance','funding_state','compute','inference','usage','storage','storage_adjustment','legacy_usage','wallet_checkpoint')),
  occurred_at INTEGER NOT NULL CHECK(occurred_at > 0),
  recorded_at INTEGER NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload))
);
INSERT INTO accounting_ledger SELECT * FROM accounting_ledger_previous;
DROP TABLE accounting_ledger_previous;
CREATE INDEX accounting_ledger_account ON accounting_ledger(user_id, sequence);
CREATE INDEX accounting_ledger_date ON accounting_ledger(occurred_at, sequence);
CREATE TRIGGER accounting_ledger_no_update BEFORE UPDATE ON accounting_ledger BEGIN SELECT RAISE(ABORT, 'accounting_ledger_is_append_only'); END;
CREATE TRIGGER accounting_ledger_no_delete BEFORE DELETE ON accounting_ledger BEGIN SELECT RAISE(ABORT, 'accounting_ledger_is_append_only'); END;
