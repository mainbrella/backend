-- Reserve five of the 100 named image slots for the maintained catalog.
-- Existing rows are retained; admission resumes once private usage is below 95.
CREATE TRIGGER IF NOT EXISTS container_image_catalog_capacity BEFORE INSERT ON container_images BEGIN
  SELECT RAISE(ABORT, 'image_service_capacity') WHERE
    (SELECT COUNT(*) FROM container_images WHERE status IN ('queued', 'building', 'publishing', 'ready')) >= 95;
END;
