import { authCorsHeaders, authJson } from './auth-core';
import { containerUser } from './container-auth';

export function activityConfigured(env: Env): boolean {
  return Boolean(env.ACCOUNT_ACTIVITY && env.USER_CONTAINER && env.ACTIVITY_WEBSOCKET_ENABLED === 'true');
}

export async function handleActivityRequest(request: Request, env: Env): Promise<Response> {
  const cors = authCorsHeaders(request);
  if (cors === null) return authJson({ error: 'origin_not_allowed' }, 403, {});
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'GET') return authJson({ error: 'method_not_allowed' }, 405, { ...cors, allow: 'GET, OPTIONS' });
  const url = new URL(request.url);
  if (url.pathname !== '/containers/activity' || url.search) return authJson({ error: 'invalid_request' }, 400, cors);
  // Native clients authenticate in a header; cookie clients must supply Origin.
  // Credentials in URLs, protocol headers and client-selected account IDs are rejected.
  if (!request.headers.has('Authorization') && !request.headers.get('Origin')) return authJson({ error: 'origin_required' }, 403, cors);
  try {
    const user = await containerUser(env, request);
    if (!user) return authJson({ error: 'not_authenticated' }, 401, cors);
    if (!activityConfigured(env)) return authJson({ error: 'activity_unavailable' }, 503, cors);
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return authJson({ error: 'websocket_required' }, 426, cors);
    const hub = env.ACCOUNT_ACTIVITY.get(env.ACCOUNT_ACTIVITY.idFromName(`activity:${user.id}`));
    const response = await hub.fetch(new Request('https://internal/activity', {
      headers: { Upgrade: 'websocket', 'x-mainbrella-user': user.id },
    }));
    if (response.status === 101) return response;
    if (response.status === 429) return authJson({ error: 'activity_connection_limit' }, 429, cors);
    return authJson({ error: 'activity_unavailable' }, 503, cors);
  } catch { return authJson({ error: 'activity_unavailable' }, 503, cors); }
}
