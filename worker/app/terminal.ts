import { authCorsHeaders, authJson, currentUser } from './auth-core';

// Browser WebSockets carry the HttpOnly session cookie. Require an explicit
// trusted Origin even for GET to prevent cross-site WebSocket hijacking.
export async function handleTerminalRequest(request: Request, env: Env): Promise<Response> {
  const cors = authCorsHeaders(request);
  if (cors === null) return authJson({ error: 'origin_not_allowed' }, 403, {});
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'GET') return authJson({ error: 'method_not_allowed' }, 405, { ...cors, allow: 'GET, OPTIONS' });
  if (!request.headers.get('Origin')) return authJson({ error: 'origin_required' }, 403, cors);
  const params = new URL(request.url).searchParams;
  const allowed = new Set(['createdAt', 'cols', 'rows']);
  if ([...params.keys()].some(key => !allowed.has(key) || params.getAll(key).length !== 1)) {
    return authJson({ error: 'invalid_request' }, 400, cors);
  }
  const createdAt = params.get('createdAt');
  if (!createdAt || createdAt.length > 32 || !Number.isFinite(Date.parse(createdAt))
    || new Date(createdAt).toISOString() !== createdAt) return authJson({ error: 'invalid_generation' }, 400, cors);
  const dimension = (key: string, fallback: number, max: number) => {
    const value = params.get(key);
    if (value === null) return fallback;
    if (!/^-?\d{1,6}$/.test(value)) return null;
    return Math.max(1, Math.min(max, Number(value)));
  };
  const cols = dimension('cols', 80, 500);
  const rows = dimension('rows', 24, 200);
  if (cols === null || rows === null) return authJson({ error: 'invalid_dimensions' }, 400, cors);
  try {
    const user = await currentUser(env, request);
    if (!user) return authJson({ error: 'not_authenticated' }, 401, cors);
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return authJson({ error: 'websocket_required' }, 426, cors);
    if (!env.USER_CONTAINER) throw new Error('missing_binding');
    const machine = env.USER_CONTAINER.get(env.USER_CONTAINER.idFromName(`user:${user.id}`));
    const state = await machine.fetch(new Request('https://internal/container'));
    if (!state.ok) throw new Error('status_failed');
    const data = await state.json() as { containers?: { createdAt: string; expiresAt: string }[] };
    const current = data.containers?.[0];
    const expiresAt = current ? Date.parse(current.expiresAt) : NaN;
    if (!current || current.createdAt !== createdAt || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) {
      return authJson({ error: 'container_not_running' }, 409, cors);
    }
    // Bind to the current generation and hard deadline, then recheck inside the DO.
    // Only this account's private DO can choose its shell and lifecycle policy.
    const response = await machine.fetch(new Request('https://internal/terminal', {
      headers: {
        Upgrade: 'websocket',
        'x-terminal-created-at': current.createdAt,
        'x-terminal-expires-at': String(expiresAt),
        'x-terminal-cols': String(cols), 'x-terminal-rows': String(rows),
      },
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
