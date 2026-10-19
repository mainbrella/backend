CREATE TABLE boards (
  id TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(16)))),
  slug TEXT NOT NULL UNIQUE CHECK(
    length(slug) BETWEEN 1 AND 80
    AND slug NOT GLOB '*[^a-z0-9-]*'
    AND slug NOT GLOB '-*'
    AND slug NOT GLOB '*-'
  ),
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 80),
  description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 2000),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO boards(id,slug,name,description)
VALUES('general','general','General','General discussion.');

-- Preserve existing messages in General; new messages must specify a board.
-- Rebuild the table so board_id can be both NOT NULL and a foreign key.
CREATE TABLE messages_with_boards (
  id TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(16)))),
  board_id TEXT NOT NULL REFERENCES boards(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL CHECK(length(trim(body)) BETWEEN 1 AND 2000),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO messages_with_boards(id,board_id,user_id,body,created_at)
SELECT id,'general',user_id,body,created_at FROM messages;
DROP TABLE messages;
ALTER TABLE messages_with_boards RENAME TO messages;
CREATE INDEX messages_user ON messages(user_id);
CREATE INDEX messages_created ON messages(created_at);
CREATE INDEX messages_board_created ON messages(board_id,created_at);
