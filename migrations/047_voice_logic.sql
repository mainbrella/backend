ALTER TABLE voice_agents
  ADD COLUMN voice_logic TEXT NOT NULL DEFAULT 'original_no_reply'
  CHECK (voice_logic IN ('original_no_reply', 'reply_right_away'));
