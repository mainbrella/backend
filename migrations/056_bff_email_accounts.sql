-- Project-local application accounts are separate from Mainbrella owner accounts
-- and from the project's public users table. Credentials never reach the Data API.
CREATE TABLE bff_email_accounts (
  project_id TEXT NOT NULL REFERENCES bff_projects(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  user_id TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  provisioned INTEGER NOT NULL DEFAULT 0 CHECK(provisioned IN (0,1)),
  created_at TEXT NOT NULL,
  PRIMARY KEY(project_id, email),
  UNIQUE(project_id, user_id)
);
