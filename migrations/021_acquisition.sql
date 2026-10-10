CREATE TABLE acquisition_leads (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  repo TEXT NOT NULL,
  attribution_json TEXT NOT NULL CHECK (json_valid(attribution_json)),
  created_at INTEGER NOT NULL,
  user_id TEXT REFERENCES users(id),
  contact_email TEXT,
  captured_at INTEGER
);
CREATE INDEX acquisition_leads_user ON acquisition_leads(user_id, created_at);
CREATE INDEX acquisition_leads_created ON acquisition_leads(created_at DESC, id DESC);
CREATE TRIGGER acquisition_lead_identity_immutable BEFORE UPDATE ON acquisition_leads
WHEN NEW.id IS NOT OLD.id OR NEW.token_hash IS NOT OLD.token_hash OR NEW.repo IS NOT OLD.repo OR
  NEW.attribution_json IS NOT OLD.attribution_json OR NEW.created_at IS NOT OLD.created_at OR
  (OLD.user_id IS NOT NULL AND NEW.user_id IS NOT OLD.user_id) OR
  (OLD.captured_at IS NOT NULL AND (NEW.captured_at IS NOT OLD.captured_at OR NEW.contact_email IS NOT OLD.contact_email))
BEGIN SELECT RAISE(ABORT, 'acquisition_lead_identity_is_immutable'); END;

CREATE TABLE acquisition_accounts (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  lead_id TEXT NOT NULL REFERENCES acquisition_leads(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX acquisition_accounts_lead ON acquisition_accounts(lead_id, user_id);
CREATE TRIGGER acquisition_accounts_no_update BEFORE UPDATE ON acquisition_accounts BEGIN SELECT RAISE(ABORT, 'acquisition_account_is_immutable'); END;
CREATE TRIGGER acquisition_accounts_no_delete BEFORE DELETE ON acquisition_accounts BEGIN SELECT RAISE(ABORT, 'acquisition_account_is_immutable'); END;

CREATE TABLE acquisition_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'repo.submitted','lead.captured','user.created','workspace.started','workload.activated',
    'preview.opened','developer.qualified','wallet.funded_paid','compute.consumed_paid','launch.failed'
  )),
  user_id TEXT,
  lead_id TEXT REFERENCES acquisition_leads(id),
  occurred_at INTEGER NOT NULL CHECK (occurred_at > 0),
  recorded_at INTEGER NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload))
);
CREATE INDEX acquisition_events_user_type ON acquisition_events(user_id, event_type, sequence);
CREATE INDEX acquisition_events_type_time ON acquisition_events(event_type, occurred_at, sequence);
CREATE INDEX acquisition_events_lead ON acquisition_events(lead_id, sequence);
CREATE TRIGGER acquisition_events_no_update BEFORE UPDATE ON acquisition_events BEGIN SELECT RAISE(ABORT, 'acquisition_events_are_append_only'); END;
CREATE TRIGGER acquisition_events_no_delete BEFORE DELETE ON acquisition_events BEGIN SELECT RAISE(ABORT, 'acquisition_events_are_append_only'); END;

CREATE TABLE acquisition_projection_accounts (
  user_id TEXT PRIMARY KEY,
  through_sequence INTEGER NOT NULL DEFAULT 0 CHECK (through_sequence >= 0)
);

CREATE TABLE acquisition_projection_scan (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  after_user_id TEXT NOT NULL DEFAULT ''
);
INSERT INTO acquisition_projection_scan(id,after_user_id) VALUES (1,'');

-- Account creation is a server-side event; clients cannot omit or forge it.
CREATE TRIGGER acquisition_user_created AFTER INSERT ON users
BEGIN
  INSERT INTO acquisition_events(event_key, event_type, user_id, occurred_at, recorded_at, payload)
  VALUES ('user.created:' || NEW.id, 'user.created', NEW.id,
    CAST((julianday(NEW.created_at) - 2440587.5) * 86400000 + 0.5 AS INTEGER),
    CAST((julianday('now') - 2440587.5) * 86400000 + 0.5 AS INTEGER), '{}');
END;

-- Managed launch and repeat-workload triggers are installed by migration 022.
