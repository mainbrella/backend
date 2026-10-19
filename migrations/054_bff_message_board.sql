-- Existing projects keep their schema. Only newly created projects get a starter.
ALTER TABLE bff_projects ADD COLUMN template TEXT CHECK(template IN ('message_board','empty'));
ALTER TABLE bff_table_policies ADD COLUMN insert_access TEXT NOT NULL DEFAULT 'none' CHECK(insert_access IN ('none','own'));
ALTER TABLE bff_table_policies ADD COLUMN update_access TEXT NOT NULL DEFAULT 'none' CHECK(update_access IN ('none','own'));
ALTER TABLE bff_table_policies ADD COLUMN delete_access TEXT NOT NULL DEFAULT 'none' CHECK(delete_access IN ('none','own'));
ALTER TABLE bff_table_policies ADD COLUMN owner_column TEXT;

-- Sessions are issued by the project owner for a project-local users row.
-- Browser keys still supply the project, origin, and operation grants.
CREATE TABLE bff_user_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES bff_projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX bff_user_sessions_project ON bff_user_sessions(project_id, expires_at);
