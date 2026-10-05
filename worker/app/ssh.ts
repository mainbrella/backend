import { authCorsHeaders, authJson, hashToken, randomToken } from './auth-core';
import { runningContainer, containerError } from '../lib/container-service';
import { containerUser } from './container-auth';
import { ACCESS_LIMITS } from '../../containers/plan-policy.js';

type SSHEnv = Env & { SSH_GATEWAY_SECRET?: string; SSH_HOSTNAME?: string };
type AccessToken = { user_id: string; container_created_at: string; container_id: string; expires_at: number };
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

async function gatewayAuthenticated(request: Request, env: SSHEnv): Promise<boolean> {
  if (!env.SSH_GATEWAY_SECRET || env.SSH_GATEWAY_SECRET.length < 32) return false;
  const supplied = request.headers.get('authorization')?.match(/^Bearer (.{32,256})$/)?.[1];
  if (!supplied) return false;
  const [actual, expected] = await Promise.all([hashToken(supplied), hashToken(env.SSH_GATEWAY_SECRET)]);
  let difference = 0;
  for (let index = 0; index < expected.length; index++) difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  return difference === 0;
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
      'SELECT user_id, container_created_at, container_id, expires_at FROM ssh_access_tokens WHERE token_hash = ? AND expires_at > ? LIMIT 1',
    ).bind(await hashToken(token), Date.now()).first<AccessToken>();
    if (!access) return authJson({ error: 'not_authenticated' }, 401, {});
    const { stub, container } = await runningContainer(env, access.user_id, access.container_id);
    if (!container || container.createdAt !== access.container_created_at) {
      return authJson({ error: 'container_not_running' }, 409, {});
    }
    const expiresAt = Math.min(access.expires_at, Date.parse(container.expiresAt));
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return authJson({ error: 'container_not_running' }, 409, {});
    if (path === '/ssh/validate') return authJson({ expiresAt }, 200, {});
    const response = await stub!.fetch(new Request('https://internal/ssh', {
      headers: {
        upgrade: 'websocket',
        'x-ssh-created-at': access.container_created_at,
        'x-ssh-expires-at': String(expiresAt),
      },
    }));
    if (response.status !== 101) return authJson({ error: 'container_not_running' }, 409, {});
    return response;
  } catch (error) {
    const failure = containerError(error, 'ssh_unavailable');
    // Never log SSH tokens, gateway credentials, or terminal contents.
    return authJson({ error: failure.error }, failure.status, {});
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
    const body = await request.text();
    let id: string | null = null;
    let createdAt: string | null = null;
    if (body) {
      if (body.length > 2_000) return authJson({ error: 'invalid_request' }, 400, cors);
      let input: { id?: unknown; createdAt?: unknown };
      try { input = JSON.parse(body); } catch { return authJson({ error: 'invalid_request' }, 400, cors); }
      if (!input || typeof input.id !== 'string') return authJson({ error: 'invalid_container_id' }, 400, cors);
      id = input.id;
      if (input.createdAt !== undefined && typeof input.createdAt !== 'string') return authJson({ error: 'invalid_request' }, 400, cors);
      createdAt = input.createdAt ?? null;
    }
    const { container } = await runningContainer(env, user.id, id);
    if (!container || (createdAt && container.createdAt !== createdAt)) return authJson({ error: 'container_not_running' }, 409, cors);
    const expiresAt = Math.min(Date.now() + ACCESS_LIMITS.sshTokenLifetimeMs, Date.parse(container.expiresAt));
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return authJson({ error: 'container_not_running' }, 409, cors);
    const hostname = env.SSH_HOSTNAME || 'ssh.mainbrella.com';
    if (!/^(?=.{1,253}$)[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(hostname)) throw new Error('invalid_ssh_hostname');
    const token = randomToken();
    await env.DB.prepare('DELETE FROM ssh_access_tokens WHERE expires_at <= ?').bind(Date.now()).run();
    const saved = await env.DB.prepare(
      `INSERT INTO ssh_access_tokens (token_hash, user_id, container_created_at, container_id, expires_at)
       SELECT ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM ssh_access_tokens WHERE user_id = ?) < ?`,
    ).bind(await hashToken(token), user.id, container.createdAt, container.id, expiresAt, user.id, ACCESS_LIMITS.maxSSHAccessTokens).run();
    if (!saved.meta.changes) return authJson({ error: 'ssh_token_limit' }, 429, cors);
    return authJson({
      command: `ssh -o ProxyCommand='cloudflared access ssh --hostname %h' ${token}@${hostname}`,
      expiresAt, hostname,
    }, 200, cors);
  } catch (error) {
    const failure = containerError(error, 'ssh_unavailable');
    return authJson({ error: failure.error }, failure.status, cors);
  }
}
