import { databaseAvailable, ProjectDatabase } from './database';

export async function cleanupBffDatabases(env: Env): Promise<void> {
  if (!databaseAvailable(env)) return;
  // Allow a provisioning request that was already in flight to settle. Pending
  // records without a UUID can then be recovered by deterministic database name.
  const cutoff = new Date(Date.now() - 120_000).toISOString();
  const pending = await env.DB.prepare('SELECT project_id,database_id FROM bff_database_deletions WHERE created_at<? ORDER BY created_at LIMIT 10')
    .bind(cutoff).all<{ project_id: string; database_id: string | null }>();
  const results = await Promise.allSettled(pending.results.map(async record => {
    await new ProjectDatabase(env, { id: record.project_id, database_id: record.database_id }).remove();
    await env.DB.prepare('DELETE FROM bff_database_deletions WHERE project_id=?').bind(record.project_id).run();
  }));
  if (results.some(result => result.status === 'rejected')) console.error('bff_database_cleanup_retry');
}
