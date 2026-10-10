-- Original image assets survive sandbox expiry and are removed with their app.
CREATE TABLE build_images (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES build_apps(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL REFERENCES build_turns(id) ON DELETE CASCADE,
  tool_id TEXT NOT NULL,
  label TEXT NOT NULL,
  prompt TEXT NOT NULL,
  data TEXT NOT NULL,
  UNIQUE(turn_id, tool_id)
);
CREATE INDEX build_images_app ON build_images(app_id);
