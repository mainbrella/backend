CREATE TABLE project_domains (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  hostname TEXT NOT NULL,
  challenge TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_dns' CHECK(status IN ('pending_dns', 'pending_tls', 'active', 'error')),
  dns_status TEXT NOT NULL DEFAULT 'pending' CHECK(dns_status IN ('pending', 'verified')),
  tls_status TEXT NOT NULL DEFAULT 'pending' CHECK(tls_status IN ('pending', 'active', 'error')),
  provider TEXT CHECK(provider IS NULL OR provider IN ('cloudflare', 'ingress')),
  provider_id TEXT,
  error TEXT,
  operation_revision TEXT,
  operation_started_at INTEGER,
  removing INTEGER NOT NULL DEFAULT 0 CHECK(removing IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE(project_id, hostname)
);
CREATE INDEX project_domains_project ON project_domains(project_id);
