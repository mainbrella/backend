import { authCorsHeaders, authJson, hashToken, randomToken } from './auth-core';
import { containerUser } from './container-auth';

type SSHEnv = Env & { SSH_GATEWAY_SECRET?: string; SSH_HOSTNAME?: string };
type AccessToken = { user_id: string; container_created_at: string; expires_at: number };
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const TOKEN_LIFETIME_MS = 15 * 60_000;

async function gatewayAuthenticated(request: Request, env: SSHEnv): Promise<boolean> {
  if (!env.SSH_GATEWAY_SECRET || env.SSH_GATEWAY_SECRET.length < 32) return false;
  const supplied = request.headers.get('authorization')?.match(/^Bearer (.{32,256})$/)?.[1];
  if (!supplied) return false;
  const [actual, expected] = await Promise.all([hashToken(supplied), hashToken(env.SSH_GATEWAY_SECRET)]);
  let difference = 0;
  for (let index = 0; index < expected.length; index++) difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  return difference === 0;
}

async function runningContainer(env: SSHEnv, userId: string) {
  if (!env.USER_CONTAINER) throw new Error('containers_unavailable');
  const stub = env.USER_CONTAINER.get(env.USER_CONTAINER.idFromName(`user:${userId}`));
  const response = await stub.fetch(new Request('https://internal/container'));
  if (!response.ok) throw new Error('containers_unavailable');
  const data = await response.json() as { containers?: { createdAt: string; expiresAt: string }[] };
  return { stub, container: data.containers?.[0] };
}

export async function handleSSHRequest(request: Request, env: SSHEnv): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === '/containers/ssh') return issueAccess(request, env);
  if (!['/ssh/validate', '/ssh/connect'].includes(path)) return authJson({ error: 'not_found' }, 404, {});
  const expectedMethod = path === '/ssh/connect' ? 'GET' : 'POST';
  if (request.method !== expectedMethod) return authJson({ error: 'method_not_allowed' }, 405, {});
  try {
    if (!await gatewayAuthenticated(request, env)) return authJson({ error: 'not_authenticated' }, 401, {});
    let token: unknown;
    if (path === '/ssh/connect') {
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket' || new URL(request.url).search) {
        return authJson({ error: 'invalid_request' }, 400, {});
      }
      token = request.headers.get('x-mainbrella-ssh-token');
    } else {
      const body = await request.json().catch(() => null) as { token?: unknown } | null;
      token = body?.token;
    }
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return authJson({ error: 'not_authenticated' }, 401, {});
    const access = await env.DB.prepare(
      'SELECT user_id, container_created_at, expires_at FROM ssh_access_tokens WHERE token_hash = ? AND expires_at > ? LIMIT 1',
    ).bind(await hashToken(token), Date.now()).first<AccessToken>();
    if (!access) return authJson({ error: 'not_authenticated' }, 401, {});
    const { stub, container } = await runningContainer(env, access.user_id);
    if (!container || container.createdAt !== access.container_created_at) {
      return authJson({ error: 'container_not_running' }, 409, {});
    }
    if (path === '/ssh/validate') return authJson({ expiresAt: access.expires_at }, 200, {});
    const response = await stub.fetch(new Request('https://internal/ssh', {
      headers: {
        upgrade: 'websocket',
        'x-ssh-created-at': access.container_created_at,
        'x-ssh-expires-at': String(access.expires_at),
      },
    }));
    if (response.status !== 101) return authJson({ error: 'container_not_running' }, 409, {});
    return response;
  } catch {
    // Never log SSH tokens, gateway credentials, or terminal contents.
    return authJson({ error: 'ssh_unavailable' }, 503, {});
  }
}

async function issueAccess(request: Request, env: SSHEnv): Promise<Response> {
  const cors = authCorsHeaders(request);
  if (cors === null) return authJson({ error: 'origin_not_allowed' }, 403, {});
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return authJson({ error: 'method_not_allowed' }, 405, cors);
  if (!request.headers.get('origin') && !request.headers.has('Authorization')) return authJson({ error: 'origin_required' }, 403, cors);
  try {
    const user = await containerUser(env, request);
    if (!user) return authJson({ error: 'not_authenticated' }, 401, cors);
    if (!env.SSH_GATEWAY_SECRET) return authJson({ error: 'ssh_unavailable' }, 503, cors);
    const { container } = await runningContainer(env, user.id);
    if (!container) return authJson({ error: 'container_not_running' }, 409, cors);
    const expiresAt = Math.min(Date.now() + TOKEN_LIFETIME_MS, Date.parse(container.expiresAt));
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return authJson({ error: 'container_not_running' }, 409, cors);
    const hostname = env.SSH_HOSTNAME || 'ssh.mainbrella.com';
    if (!/^(?=.{1,253}$)[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(hostname)) throw new Error('invalid_ssh_hostname');
    const token = randomToken();
    await env.DB.prepare('DELETE FROM ssh_access_tokens WHERE expires_at <= ?').bind(Date.now()).run();
    const saved = await env.DB.prepare(
      `INSERT INTO ssh_access_tokens (token_hash, user_id, container_created_at, expires_at)
       SELECT ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM ssh_access_tokens WHERE user_id = ?) < 10`,
    ).bind(await hashToken(token), user.id, container.createdAt, expiresAt, user.id).run();
    if (!saved.meta.changes) return authJson({ error: 'ssh_token_limit' }, 429, cors);
    return authJson({
      command: `ssh -o ProxyCommand='cloudflared access ssh --hostname %h' ${token}@${hostname}`,
      expiresAt, hostname,
    }, 200, cors);
  } catch {
    return authJson({ error: 'ssh_unavailable' }, 503, cors);
  }
}
