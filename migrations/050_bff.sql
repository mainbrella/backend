-- BFF control plane only. Customer tables live in dedicated D1 databases.
CREATE TABLE bff_projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
  database_id TEXT UNIQUE,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','ready','error')),
  suspended INTEGER NOT NULL DEFAULT 0 CHECK(suspended IN (0,1)),
  blocked INTEGER NOT NULL DEFAULT 0 CHECK(blocked IN (0,1)),
  provision_lease TEXT,
  provision_until INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(user_id, name)
);
CREATE INDEX bff_projects_owner ON bff_projects(user_id, created_at);

CREATE TABLE bff_function_versions (
  project_id TEXT NOT NULL REFERENCES bff_projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 100),
  source TEXT NOT NULL,
  checksum TEXT NOT NULL,
  database_access TEXT NOT NULL CHECK(database_access IN ('none','read','write')),
  created_at TEXT NOT NULL,
  PRIMARY KEY(project_id, name, version)
);

CREATE TABLE bff_daily_usage (
  project_id TEXT NOT NULL REFERENCES bff_projects(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  queries INTEGER NOT NULL DEFAULT 0,
  invocations INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(project_id, day)
);

CREATE TABLE bff_executions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES bff_projects(id) ON DELETE CASCADE,
  function_name TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','success','error','timeout')),
  error TEXT,
  duration_ms INTEGER,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX bff_executions_project ON bff_executions(project_id, created_at DESC);
CREATE INDEX bff_executions_running ON bff_executions(project_id, status, expires_at);

-- Keep remote resource identifiers after account deletion cascades.
CREATE TABLE bff_database_deletions (
  project_id TEXT PRIMARY KEY,
  database_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER bff_project_deleted AFTER DELETE ON bff_projects
BEGIN
  INSERT OR IGNORE INTO bff_database_deletions(project_id,database_id)
  VALUES(OLD.id,OLD.database_id);
END;
