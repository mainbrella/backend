-- A user-requested storage deletion must finish before a new build can write.
-- The existing durable deletion queue also handles partial R2 failures.
CREATE TRIGGER build_turns_storage_cleanup_lock
BEFORE INSERT ON build_turns
WHEN EXISTS (SELECT 1 FROM build_git_deletions WHERE app_id = NEW.app_id)
BEGIN
  SELECT RAISE(ABORT, 'github_project_busy');
END;
