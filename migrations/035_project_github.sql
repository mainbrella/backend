ALTER TABLE projects ADD COLUMN github_repo TEXT;
ALTER TABLE projects ADD COLUMN github_branch TEXT;
ALTER TABLE projects ADD COLUMN github_commit_id TEXT;
ALTER TABLE projects ADD COLUMN github_link_lock TEXT;
ALTER TABLE projects ADD COLUMN github_link_until INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN github_paths_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE projects ADD COLUMN github_cleanup_pending INTEGER NOT NULL DEFAULT 0;
ALTER TABLE build_apps ADD COLUMN github_verified_commit_id TEXT;

CREATE TABLE github_build_connections (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  github_user_id TEXT NOT NULL,
  github_login TEXT NOT NULL,
  credentials TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  refresh_lock TEXT,
  refresh_until INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE github_build_states (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  repo TEXT NOT NULL,
  branch TEXT NOT NULL,
  return_origin TEXT NOT NULL,
  return_path TEXT NOT NULL,
  verifier TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('authorize', 'install')),
  expires_at INTEGER NOT NULL
);
CREATE INDEX github_build_states_expiry ON github_build_states(expires_at);

CREATE TRIGGER build_turns_github_link_lock
BEFORE INSERT ON build_turns
WHEN EXISTS (SELECT 1 FROM build_apps a JOIN projects p ON p.id = a.project_id AND p.user_id = a.user_id
             WHERE a.id = NEW.app_id AND p.github_link_lock IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'github_project_busy');
END;

CREATE TRIGGER build_apps_github_link_delete_lock
BEFORE DELETE ON build_apps
WHEN EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id AND user_id = OLD.user_id AND github_link_lock IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'github_project_busy');
END;
