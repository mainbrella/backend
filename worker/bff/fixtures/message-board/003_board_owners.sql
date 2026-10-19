ALTER TABLE boards ADD COLUMN user_id TEXT REFERENCES users(id);
CREATE INDEX boards_user ON boards(user_id);
