ALTER TABLE build_apps ADD COLUMN git_version_id TEXT;
ALTER TABLE build_apps ADD COLUMN verified_git_version_id TEXT;
ALTER TABLE build_turns ADD COLUMN restore_version_id TEXT;
CREATE TABLE build_git_versions (
  id TEXT PRIMARY KEY REFERENCES build_turns(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL REFERENCES build_apps(id) ON DELETE CASCADE,
  parent_version_id TEXT,
  commit_id TEXT NOT NULL,
  bundle_key TEXT NOT NULL,
  source_json TEXT NOT NULL,
  lockfile TEXT,
  assets_json TEXT NOT NULL,
  message TEXT NOT NULL,
  verified INTEGER NOT NULL CHECK(verified IN (0,1)),
  created_at TEXT NOT NULL
);
CREATE INDEX build_git_versions_app ON build_git_versions(app_id, created_at, id);
CREATE TRIGGER build_git_head_conflict BEFORE INSERT ON build_git_versions WHEN
  NOT EXISTS (SELECT 1 FROM build_apps WHERE id = NEW.app_id AND active_turn_id = NEW.id
    AND git_version_id IS NEW.parent_version_id)
BEGIN SELECT RAISE(ABORT, 'git_head_conflict'); END;
CREATE TABLE build_git_deletions (
  app_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
