-- Registrar ownership survives project disconnection/deletion. Never cascade a purchase.
CREATE TABLE domain_registrations (
  domain_name TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  expire_date TEXT NOT NULL,
  auto_renew INTEGER NOT NULL DEFAULT 0,
  renewal_cents INTEGER NOT NULL,
  payment_method_id TEXT,
  customer_id TEXT NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX domain_registration_owner ON domain_registrations(user_id);
CREATE TABLE domain_orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  domain_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('registration','renewal')),
  years INTEGER NOT NULL,
  cost_cents INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  renewal_cents INTEGER NOT NULL,
  premium INTEGER NOT NULL,
  auto_renew INTEGER NOT NULL DEFAULT 0,
  contact_json TEXT,
  terms_accepted_at INTEGER,
  customer_id TEXT,
  checkout_id TEXT UNIQUE,
  payment_intent_id TEXT UNIQUE,
  refund_id TEXT,
  status TEXT NOT NULL DEFAULT 'quoted',
  error TEXT,
  provider_order TEXT,
  dns_revision TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  last_checked_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX domain_order_pending ON domain_orders(domain_name)
  WHERE status IN ('checkout','charging','paid','fulfilling','registered','connecting','refunding','review');
CREATE INDEX domain_order_owner ON domain_orders(user_id,created_at);
