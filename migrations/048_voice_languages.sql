ALTER TABLE voice_agents ADD COLUMN model TEXT NOT NULL DEFAULT 'aura-1'
  CHECK (model IN ('aura-1', 'aura-2', 'aura-2-gateway', 'sonic-3.6'));
ALTER TABLE voice_agents ADD COLUMN language TEXT NOT NULL DEFAULT 'en'
  CHECK (language IN ('en', 'es', 'fr', 'de', 'hi', 'ru', 'pt', 'ja', 'it', 'nl'));
