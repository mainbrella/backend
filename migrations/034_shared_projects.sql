-- Projects own identity and hosting. A Builder workspace is an optional extension.
-- Keep app IDs stable so saved turns, Git bundles and bookmarked URLs still work.
ALTER TABLE build_apps ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX build_apps_project ON build_apps(project_id);

INSERT INTO projects (id, user_id, name, created_at)
  SELECT id, user_id, name, created_at FROM build_apps;
UPDATE build_apps SET project_id = id;

-- Cover every workspace creation path, including idempotent Builder submissions.
CREATE TRIGGER build_project_identity BEFORE INSERT ON build_apps
WHEN NEW.project_id IS NOT NULL AND (NEW.project_id != NEW.id OR NOT EXISTS (
  SELECT 1 FROM projects WHERE id = NEW.project_id AND user_id = NEW.user_id
))
BEGIN SELECT RAISE(ABORT, 'project_identity_conflict'); END;

CREATE TRIGGER build_project_create AFTER INSERT ON build_apps
BEGIN
  INSERT INTO projects (id, user_id, name, created_at)
    SELECT NEW.id, NEW.user_id, NEW.name, NEW.created_at WHERE NEW.project_id IS NULL;
  UPDATE build_apps SET project_id = NEW.id,
    name = (SELECT name FROM projects WHERE id = NEW.id) WHERE id = NEW.id;
END;

-- Retain the existing Builder name column for compatibility; both editors agree.
CREATE TRIGGER build_project_rename AFTER UPDATE OF name ON build_apps
WHEN NEW.name != OLD.name
BEGIN
  UPDATE projects SET name = NEW.name WHERE id = NEW.project_id AND user_id = NEW.user_id AND name != NEW.name;
END;
CREATE TRIGGER project_build_rename AFTER UPDATE OF name ON projects
WHEN NEW.name != OLD.name
BEGIN
  UPDATE build_apps SET name = NEW.name, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE project_id = NEW.id AND user_id = NEW.user_id AND name != NEW.name;
END;

-- Builder's existing delete action deletes the shared project as well.
CREATE TRIGGER build_project_delete AFTER DELETE ON build_apps
BEGIN DELETE FROM projects WHERE id = OLD.project_id AND user_id = OLD.user_id; END;
