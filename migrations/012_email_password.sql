-- Password credentials are optional; existing provider accounts keep their login method.
ALTER TABLE users ADD COLUMN password_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_users_normalized_email ON users(lower(email));
