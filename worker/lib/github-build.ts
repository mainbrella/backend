import { BuildError } from './build-contract';
import { repoName } from './repo-launch';

export interface GithubBuildCredentials { access_token: string; refresh_token?: string; expires_in?: number; refresh_token_expires_in?: number }
interface Connection { credentials: string; expires_at: number; github_user_id: string; github_login: string }
const encoder = new TextEncoder();

export function validGithubBranch(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 255 && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)
    && !value.includes('..') && !value.includes('//') && !value.includes('@{') && !/(?:\/|\.)$/.test(value)
    && value.split('/').every(part => !part.startsWith('.') && !part.endsWith('.lock'));
}

export const githubBuildConfigured = (env: Env) => Boolean(env.GITHUB_BUILD_CLIENT_ID && env.GITHUB_BUILD_CLIENT_SECRET
  && /^[A-Za-z0-9-]+$/.test(env.GITHUB_BUILD_APP_SLUG ?? '') && /^[a-f0-9]{64}$/.test(env.GITHUB_BUILD_ENCRYPTION_KEY ?? ''));

async function encryptionKey(env: Env) {
  if (!githubBuildConfigured(env)) throw new BuildError('github_build_unavailable', 503);
  const bytes = Uint8Array.from(env.GITHUB_BUILD_ENCRYPTION_KEY!.match(/../g)!, value => parseInt(value, 16));
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function sealCredentials(env: Env, owner: string, credentials: GithubBuildCredentials): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(owner) },
    await encryptionKey(env), encoder.encode(JSON.stringify(credentials))));
  return JSON.stringify({ iv: [...iv], ciphertext: [...ciphertext] });
}
async function openCredentials(env: Env, owner: string, sealed: string): Promise<GithubBuildCredentials> {
  const { iv, ciphertext } = JSON.parse(sealed);
  const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(iv), additionalData: encoder.encode(owner) },
    await encryptionKey(env), new Uint8Array(ciphertext));
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function exchangeToken(env: Env, values: Record<string, string>): Promise<GithubBuildCredentials> {
  let response: Response;
  try {
    response = await fetch('https://github.com/login/oauth/access_token', { method: 'POST', redirect: 'manual',
      signal: AbortSignal.timeout(15_000), headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: env.GITHUB_BUILD_CLIENT_ID!, client_secret: env.GITHUB_BUILD_CLIENT_SECRET!, ...values }) });
  } catch { throw new BuildError('github_unavailable'); }
  const data = await response.json().catch(() => null) as GithubBuildCredentials & { error?: string } | null;
  if (!response.ok || !data || data.error || typeof data.access_token !== 'string' || !data.access_token.startsWith('ghu_'))
    throw new BuildError('github_connection_required', 400);
  return { access_token: data.access_token, ...(typeof data.refresh_token === 'string' ? { refresh_token: data.refresh_token } : {}),
    ...(Number.isSafeInteger(data.expires_in) && data.expires_in! > 0 ? { expires_in: data.expires_in } : {}),
    ...(Number.isSafeInteger(data.refresh_token_expires_in) ? { refresh_token_expires_in: data.refresh_token_expires_in } : {}) };
}

export async function githubBuildUserToken(env: Env, userId: string): Promise<string> {
  if (!githubBuildConfigured(env)) throw new BuildError('github_build_unavailable', 503);
  const row = await env.DB.prepare('SELECT credentials, expires_at, github_user_id, github_login FROM github_build_connections WHERE user_id = ?')
    .bind(userId).first<Connection>();
  if (!row) throw new BuildError('github_connection_required', 400);
  const credentials = await openCredentials(env, userId, row.credentials);
  if (row.expires_at > Date.now() + 60_000) return credentials.access_token;
  if (!credentials.refresh_token) throw new BuildError('github_connection_required', 400);
  const lock = crypto.randomUUID();
  const claimed = await env.DB.prepare('UPDATE github_build_connections SET refresh_lock = ?, refresh_until = ? WHERE user_id = ? AND credentials = ? AND refresh_lock IS NULL')
    .bind(lock, Date.now() + 60_000, userId, row.credentials).run();
  if (!claimed.meta.changes) {
    const current = await env.DB.prepare('SELECT expires_at, refresh_until FROM github_build_connections WHERE user_id = ?').bind(userId)
      .first<{ expires_at: number; refresh_until: number }>();
    if (current && current.expires_at > Date.now() + 60_000) return githubBuildUserToken(env, userId);
    throw new BuildError(current && current.refresh_until > Date.now() ? 'github_connection_busy' : 'github_connection_required', current && current.refresh_until > Date.now() ? 409 : 400);
  }
  // Refresh tokens are single-use. Keep the lease after any uncertain exchange
  // failure; replaying the same token could invalidate the connection.
  const fresh = await exchangeToken(env, { grant_type: 'refresh_token', refresh_token: credentials.refresh_token });
  const saved = await env.DB.prepare('UPDATE github_build_connections SET credentials = ?, expires_at = ?, refresh_lock = NULL, refresh_until = 0 WHERE user_id = ? AND refresh_lock = ?')
    .bind(await sealCredentials(env, userId, fresh), Date.now() + (fresh.expires_in ?? 28_800) * 1000, userId, lock).run();
  if (!saved.meta.changes) throw new BuildError('github_connection_required', 400);
  return fresh.access_token;
}

export async function githubBuildAPI(path: string, token: string, method = 'GET', body?: unknown): Promise<any> {
  if (!/^\/[A-Za-z0-9_./%~-]+(?:\?[A-Za-z0-9_.=&%~-]*)?$/.test(path) || path.split('/').includes('..') || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method))
    throw new BuildError('github_unavailable');
  let response: Response;
  try {
    response = await fetch(`https://api.github.com${path}`, { method, redirect: 'manual', signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Mainbrella-Build', 'X-GitHub-Api-Version': '2026-03-10',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  } catch { throw new BuildError('github_unavailable'); }
  const data = await response.json().catch(() => null) as { message?: string } | null;
  if (response.status === 401) throw new BuildError('github_connection_required', 400);
  if (response.status === 403 || response.status === 429) {
    if (response.status === 429 || response.headers.get('x-ratelimit-remaining') === '0') throw new BuildError('github_rate_limited', 429);
    throw new BuildError('github_write_access_required', 403);
  }
  if (response.status === 404) throw new BuildError('github_repository_access_required', 404);
  if (response.status === 409 || response.status === 422) {
    if (/protected|branch/i.test(data?.message ?? '')) throw new BuildError('github_branch_protected', 409);
    throw new BuildError('github_branch_conflict', 409);
  }
  if (!response.ok) throw new BuildError('github_unavailable');
  return data;
}

export const validGithubRepositoryCursor = (value: string) => /^[1-9]\d{0,5}:(?:[0-9]|[1-9][0-9]):[1-9]\d{0,5}$/.test(value);
export async function githubBuildRepositories(env: Env, userId: string, cursor = '1:0:1') {
  const token = await githubBuildUserToken(env, userId);
  const [installationPage, installationIndex, repositoryPage] = cursor.split(':').map(Number);
  const data = await githubBuildAPI(`/user/installations?per_page=100&page=${installationPage}`, token);
  if (!Array.isArray(data?.installations)) throw new BuildError('github_unavailable');
  const installations = data.installations;
  const nextInstallation = (index: number) => index < installations.length ? `${installationPage}:${index}:1`
    : installations.length === 100 ? `${installationPage + 1}:0:1` : null;
  for (let index = installationIndex; index < installations.length; index++) {
    const installation = installations[index];
    // User access tokens expose only the intersection of this app's and the
    // user's access. Also exclude installations without Contents write access.
    if (installation.app_slug !== env.GITHUB_BUILD_APP_SLUG || installation.suspended_at
      || installation.permissions?.contents !== 'write') continue;
    if (!Number.isSafeInteger(installation.id) || installation.id <= 0) throw new BuildError('github_unavailable');
    const page = index === installationIndex ? repositoryPage : 1;
    const result = await githubBuildAPI(`/user/installations/${installation.id}/repositories?per_page=100&page=${page}`, token);
    if (!Array.isArray(result?.repositories)) throw new BuildError('github_unavailable');
    const repositories = result.repositories.filter((repo: any) => repo.permissions?.push === true && !repo.archived && !repo.disabled
      && Number.isSafeInteger(repo.id) && repoName.safeParse(repo.full_name).success && validGithubBranch(repo.default_branch))
      .map((repo: any) => ({ id: repo.id as number, fullName: repo.full_name as string, defaultBranch: repo.default_branch as string, private: repo.private === true }));
    return { repositories, nextCursor: result.repositories.length === 100 ? `${installationPage}:${index}:${page + 1}` : nextInstallation(index + 1) };
  }
  return { repositories: [], nextCursor: installations.length === 100 ? `${installationPage + 1}:0:1` : null };
}


export async function exchangeGithubBuildCode(env: Env, values: Record<string, string>) { return exchangeToken(env, values); }
export async function sealGithubBuildCredentials(env: Env, owner: string, credentials: GithubBuildCredentials) { return sealCredentials(env, owner, credentials); }
export function githubBuildCallbackURL(env: Env) {
  return `${env.LOCAL_DEV === 'true' ? 'http://localhost:8787' : 'https://api.mainbrella.com'}/github/build/callback`;
}
export const githubBuildPKCEChallenge = async (verifier: string) => {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier)));
  return btoa(String.fromCharCode(...digest)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
};
