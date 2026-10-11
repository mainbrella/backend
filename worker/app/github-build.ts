import { authCorsHeaders, authJson, currentUser, hashToken, randomToken, readJSON } from './auth-core';
import { BuildError } from '../lib/build-contract';
import { exchangeGithubBuildCode, githubBuildAPI, githubBuildCallbackURL, githubBuildConfigured, githubBuildPKCEChallenge, sealGithubBuildCredentials } from '../lib/github-build';
import { validGithubBranch } from '../lib/github-build';
import { repoName } from '../lib/repo-launch';

interface State { token_hash: string; user_id: string; project_id: string; repo: string; branch: string; return_origin: string; return_path: string; verifier: string; kind: 'authorize' | 'install' }

async function projectOwned(env: Env, projectId: string, userId: string) {
  return env.DB.prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?').bind(projectId, userId).first<{ id: string }>();
}
async function newState(env: Env, state: Omit<State, 'token_hash' | 'verifier'>) {
  const token = randomToken(), verifier = randomToken();
  await env.DB.prepare('DELETE FROM github_build_states WHERE expires_at <= ?').bind(Date.now()).run();
  await env.DB.prepare('INSERT INTO github_build_states (token_hash, user_id, project_id, repo, branch, return_origin, return_path, verifier, kind, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(await hashToken(token), state.user_id, state.project_id, state.repo, state.branch, state.return_origin, state.return_path, verifier, state.kind, Date.now() + 15 * 60_000).run();
  return { token, verifier };
}
const installURL = (env: Env, token: string) => `https://github.com/apps/${env.GITHUB_BUILD_APP_SLUG}/installations/new?state=${token}`;
function returnURL(state: State, result: string) {
  const url = new URL(state.return_path, state.return_origin);
  url.searchParams.set('github', result);
  return url.href;
}
const redirect = (url: string) => new Response(null, { status: 302, headers: { Location: url, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });

export async function handleGithubBuildRequest(request: Request, env: Env): Promise<Response> {
  const cors = authCorsHeaders(request);
  if (cors === null) return authJson({ error: 'origin_not_allowed' }, 403, {});
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const url = new URL(request.url), route = url.pathname;
  const methods: Record<string, string[]> = { '/github/build/config': ['GET'], '/github/build/connect': ['POST'],
    '/github/build/connection': ['GET'], '/github/build/callback': ['GET'], '/github/build/setup': ['GET'] };
  if (!methods[route]) return authJson({ error: 'not_found' }, 404, cors);
  if (!methods[route].includes(request.method)) return authJson({ error: 'method_not_allowed' }, 405, { ...cors, allow: methods[route].join(', ') });
  const configured = githubBuildConfigured(env);
  if (route === '/github/build/config') return authJson({ enabled: configured }, 200, cors);
  if (request.method === 'POST' && !request.headers.get('Origin')) return authJson({ error: 'origin_required' }, 403, cors);
  if (!configured) return authJson({ error: 'github_build_unavailable' }, 503, cors);
  let state: State | null = null;
  try {
    const user = await currentUser(env, request);
    if (!user) return authJson({ error: 'not_authenticated' }, 401, cors);
    if (route === '/github/build/connection') {
      const connection = await env.DB.prepare('SELECT github_login FROM github_build_connections WHERE user_id = ?').bind(user.id).first<{ github_login: string }>();
      return authJson({ connected: Boolean(connection), login: connection?.github_login ?? null,
        manageUrl: 'https://github.com/settings/installations' }, 200, cors);
    }
    if (route === '/github/build/connect') {
      const body = await readJSON(request, 4096);
      const repo = repoName.safeParse(body?.repo);
      if (!body || Object.keys(body).some(key => !['projectId', 'repo', 'branch', 'returnTo', 'reauthorize'].includes(key))
        || typeof body.projectId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.projectId) || !repo.success
        || body.branch !== undefined && !validGithubBranch(body.branch)
        || body.returnTo !== undefined && (typeof body.returnTo !== 'string' || !body.returnTo.startsWith('/projects/') || body.returnTo.startsWith('//'))
        || body.reauthorize !== undefined && typeof body.reauthorize !== 'boolean') throw new BuildError('invalid_request', 400);
      if (!await projectOwned(env, body.projectId, user.id)) throw new BuildError('project_not_found', 404);
      const origin = new URL(request.headers.get('Origin')!).origin;
      const branch = (body.branch as string | undefined) ?? 'main';
      const destination = new URL(typeof body.returnTo === 'string' ? body.returnTo : '/projects/', origin);
      const hasReturnFields = ['githubProject', 'githubRepo', 'githubBranch'].some(key => destination.searchParams.has(key));
      if (destination.origin !== origin || destination.pathname !== '/projects/' || destination.hash
        || [...destination.searchParams.keys()].some(key => !['githubProject', 'githubRepo', 'githubBranch'].includes(key))
        || ['githubProject', 'githubRepo', 'githubBranch'].some(key => destination.searchParams.getAll(key).length > 1)
        || hasReturnFields && (['githubProject', 'githubRepo', 'githubBranch'].some(key => destination.searchParams.getAll(key).length !== 1)
          || destination.searchParams.get('githubProject') !== body.projectId || destination.searchParams.get('githubRepo') !== repo.data
          || destination.searchParams.get('githubBranch') !== branch))
        throw new BuildError('invalid_request', 400);
      destination.searchParams.set('githubProject', body.projectId);
      destination.searchParams.set('githubRepo', repo.data);
      destination.searchParams.set('githubBranch', branch);
      const connected = !body.reauthorize && await env.DB.prepare('SELECT user_id FROM github_build_connections WHERE user_id = ?').bind(user.id).first();
      const values = { user_id: user.id, project_id: body.projectId, repo: repo.data, branch,
        return_origin: origin, return_path: destination.pathname + destination.search, kind: connected ? 'install' as const : 'authorize' as const };
      const pending = await newState(env, values);
      if (connected) return authJson({ url: installURL(env, pending.token) }, 200, cors);
      const authorize = new URL('https://github.com/login/oauth/authorize');
      authorize.search = new URLSearchParams({ client_id: env.GITHUB_BUILD_CLIENT_ID!, redirect_uri: githubBuildCallbackURL(env), state: pending.token,
        code_challenge: await githubBuildPKCEChallenge(pending.verifier), code_challenge_method: 'S256' }).toString();
      return authJson({ url: authorize.href }, 200, cors);
    }
    const token = url.searchParams.get('state');
    if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new BuildError('invalid_github_state', 400);
    const kind = route === '/github/build/callback' ? 'authorize' : 'install';
    state = await env.DB.prepare('DELETE FROM github_build_states WHERE token_hash = ? AND user_id = ? AND kind = ? AND expires_at > ? RETURNING *')
      .bind(await hashToken(token), user.id, kind, Date.now()).first<State>();
    if (!state || !await projectOwned(env, state.project_id, user.id)) throw new BuildError('invalid_github_state', 400);
    if (route === '/github/build/setup') {
      // GitHub's installation ID is informational. Repository rights are checked with the stored user token by each operation.
      return redirect(returnURL(state, url.searchParams.get('setup_action') === 'request' ? 'approval_pending' : 'connected'));
    }
    const code = url.searchParams.get('code');
    if (url.searchParams.has('error') || !code || code.length > 256) return redirect(returnURL(state, 'cancelled'));
    const credentials = await exchangeGithubBuildCode(env, { code, code_verifier: state.verifier, redirect_uri: githubBuildCallbackURL(env) });
    const profile = await githubBuildAPI('/user', credentials.access_token);
    if (!Number.isSafeInteger(profile?.id) || typeof profile.login !== 'string') throw new BuildError('github_unavailable');
    await env.DB.prepare('INSERT INTO github_build_connections (user_id, github_user_id, github_login, credentials, expires_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET github_user_id = excluded.github_user_id, github_login = excluded.github_login, credentials = excluded.credentials, expires_at = excluded.expires_at, refresh_lock = NULL, refresh_until = 0')
      .bind(user.id, String(profile.id), profile.login, await sealGithubBuildCredentials(env, user.id, credentials), Date.now() + (credentials.expires_in ?? 28_800) * 1000).run();
    const pending = await newState(env, { user_id: state.user_id, project_id: state.project_id, repo: state.repo, branch: state.branch,
      return_origin: state.return_origin, return_path: state.return_path, kind: 'install' });
    return redirect(installURL(env, pending.token));
  } catch (error) {
    const failure = error instanceof BuildError ? error : new BuildError('github_build_unavailable');
    if (state) return redirect(returnURL(state, failure.message));
    return authJson({ error: failure.message }, failure.status, cors);
  }
}
