import { authCorsHeaders, authJson } from './auth-core';
import { containerUser } from './container-auth';
import { resolveEntitlement } from '../lib/entitlements';
import { entitlementHeaders } from '../../containers/plan-policy.js';
import { validContainerId, validContainerName, validIdempotencyKey } from '../../containers/container-account-core.js';
import { readFileBytes } from '../../containers/file-contract.js';

export function filesystemLifecycleConfigured(env: Env): boolean {
  return Boolean(env.CONTAINER_ACCOUNT && env.USER_CONTAINER && env.WORKSPACE_PERSISTENCE_ENABLED === 'true' && env.WORKSPACE_LIFECYCLE_ENABLED === 'true');
}

export async function handleContainerLifecycleRequest(request: Request, env: Env): Promise<Response> {
  const cors = authCorsHeaders(request);
  if (cors === null) return authJson({ error: 'origin_not_allowed' }, 403, {});
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return authJson({ error: 'method_not_allowed' }, 405, { ...cors, allow: 'POST, OPTIONS' });
  if (!request.headers.get('Origin') && !request.headers.has('Authorization')) return authJson({ error: 'origin_required' }, 403, cors);
  const url = new URL(request.url);
  if (url.search || !['/containers/stop', '/containers/resume', '/containers/fork'].includes(url.pathname)) return authJson({ error: 'invalid_request' }, 400, cors);
  const key = request.headers.get('Idempotency-Key');
  if (!validIdempotencyKey(key)) return authJson({ error: 'invalid_idempotency_key' }, 400, cors);
  try {
    const user = await containerUser(env, request);
    if (!user) return authJson({ error: 'not_authenticated' }, 401, cors);
    if (!filesystemLifecycleConfigured(env)) return authJson({ error: 'persistence_unavailable' }, 503, cors);
    let bytes: Uint8Array;
    try { bytes = await readFileBytes(request.body, 2048, request.signal); }
    catch { return authJson({ error: 'request_too_large' }, 413, cors); }
    let body;
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { return authJson({ error: 'invalid_request' }, 400, cors); }
    const allowed = url.pathname === '/containers/fork' ? ['id', 'createdAt', 'name'] : ['id', 'createdAt'];
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))
      || !validContainerId(body.id) || typeof body.createdAt !== 'string' || !Number.isFinite(Date.parse(body.createdAt))
      || new Date(body.createdAt).toISOString() !== body.createdAt || body.name !== undefined && !validContainerName(body.name)) {
      return authJson({ error: 'invalid_request' }, 400, cors);
    }
    const entitlement = await resolveEntitlement(env, user.id);
    const account = env.CONTAINER_ACCOUNT.get(env.CONTAINER_ACCOUNT.idFromName(`account:${user.id}`));
    const response = await account.fetch(new Request(`https://internal${url.pathname}`, {
      method: 'POST', headers: { ...entitlementHeaders(entitlement), 'x-mainbrella-user': user.id, 'Content-Type': 'application/json', 'Idempotency-Key': key! },
      body: JSON.stringify(body),
    }));
    return authJson(await response.json(), response.status, cors);
  } catch { return authJson({ error: 'containers_unavailable' }, 503, cors); }
}
