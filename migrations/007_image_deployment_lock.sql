-- Serialize every generated image-map deployment, including deletions and local releases.
CREATE TABLE IF NOT EXISTS container_image_deployment_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  token TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
