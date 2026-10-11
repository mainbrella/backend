-- Credentials are encrypted with owner/build-bound authenticated encryption and
-- consumed once by the trusted preparation job. Cache references are resolved
-- from an owned ready image at admission; callers cannot submit registry URLs.
ALTER TABLE container_images ADD COLUMN base_image TEXT;
ALTER TABLE container_images ADD COLUMN registry_credentials TEXT;
ALTER TABLE container_images ADD COLUMN cache_image_id TEXT;
ALTER TABLE container_images ADD COLUMN cache_image_ref TEXT;
