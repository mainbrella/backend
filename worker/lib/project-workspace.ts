export const projectColumns = `SELECT p.id, p.name, p.domain, p.created_at, a.id AS build_app_id,
  a.git_version_id, p.github_repo, p.github_branch, p.github_commit_id,
  CASE WHEN p.github_repo IS NULL THEN NULL
    WHEN EXISTS(SELECT 1 FROM build_git_deletions WHERE app_id=a.id) THEN 'deleting'
    WHEN json_extract(a.source_json,'$."$github"') IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM r2_objects WHERE app_id=a.id AND user_id=p.user_id AND deleted_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM build_images WHERE app_id=a.id)
      AND NOT EXISTS(SELECT 1 FROM build_operations WHERE turn_id IN(SELECT id FROM build_turns WHERE app_id=a.id)
        AND (source_json IS NOT NULL OR json_type(result_json,'$."$r2"')='text'))
      THEN 'github' ELSE 'retained' END AS github_storage
  FROM projects p LEFT JOIN build_apps a ON a.project_id = p.id AND a.user_id = p.user_id`;

// Enabling history creates an idle source workspace. Builds and storage writes
// still go through Builder's existing funding, concurrency and retention checks.
export function gitWorkspace(env: Env, userId: string, id: string) {
  return env.DB.prepare(`INSERT INTO build_apps
    (id, project_id, user_id, create_key, initial_prompt, name, source_json, created_at, updated_at)
    SELECT p.id, p.id, p.user_id, 'project:' || p.id, '', p.name, '{}', p.created_at, ? FROM projects p
    WHERE p.id = ? AND p.user_id = ? AND NOT EXISTS (SELECT 1 FROM build_apps WHERE project_id = p.id)`)
    .bind(new Date().toISOString(), id, userId);
}

