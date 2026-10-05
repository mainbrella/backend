import { authCorsHeaders, authJson, currentUser } from './auth-core';

// Browser WebSockets carry the HttpOnly session cookie. Require an explicit
// trusted Origin even for GET to prevent cross-site WebSocket hijacking.
export async function handleTerminalRequest(request: Request, env: Env): Promise<Response> {
  const cors = authCorsHeaders(request);
  if (cors === null) return authJson({ error: 'origin_not_allowed' }, 403, {});
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'GET') return authJson({ error: 'method_not_allowed' }, 405, { ...cors, allow: 'GET, OPTIONS' });
  if (!request.headers.get('Origin')) return authJson({ error: 'origin_required' }, 403, cors);
  if (new URL(request.url).search) return authJson({ error: 'invalid_request' }, 400, cors);
  try {
    const user = await currentUser(env, request);
    if (!user) return authJson({ error: 'not_authenticated' }, 401, cors);
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return authJson({ error: 'websocket_required' }, 426, cors);
    if (!env.USER_CONTAINER) throw new Error('missing_binding');
    const machine = env.USER_CONTAINER.get(env.USER_CONTAINER.idFromName(`user:${user.id}`));
    // Only this account's private DO can choose its shell and lifecycle policy.
    const response = await machine.fetch(new Request('https://internal/terminal', {
      headers: { Upgrade: 'websocket' },
    }));
    if (response.status === 101) return response;
    if ([409, 429].includes(response.status)) {
      return authJson({ error: response.status === 409 ? 'container_not_running' : 'terminal_limit' }, response.status, cors);
    }
    throw new Error('terminal_failed');
  } catch {
    return authJson({ error: 'terminal_unavailable' }, 503, cors);
  }
}
