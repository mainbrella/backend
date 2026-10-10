import { LaunchError, repoName, resolvePublicRepo, resolveRepository, type LaunchOptions, type ResolvedRepo } from './repo-launch';

export interface GithubCredentials { access_token: string; refresh_token?: string; expires_in?: number; refresh_token_expires_in?: number }
interface Connection { credentials: string; expires_at: number; github_user_id: string; github_login: string }
const encoder = new TextEncoder();
export const githubImportConfigured = (env: Env) => Boolean(env.GITHUB_IMPORT_CLIENT_ID && env.GITHUB_IMPORT_CLIENT_SECRET
  && /^[A-Za-z0-9-]+$/.test(env.GITHUB_IMPORT_APP_SLUG ?? '') && /^[a-f0-9]{64}$/.test(env.GITHUB_IMPORT_ENCRYPTION_KEY ?? ''));

async function encryptionKey(env: Env) {
  if (!githubImportConfigured(env)) throw new LaunchError('github_import_unavailable', 503);
  const bytes = Uint8Array.from(env.GITHUB_IMPORT_ENCRYPTION_KEY!.match(/../g)!, value => parseInt(value, 16));
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function sealGithubCredentials(env: Env, owner: string, credentials: GithubCredentials): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(owner) },
    await encryptionKey(env), encoder.encode(JSON.stringify(credentials))));
  return JSON.stringify({ iv: [...iv], ciphertext: [...ciphertext] });
}
async function openCredentials(env: Env, owner: string, sealed: string): Promise<GithubCredentials> {
  const { iv, ciphertext } = JSON.parse(sealed);
  const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(iv), additionalData: encoder.encode(owner) },
    await encryptionKey(env), new Uint8Array(ciphertext));
  return JSON.parse(new TextDecoder().decode(bytes));
}

export async function exchangeGithubToken(env: Env, values: Record<string, string>): Promise<GithubCredentials> {
  let response: Response;
  try {
    response = await fetch('https://github.com/login/oauth/access_token', { method: 'POST', redirect: 'manual',
      signal: AbortSignal.timeout(15_000), headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: env.GITHUB_IMPORT_CLIENT_ID!, client_secret: env.GITHUB_IMPORT_CLIENT_SECRET!, ...values }) });
  } catch { throw new LaunchError('github_unavailable'); }
  const data = await response.json().catch(() => null) as GithubCredentials & { error?: string } | null;
  if (!response.ok || !data || data.error || typeof data.access_token !== 'string' || !data.access_token.startsWith('ghu_')) {
    throw new LaunchError('github_connection_required', 400);
  }
  return { access_token: data.access_token, ...(typeof data.refresh_token === 'string' ? { refresh_token: data.refresh_token } : {}),
    ...(Number.isSafeInteger(data.expires_in) && data.expires_in! > 0 ? { expires_in: data.expires_in } : {}),
    ...(Number.isSafeInteger(data.refresh_token_expires_in) ? { refresh_token_expires_in: data.refresh_token_expires_in } : {}) };
}

export async function githubUserToken(env: Env, owner: string): Promise<string> {
  if (!githubImportConfigured(env)) throw new LaunchError('github_import_unavailable', 503);
  const row = await env.DB.prepare('SELECT credentials, expires_at, github_user_id, github_login FROM github_import_connections WHERE user_id = ?')
    .bind(owner).first<Connection>();
  if (!row) throw new LaunchError('github_connection_required', 400);
  const credentials = await openCredentials(env, owner, row.credentials);
  if (row.expires_at > Date.now() + 60_000) return credentials.access_token;
  if (!credentials.refresh_token) throw new LaunchError('github_connection_required', 400);
  // Refresh tokens are single-use. A durable lease prevents concurrent rotations.
  // An uncertain expired lease requires reconnection instead of replaying a token.
  const lock = crypto.randomUUID();
  const claimed = await env.DB.prepare('UPDATE github_import_connections SET refresh_lock = ?, refresh_until = ? WHERE user_id = ? AND credentials = ? AND refresh_lock IS NULL')
    .bind(lock, Date.now() + 60_000, owner, row.credentials).run();
  if (!claimed.meta.changes) {
    const current = await env.DB.prepare('SELECT expires_at, refresh_until FROM github_import_connections WHERE user_id = ?').bind(owner)
      .first<{ expires_at: number; refresh_until: number }>();
    if (current && current.expires_at > Date.now() + 60_000) return githubUserToken(env, owner);
    throw new LaunchError(current && current.refresh_until > Date.now() ? 'github_connection_busy' : 'github_connection_required', current && current.refresh_until > Date.now() ? 409 : 400);
  }
  const fresh = await exchangeGithubToken(env, { grant_type: 'refresh_token', refresh_token: credentials.refresh_token });
  const saved = await env.DB.prepare('UPDATE github_import_connections SET credentials = ?, expires_at = ?, refresh_lock = NULL, refresh_until = 0 WHERE user_id = ? AND refresh_lock = ?')
    .bind(await sealGithubCredentials(env, owner, fresh), Date.now() + (fresh.expires_in ?? 28_800) * 1000, owner, lock).run();
  if (!saved.meta.changes) throw new LaunchError('github_connection_required', 400);
  return fresh.access_token;
}

export async function githubImportAPI(path: string, token: string): Promise<any> {
  let response: Response;
  try {
    response = await fetch(`https://api.github.com${path}`, { redirect: 'manual', signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Mainbrella-Import', 'X-GitHub-Api-Version': '2026-03-10' } });
  } catch { throw new LaunchError('github_unavailable'); }
  if (response.status === 401) throw new LaunchError('github_connection_required', 400);
  if ([403, 429].includes(response.status)) throw new LaunchError('github_access_denied', response.status === 429 ? 429 : 403);
  if (response.status === 404) throw new LaunchError('github_repository_access_required', 400);
  if (!response.ok) throw new LaunchError('github_unavailable');
  return response.json();
}

export async function resolveUserRepository(env: Env, owner: string, repo: string, ref?: string, cwd = '.'): Promise<ResolvedRepo> {
  try { return await resolvePublicRepo(repo, ref, cwd, env.REPO_RUN_GITHUB_TOKEN); }
  catch (error) { if (!(error instanceof LaunchError) || error.message !== 'public_repo_not_found') throw error; }
  if (!githubImportConfigured(env)) throw new LaunchError('github_import_unavailable', 503);
  const token = await githubUserToken(env, owner);
  // This user token has the intersection of user access and Import app access.
  // Never use the operator's public-lookup token to authorize private source.
  return resolveRepository(repo, ref, cwd, token, true);
}

export function githubCallbackURL(env: Env) {
  return `${env.LOCAL_DEV === 'true' ? 'http://localhost:8787' : 'https://api.mainbrella.com'}/github/import/callback`;
}

export async function suggestedPrivateSetup(env: Env, owner: string, repo: ResolvedRepo, cwd: string): Promise<LaunchOptions> {
  const options: LaunchOptions = { repo: repo.repo, ref: repo.commit, size: 'small', cwd,
    catalogId: repo.suggestedCatalogId as LaunchOptions['catalogId'] };
  const languages = [repo.manifests.includes('package.json'), repo.manifests.some(file => ['pyproject.toml', 'requirements.txt', 'Pipfile'].includes(file)),
    repo.manifests.includes('Cargo.toml'), repo.manifests.includes('go.mod')].filter(Boolean).length;
  if (languages !== 1) return options;
  if (repo.manifests.includes('package.json')) {
    const path = `${cwd === '.' ? '' : cwd + '/'}package.json`;
    const data = await githubImportAPI(`/repos/${repo.repo}/contents/${path}?ref=${repo.commit}`, await githubUserToken(env, owner));
    if (data.encoding !== 'base64' || typeof data.content !== 'string' || data.content.length > 140_000) return options;
    let manifest;
    try { manifest = JSON.parse(atob(data.content.replace(/\s/g, ''))); } catch { return options; }
    // Only infer dependency installation. Startup and ports need source review.
    if (!manifest.packageManager || /^npm@/.test(manifest.packageManager)) options.setupCommand = 'npm install';
  } else if (repo.manifests.includes('requirements.txt')) options.setupCommand = 'python3 -m venv .venv\n.venv/bin/python -m pip install -r requirements.txt';
  else if (repo.manifests.includes('Cargo.toml')) options.setupCommand = 'cargo build';
  else if (repo.manifests.includes('go.mod')) options.setupCommand = 'go build ./...';
  return options;
}
export const pkceChallenge = async (verifier: string) => {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier)));
  return btoa(String.fromCharCode(...digest)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
};

export const MAX_IMPORT_PACK_BYTES = 32 * 1024 * 1024;
const packet = (text: string) => (encoder.encode(text).byteLength + 4).toString(16).padStart(4, '0') + text;
export function gitFetchBody(commit: string) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new LaunchError('invalid_request', 400);
  return packet(`want ${commit} side-band-64k ofs-delta no-progress\n`) + packet('deepen 1\n') + '0000' + packet('done\n');
}

// Only pack bytes cross into the guest. GitHub authorization stays in the Worker.
// Shallow Git objects preserve the exact base commit for future local commits.
export async function readGitPack(stream: ReadableStream<Uint8Array> | null): Promise<Uint8Array> {
  if (!stream) throw new LaunchError('github_unavailable');
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let pending = new Uint8Array(), total = 0, wireBytes = 0, flushed = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      wireBytes += value.byteLength;
      if (wireBytes > MAX_IMPORT_PACK_BYTES + 1024 * 1024) throw new LaunchError('repository_too_large', 413);
      const joined = new Uint8Array(pending.length + value.length); joined.set(pending); joined.set(value, pending.length);
      let offset = 0;
      while (offset + 4 <= joined.length) {
        const header = new TextDecoder().decode(joined.subarray(offset, offset + 4));
        if (!/^[0-9a-f]{4}$/.test(header)) throw new LaunchError('github_unavailable');
        const size = parseInt(header, 16);
        if (size === 0) { if (total) flushed = true; offset += 4; continue; }
        if (size < 5 || size > 65520 || flushed) throw new LaunchError('github_unavailable');
        if (offset + size > joined.length) break;
        const data = joined.subarray(offset + 4, offset + size);
        if (data[0] === 1) {
          total += data.length - 1;
          if (total > MAX_IMPORT_PACK_BYTES) throw new LaunchError('repository_too_large', 413);
          chunks.push(data.slice(1));
        } else if (data[0] === 3 || new TextDecoder().decode(data).startsWith('ERR ')) throw new LaunchError('github_repository_access_required', 400);
        offset += size;
      }
      pending = joined.slice(offset);
    }
    if (pending.length || !flushed || total < 32) throw new LaunchError('github_unavailable');
    const pack = new Uint8Array(total);
    let offset = 0; for (const chunk of chunks) { pack.set(chunk, offset); offset += chunk.length; }
    if (new TextDecoder().decode(pack.subarray(0, 4)) !== 'PACK') throw new LaunchError('github_unavailable');
    return pack;
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export async function downloadGitPack(repo: string, commit: string, token: string): Promise<Uint8Array> {
  if (!repoName.safeParse(repo).success) throw new LaunchError('invalid_request', 400);
  let response: Response;
  try {
    response = await fetch(`https://github.com/${repo}.git/git-upload-pack`, { method: 'POST', redirect: 'manual',
      signal: AbortSignal.timeout(45_000), headers: { Authorization: `Basic ${btoa(`x-access-token:${token}`)}`,
        'Content-Type': 'application/x-git-upload-pack-request', Accept: 'application/x-git-upload-pack-result', 'User-Agent': 'Mainbrella-Import' },
      body: gitFetchBody(commit) });
  } catch { throw new LaunchError('github_unavailable'); }
  if ([401, 403, 404].includes(response.status)) throw new LaunchError('github_repository_access_required', 400);
  if (!response.ok || !response.headers.get('content-type')?.startsWith('application/x-git-upload-pack-result')) throw new LaunchError('github_unavailable');
  return readGitPack(response.body);
}
