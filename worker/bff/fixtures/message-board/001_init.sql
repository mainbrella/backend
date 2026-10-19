CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 80),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL CHECK(length(trim(body)) BETWEEN 1 AND 2000),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX messages_user ON messages(user_id);
CREATE INDEX messages_created ON messages(created_at);
INSERT INTO users(id,name) VALUES('alice','Alice'),('bob','Bob');
INSERT INTO messages(id,user_id,body) VALUES
  ('welcome','alice','Welcome to the message board! Everyone can read messages. Try editing this as Alice.'),
  ('reply','bob','Hi Alice! Switch to Bob to edit or delete this message. Each user can only change their own posts.');
