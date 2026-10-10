-- Accounting evidence deliberately has no cascading user foreign key. Account
-- deletion must not destroy the books. Corrections are new events / close revisions.
CREATE TABLE accounting_ledger (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('funding','refund','stripe_balance','funding_state','compute','legacy_usage','wallet_checkpoint')),
  occurred_at INTEGER NOT NULL CHECK (occurred_at > 0),
  recorded_at INTEGER NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload))
);
CREATE INDEX accounting_ledger_account ON accounting_ledger(user_id, sequence);
CREATE INDEX accounting_ledger_date ON accounting_ledger(occurred_at, sequence);
CREATE TRIGGER accounting_ledger_no_update BEFORE UPDATE ON accounting_ledger BEGIN SELECT RAISE(ABORT, 'accounting_ledger_is_append_only'); END;
CREATE TRIGGER accounting_ledger_no_delete BEFORE DELETE ON accounting_ledger BEGIN SELECT RAISE(ABORT, 'accounting_ledger_is_append_only'); END;

CREATE TABLE accounting_policies (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('cash_receipts','section_451c')),
  receipt_timezone TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  evidence_reference TEXT NOT NULL
);
CREATE TRIGGER accounting_policies_no_update BEFORE UPDATE ON accounting_policies BEGIN SELECT RAISE(ABORT, 'accounting_policy_is_append_only'); END;
CREATE TRIGGER accounting_policies_no_delete BEFORE DELETE ON accounting_policies BEGIN SELECT RAISE(ABORT, 'accounting_policy_is_append_only'); END;

CREATE TABLE accounting_closes (
  id TEXT PRIMARY KEY,
  month TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  ledger_sequence INTEGER NOT NULL,
  policy_id TEXT REFERENCES accounting_policies(id),
  report TEXT NOT NULL CHECK (json_valid(report))
);
CREATE INDEX accounting_closes_month ON accounting_closes(month, created_at);
CREATE TRIGGER accounting_closes_no_update BEFORE UPDATE ON accounting_closes BEGIN SELECT RAISE(ABORT, 'accounting_close_is_append_only'); END;
CREATE TRIGGER accounting_closes_no_delete BEFORE DELETE ON accounting_closes BEGIN SELECT RAISE(ABORT, 'accounting_close_is_append_only'); END;
