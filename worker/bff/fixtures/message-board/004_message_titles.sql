ALTER TABLE messages
ADD COLUMN title TEXT NOT NULL DEFAULT 'Untitled'
CHECK(length(trim(title)) BETWEEN 1 AND 200);

UPDATE messages
SET title = substr(trim(body), 1, 200);
