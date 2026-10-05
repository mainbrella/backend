CREATE TABLE container_images (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'building', 'publishing', 'ready', 'failed', 'deleted')),
  dockerfile TEXT NOT NULL,
  context_base64 TEXT,
  image_key TEXT NOT NULL UNIQUE,
  image_ref TEXT,
  logs TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deadline TEXT NOT NULL,
  month TEXT NOT NULL
);
CREATE INDEX container_images_owner ON container_images(user_id, created_at);
CREATE TABLE container_image_usage (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  builds INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, month)
);

-- Admission and reservation are atomic, including simultaneous API requests.
-- All users currently resolve to Builder. Keep these limits aligned with images.ts.
CREATE TRIGGER container_image_admission BEFORE INSERT ON container_images BEGIN
  SELECT CASE WHEN (SELECT COUNT(*) FROM container_images WHERE user_id = NEW.user_id AND status IN ('queued', 'building', 'publishing')) >= 1
    THEN RAISE(ABORT, 'image_build_in_progress') END;
  SELECT CASE WHEN (SELECT COALESCE(builds, 0) FROM container_image_usage WHERE user_id = NEW.user_id AND month = NEW.month) >= 10
    THEN RAISE(ABORT, 'image_build_quota_exceeded') END;
  SELECT CASE WHEN (SELECT COUNT(*) FROM container_images WHERE user_id = NEW.user_id AND status IN ('queued', 'building', 'publishing', 'ready')) >= 3
    THEN RAISE(ABORT, 'image_storage_limit') END;
  SELECT CASE WHEN (SELECT COUNT(*) FROM container_images WHERE status IN ('queued', 'building', 'publishing', 'ready')) >= 99
    THEN RAISE(ABORT, 'image_service_capacity') END;
END;
CREATE TRIGGER container_image_reservation AFTER INSERT ON container_images BEGIN
  INSERT INTO container_image_usage (user_id, month, builds) VALUES (NEW.user_id, NEW.month, 1)
    ON CONFLICT(user_id, month) DO UPDATE SET builds = builds + 1;
END;
