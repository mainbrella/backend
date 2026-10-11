import { authCorsHeaders, authJson, currentUser, readJSON } from './auth-core';
import { BUILD_MAX_APPS, BuildError } from '../lib/build-contract';
import { repoName } from '../lib/repo-launch';
import { githubBuildUserToken, validGithubBranch } from '../lib/github-build';
import { checkGithubWriteAccess, githubProject, publicGithubProject, migrateGithubProject, cleanupGithubHostedHistory } from '../lib/build-github';

export async function handleProjectGithubRequest(request: Request, env: Env): Promise<Response> {
  const cors = authCorsHeaders(request);
  if (cors === null) return authJson({ error: 'origin_not_allowed' }, 403, {});
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (!['GET', 'PUT'].includes(request.method)) return authJson({ error: 'method_not_allowed' }, 405, { ...cors, allow: 'GET, PUT, OPTIONS' });
  if (request.method === 'PUT' && !request.headers.get('Origin')) return authJson({ error: 'origin_required' }, 403, cors);
  const query = new URL(request.url).searchParams;
  const id = query.get('id');
  if (!id || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)
    || [...query.keys()].some(key => key !== 'id') || query.getAll('id').length !== 1) return authJson({ error: 'invalid_request' }, 400, cors);
  let lock: string | null = null, userId: string | undefined;
  try {
    const user = await currentUser(env, request);
    if (!user) return authJson({ error: 'not_authenticated' }, 401, cors);
    userId = user.id;
    const project = await githubProject(env, user.id, id);
    if (!project) return authJson({ error: 'not_found' }, 404, cors);
    if (request.method === 'GET') return authJson({ github: publicGithubProject(project) }, 200, cors);
    const body = await readJSON(request, 4096);
    const repo = repoName.safeParse(body?.repo);
    if (!body || Object.keys(body).some(key => !['repo', 'branch'].includes(key)) || !repo.success || body.branch !== undefined && !validGithubBranch(body.branch)) throw new BuildError('invalid_request', 400);
    const branch = body.branch ?? 'main';
    // An existing link can only be reauthorized, never silently repointed.
    if (project.github_repo) {
      if (project.github_repo.toLowerCase() !== repo.data.toLowerCase() || project.github_branch !== branch) throw new BuildError('github_already_linked', 409);
      const token = await githubBuildUserToken(env, user.id);
      await checkGithubWriteAccess(repo.data, token);
      return authJson({ github: publicGithubProject(project) }, 200, cors);
    }
    const token = await githubBuildUserToken(env, user.id);
    await checkGithubWriteAccess(repo.data, token);
    lock = crypto.randomUUID();
    const claimed = await env.DB.prepare(`UPDATE projects SET github_link_lock=?,github_link_until=? WHERE id=? AND user_id=? AND github_repo IS NULL
      AND (github_link_lock IS NULL OR github_link_until<?) AND NOT EXISTS(SELECT 1 FROM build_apps WHERE project_id=? AND active_turn_id IS NOT NULL)`)
      .bind(lock, Date.now() + 10 * 60_000, id, user.id, Date.now(), id).run();
    if (!claimed.meta.changes) throw new BuildError('github_project_busy', 409);
    const app = await env.DB.prepare('SELECT id,source_json,git_version_id FROM build_apps WHERE project_id=? AND user_id=?').bind(id, user.id)
      .first<{ id: string; source_json: string; git_version_id: string | null }>();
    if (!app) {
      const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM build_apps WHERE user_id=?').bind(user.id).first<{ count: number }>();
      if ((count?.count ?? 0) >= BUILD_MAX_APPS) throw new BuildError('build_app_limit', 429);
    }
    const result = await migrateGithubProject(env, project, app ?? { id, source_json: '{}' }, repo.data, branch, token);
    // Transfer and verify first. Atomically disable the hosted head afterwards.
    // A lost response is safe to retry: GitHub is already at the original SHA.
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO build_apps(id,project_id,user_id,create_key,initial_prompt,name,source_json,created_at,updated_at)
        SELECT id,id,user_id,'project:' || id,'',name,?,created_at,? FROM projects WHERE id=? AND user_id=? AND github_link_lock=?
        AND NOT EXISTS(SELECT 1 FROM build_apps WHERE project_id=?)`)
        .bind(JSON.stringify(result.files), now, id, user.id, lock, id),
      env.DB.prepare(`UPDATE build_apps SET git_version_id=NULL,verified_git_version_id=NULL,source_json=?,updated_at=?
        WHERE project_id=? AND user_id=? AND EXISTS(SELECT 1 FROM projects WHERE id=? AND github_link_lock=?)`)
        .bind(JSON.stringify(result.files), now, id, user.id, id, lock),
      env.DB.prepare(`DELETE FROM build_git_versions WHERE app_id=? AND EXISTS(SELECT 1 FROM projects WHERE id=? AND user_id=? AND github_link_lock=?)`)
        .bind(id, id, user.id, lock),
      env.DB.prepare(`UPDATE projects SET github_repo=?,github_branch=?,github_commit_id=?,github_paths_json=?,github_cleanup_pending=1,
        github_link_lock=NULL,github_link_until=0 WHERE id=? AND user_id=? AND github_link_lock=? AND github_repo IS NULL`)
        .bind(repo.data, branch, result.sha, JSON.stringify(result.paths), id, user.id, lock),
    ]);
    const linked = await githubProject(env, user.id, id);
    if (linked?.github_repo?.toLowerCase() !== repo.data.toLowerCase() || linked.github_branch !== branch) throw new BuildError('github_project_busy', 409);
    // Cleanup is durable and can resume in scheduled work after a partial R2 failure.
    await cleanupGithubHostedHistory(env, linked).catch(() => console.error('github_history_cleanup_deferred', { projectId: id }));
    return authJson({ github: publicGithubProject(linked) }, 200, cors);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (error instanceof BuildError) return authJson({ error: message }, error.status, cors);
    if (message.includes('build_app_limit')) return authJson({ error: 'build_app_limit' }, 429, cors);
    if (error instanceof SyntaxError || message === 'invalid_request') return authJson({ error: 'invalid_request' }, 400, cors);
    return authJson({ error: 'github_unavailable' }, 503, cors);
  } finally {
    if (lock && userId) await env.DB.prepare('UPDATE projects SET github_link_lock=NULL,github_link_until=0 WHERE id=? AND user_id=? AND github_link_lock=?')
      .bind(id, userId, lock).run().catch(() => {});
  }
}
