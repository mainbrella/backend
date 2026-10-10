import { authCorsHeaders, authJson, currentUser, hashToken, randomToken, readJSON } from './auth-core';
import { LaunchError, repoName } from '../lib/repo-launch';
import { exchangeGithubToken, githubCallbackURL, githubImportAPI, githubImportConfigured, pkceChallenge, sealGithubCredentials } from '../lib/github-import';

interface State { token_hash: string; user_id: string; repo: string; return_origin: string; return_path: string; verifier: string; kind: 'authorize' | 'install' }
async function newState(env: Env, state: Omit<State, 'token_hash' | 'verifier'>) {
  const token = randomToken(), verifier = randomToken();
  await env.DB.prepare('DELETE FROM github_import_states WHERE expires_at <= ?').bind(Date.now()).run();
  await env.DB.prepare('INSERT INTO github_import_states (token_hash, user_id, repo, return_origin, return_path, verifier, kind, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(await hashToken(token), state.user_id, state.repo, state.return_origin, state.return_path, verifier, state.kind, Date.now() + 15 * 60_000).run();
  return { token, verifier };
}
const installURL = (env: Env, token: string) => `https://github.com/apps/${env.GITHUB_IMPORT_APP_SLUG}/installations/new?state=${token}`;
function returnURL(state: State, result: string) {
  const url = new URL(state.return_path, state.return_origin);
  url.searchParams.set('github', result);
  return url.href;
}
const redirect = (url: string) => new Response(null, { status: 302, headers: { Location: url, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });

export async function handleGithubImportRequest(request: Request, env: Env): Promise<Response> {
  const cors = authCorsHeaders(request);
  if (cors === null) return authJson({ error: 'origin_not_allowed' }, 403, {});
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const url = new URL(request.url), route = url.pathname;
  const methods: Record<string, string[]> = { '/github/import/config': ['GET'], '/github/import/connect': ['POST'],
    '/github/import/connection': ['GET', 'DELETE'], '/github/import/callback': ['GET'], '/github/import/setup': ['GET'] };
  if (!methods[route]) return authJson({ error: 'not_found' }, 404, cors);
  if (!methods[route].includes(request.method)) return authJson({ error: 'method_not_allowed' }, 405, { ...cors, allow: methods[route].join(', ') });
  const configured = githubImportConfigured(env);
  if (route === '/github/import/config') return authJson({ enabled: configured }, 200, cors);
  if (['POST', 'DELETE'].includes(request.method) && !request.headers.get('Origin')) return authJson({ error: 'origin_required' }, 403, cors);
  if (!configured) return authJson({ error: 'github_import_unavailable' }, 503, cors);
  let state: State | null = null;
  try {
    // GitHub connections belong to a signed-in browser account, never an installation ID supplied by the client.
    const user = await currentUser(env, request);
    if (!user) return authJson({ error: 'not_authenticated' }, 401, cors);
    if (route === '/github/import/connection') {
      if (request.method === 'DELETE') {
        await env.DB.prepare('DELETE FROM github_import_connections WHERE user_id = ?').bind(user.id).run();
        await env.DB.prepare('DELETE FROM github_import_states WHERE user_id = ?').bind(user.id).run();
        return authJson({ ok: true }, 200, cors);
      }
      const connection = await env.DB.prepare('SELECT github_login FROM github_import_connections WHERE user_id = ?').bind(user.id).first<{ github_login: string }>();
      return authJson({ connected: Boolean(connection), login: connection?.github_login ?? null,
        manageUrl: 'https://github.com/settings/installations' }, 200, cors);
    }
    if (route === '/github/import/connect') {
      const body = await readJSON(request, 4096);
      const repo = repoName.safeParse(body?.repo);
      if (!repo.success || !body || Object.keys(body).some(key => !['repo', 'returnTo', 'reauthorize'].includes(key)) || body.reauthorize !== undefined && typeof body.reauthorize !== 'boolean') throw new LaunchError('invalid_request', 400);
      const origin = new URL(request.headers.get('Origin')!).origin;
      const destination = new URL(typeof body.returnTo === 'string' ? body.returnTo : `/run/?repo=${encodeURIComponent(repo.data)}&private=1`, origin);
      if (destination.origin !== origin || destination.pathname !== '/run/' || destination.href.length > 12_000) throw new LaunchError('invalid_request', 400);
      const connected = !body.reauthorize && await env.DB.prepare('SELECT user_id FROM github_import_connections WHERE user_id = ?').bind(user.id).first();
      const values = { user_id: user.id, repo: repo.data, return_origin: origin, return_path: destination.pathname + destination.search + destination.hash,
        kind: connected ? 'install' as const : 'authorize' as const };
      const pending = await newState(env, values);
      if (connected) return authJson({ url: installURL(env, pending.token) }, 200, cors);
      const authorize = new URL('https://github.com/login/oauth/authorize');
      authorize.search = new URLSearchParams({ client_id: env.GITHUB_IMPORT_CLIENT_ID!, redirect_uri: githubCallbackURL(env),
        state: pending.token, code_challenge: await pkceChallenge(pending.verifier), code_challenge_method: 'S256' }).toString();
      return authJson({ url: authorize.href }, 200, cors);
    }
    const token = url.searchParams.get('state');
    if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new LaunchError('invalid_github_state', 400);
    const kind = route === '/github/import/callback' ? 'authorize' : 'install';
    state = await env.DB.prepare('DELETE FROM github_import_states WHERE token_hash = ? AND user_id = ? AND kind = ? AND expires_at > ? RETURNING *')
      .bind(await hashToken(token), user.id, kind, Date.now()).first<State>();
    if (!state) throw new LaunchError('invalid_github_state', 400);
    if (route === '/github/import/setup') {
      // installation_id is only a navigation hint. Repository access is always checked with this user's token.
      return redirect(returnURL(state, url.searchParams.get('setup_action') === 'request' ? 'approval_pending' : 'connected'));
    }
    const code = url.searchParams.get('code');
    if (url.searchParams.has('error') || !code || code.length > 256) return redirect(returnURL(state, 'cancelled'));
    const credentials = await exchangeGithubToken(env, { code, code_verifier: state.verifier, redirect_uri: githubCallbackURL(env) });
    const profile = await githubImportAPI('/user', credentials.access_token);
    if (!Number.isSafeInteger(profile.id) || typeof profile.login !== 'string') throw new LaunchError('github_unavailable');
    await env.DB.prepare('INSERT INTO github_import_connections (user_id, github_user_id, github_login, credentials, expires_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET github_user_id = excluded.github_user_id, github_login = excluded.github_login, credentials = excluded.credentials, expires_at = excluded.expires_at, refresh_lock = NULL, refresh_until = 0')
      .bind(user.id, String(profile.id), profile.login, await sealGithubCredentials(env, user.id, credentials), Date.now() + (credentials.expires_in ?? 28_800) * 1000).run();
    const pending = await newState(env, { user_id: state.user_id, repo: state.repo, return_origin: state.return_origin,
      return_path: state.return_path, kind: 'install' });
    return redirect(installURL(env, pending.token));
  } catch (error) {
    const failure = error instanceof LaunchError ? error : new LaunchError('github_import_unavailable');
    // OAuth codes, tokens and upstream exception bodies must never be logged or sent to the browser.
    if (state) return redirect(returnURL(state, failure.message));
    return authJson({ error: failure.message }, failure.status, cors);
  }
}
