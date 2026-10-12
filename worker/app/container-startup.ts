import { authCorsHeaders, authJson } from './auth-core';
import { containerUser } from './container-auth';
import { resolveEntitlement } from '../lib/entitlements';
import { entitlementHeaders } from '../../containers/plan-policy.js';
import { readFileBytes } from '../../containers/file-contract.js';
import { MAX_WORKSPACE_REQUEST_BYTES } from '../../containers/restore-launch.js';

export async function handleContainerStartupRequest(request: Request, env: Env): Promise<Response> {
  const cors = authCorsHeaders(request);
  if (cors === null) return authJson({ error: 'origin_not_allowed' }, 403, {});
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'PATCH') return authJson({ error: 'method_not_allowed' }, 405, { ...cors, allow: 'PATCH, OPTIONS' });
  if (!request.headers.get('Origin') && !request.headers.has('Authorization')) return authJson({ error: 'origin_required' }, 403, cors);
  if (new URL(request.url).search) return authJson({ error: 'invalid_request' }, 400, cors);
  try {
    const user = await containerUser(env, request);
    if (!user) return authJson({ error: 'not_authenticated' }, 401, cors);
    if (!env.CONTAINER_ACCOUNT || !env.USER_CONTAINER || env.WORKSPACE_PERSISTENCE_ENABLED !== 'true') return authJson({ error: 'persistence_unavailable' }, 503, cors);
    let body: Uint8Array;
    try { body = await readFileBytes(request.body, MAX_WORKSPACE_REQUEST_BYTES, request.signal); }
    catch { return authJson({ error: 'request_too_large' }, 413, cors); }
    const entitlement = await resolveEntitlement(env, user.id);
    const account = env.CONTAINER_ACCOUNT.get(env.CONTAINER_ACCOUNT.idFromName(`account:${user.id}`));
    const response = await account.fetch(new Request('https://internal/containers/startup', { method: 'PATCH',
      headers: { ...entitlementHeaders(entitlement), 'x-mainbrella-user': user.id, 'Content-Type': 'application/json' }, body: new Uint8Array(body).buffer }));
    return authJson(await response.json(), response.status, cors);
  } catch { return authJson({ error: 'containers_unavailable' }, 503, cors); }
}
