-- Tags are account-scoped aliases. Image IDs and published digests are immutable.
CREATE TABLE container_image_tags (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  image_id TEXT NOT NULL REFERENCES container_images(id) ON DELETE CASCADE,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, tag)
);
CREATE TRIGGER container_image_tag_admission BEFORE INSERT ON container_image_tags BEGIN
  SELECT RAISE(ABORT, 'image_tag_limit') WHERE
    NOT EXISTS (SELECT 1 FROM container_image_tags WHERE user_id = NEW.user_id AND tag = NEW.tag)
    AND (SELECT COUNT(*) FROM container_image_tags WHERE user_id = NEW.user_id) >= 30;
END;
CREATE TRIGGER container_image_tag_cleanup AFTER UPDATE OF status ON container_images
WHEN NEW.status != 'ready' BEGIN
  DELETE FROM container_image_tags WHERE image_id = NEW.id;
END;
