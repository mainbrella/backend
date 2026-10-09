ALTER TABLE projects
  ADD COLUMN domain TEXT CHECK (domain IS NULL OR length(domain) <= 253);
