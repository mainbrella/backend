-- Build source lives independently of the disposable editing container.
CREATE TABLE build_apps (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  create_key TEXT NOT NULL,
  initial_prompt TEXT NOT NULL,
  name TEXT NOT NULL,
  source_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  active_turn_id TEXT,
  container_json TEXT,
  preview_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, create_key)
);
CREATE INDEX build_apps_owner ON build_apps(user_id, updated_at DESC);
CREATE TABLE build_turns (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES build_apps(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_key TEXT NOT NULL,
  prompt TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('build', 'preview')),
  base_revision INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'succeeded', 'failed')),
  stage TEXT NOT NULL,
  summary TEXT,
  error TEXT,
  log TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE(app_id, request_key)
);
-- An account cannot start concurrent agents, including from different tabs.
CREATE UNIQUE INDEX build_one_active_turn ON build_turns(user_id) WHERE status IN ('queued', 'running');
CREATE INDEX build_turns_app ON build_turns(app_id, created_at);
CREATE INDEX build_turns_usage ON build_turns(user_id, created_at);
CREATE TABLE build_revisions (
  app_id TEXT NOT NULL REFERENCES build_apps(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  turn_id TEXT NOT NULL UNIQUE,
  source_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(app_id, revision)
);
CREATE TRIGGER build_app_limit BEFORE INSERT ON build_apps WHEN
  (SELECT COUNT(*) FROM build_apps WHERE user_id = NEW.user_id) >= 50
BEGIN SELECT RAISE(ABORT, 'build_app_limit'); END;
CREATE TRIGGER build_daily_limit BEFORE INSERT ON build_turns WHEN
  (SELECT COUNT(*) FROM build_turns WHERE user_id = NEW.user_id AND created_at >= strftime('%Y-%m-%dT00:00:00.000Z', 'now')) >= 10
BEGIN SELECT RAISE(ABORT, 'build_daily_limit'); END;
CREATE TRIGGER build_turn_limit BEFORE INSERT ON build_turns WHEN
  (SELECT COUNT(*) FROM build_turns WHERE app_id = NEW.app_id) >= 100
BEGIN SELECT RAISE(ABORT, 'build_turn_limit'); END;
CREATE TRIGGER build_turn_busy BEFORE INSERT ON build_turns WHEN
  (SELECT active_turn_id FROM build_apps WHERE id = NEW.app_id) IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'build_busy'); END;
CREATE TRIGGER build_revision_conflict BEFORE INSERT ON build_turns WHEN
  (SELECT revision FROM build_apps WHERE id = NEW.app_id) != NEW.base_revision
BEGIN SELECT RAISE(ABORT, 'revision_conflict'); END;
