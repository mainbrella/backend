-- Anonymous table access is denied unless the owner explicitly allows SELECT.
-- These policies apply to direct Data API queries and function capabilities.
CREATE TABLE bff_table_policies (
  project_id TEXT NOT NULL REFERENCES bff_projects(id) ON DELETE CASCADE,
  table_name TEXT NOT NULL,
  select_access TEXT NOT NULL CHECK(select_access IN ('none','public')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id, table_name)
);
