-- Existing issued tokens belong to the original account slot.
ALTER TABLE ssh_access_tokens ADD COLUMN container_id TEXT NOT NULL DEFAULT 'small';
