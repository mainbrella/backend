// Prepared statements run in the host's fenced, atomic storage-expiration batch.
export function buildStorageExpiration(env: Env, userId: string, guard: string, args: (string | number)[]): D1PreparedStatement[] {
  return [
    env.DB.prepare(`INSERT INTO build_git_deletions(app_id,user_id,created_at) SELECT id,user_id,? FROM build_apps WHERE user_id=? AND ${guard} ON CONFLICT(app_id) DO NOTHING`)
      .bind(new Date().toISOString(), userId, ...args),
    env.DB.prepare(`UPDATE build_turns SET status='failed',error='storage_retention_expired',finished_at=? WHERE user_id=? AND status IN ('queued','running') AND ${guard}`)
      .bind(new Date().toISOString(), userId, ...args),
    env.DB.prepare(`UPDATE build_operations SET source_json=NULL,result_json=NULL WHERE turn_id IN(SELECT id FROM build_turns WHERE user_id=?) AND ${guard}`).bind(userId, ...args),
    ...['build_git_versions', 'build_revisions', 'build_images'].map(table => env.DB.prepare(`DELETE FROM ${table} WHERE app_id IN(SELECT id FROM build_apps WHERE user_id=?) AND ${guard}`).bind(userId, ...args)),
    env.DB.prepare(`UPDATE build_apps SET source_json=CASE WHEN json_type(source_json,'$."$github"')='text' THEN source_json ELSE '{}' END,
      git_version_id=NULL,verified_git_version_id=NULL,active_turn_id=NULL WHERE user_id=? AND ${guard}`).bind(userId, ...args),
  ];
}
