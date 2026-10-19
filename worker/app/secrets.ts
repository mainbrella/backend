import { authCorsHeaders, authJson } from './auth-core';
import { containerUser } from './container-auth';
import { resolveEntitlement } from '../lib/entitlements';
import { entitlementHeaders } from '../../containers/plan-policy.js';
import { readFileBytes } from '../../containers/file-contract.js';
import { securityAccountEnabled } from '../../containers/security-rollout.js';

export async function handleSecretsRequest(request: Request, env: Env): Promise<Response> {
  const cors = authCorsHeaders(request, env);
  if (cors === null) return authJson({ error: 'origin_not_allowed' }, 403, {});
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const url = new URL(request.url), match = /^\/secrets(?:\/(sec_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}))?$/.exec(url.pathname);
  if (!match || url.search) return authJson({ error: 'invalid_request' }, 400, cors);
  const allowed = match[1] ? ['PUT', 'DELETE'] : ['GET', 'POST'];
  if (!allowed.includes(request.method)) return authJson({ error: 'method_not_allowed' }, 405, { ...cors, allow: [...allowed, 'OPTIONS'].join(', ') });
  if (request.method !== 'GET' && !request.headers.get('Origin') && !request.headers.has('Authorization')) return authJson({ error: 'origin_required' }, 403, cors);
  try {
    const user = await containerUser(env, request);
    if (!user) return authJson({ error: 'not_authenticated' }, 401, cors);
    if (!env.CONTAINER_ACCOUNT) return authJson({ error: 'secrets_unavailable' }, 503, cors);
    const writesValue = request.method === 'POST' || request.method === 'PUT';
    if (writesValue && (env.SECRETS_VAULT_ENABLED !== 'true' || !securityAccountEnabled(env, user.id))) return authJson({ error: 'secrets_unavailable' }, 503, cors);
    // Revocation and metadata access remain possible after billing or issuance stops.
    const entitlement = writesValue ? await resolveEntitlement(env, user.id) : { plan: null, active: false, validUntil: null };
    let body: Uint8Array | undefined;
    if (writesValue) {
      try { body = await readFileBytes(request.body, 8192, request.signal); }
      catch { return authJson({ error: 'request_too_large' }, 413, cors); }
    }
    const internal = new URL('https://internal/secrets');
    if (match[1]) internal.searchParams.set('secretId', match[1]);
    const response = await env.CONTAINER_ACCOUNT.get(env.CONTAINER_ACCOUNT.idFromName(`account:${user.id}`)).fetch(new Request(internal, {
      method: request.method,
      headers: { ...entitlementHeaders(entitlement), 'x-mainbrella-user': user.id, 'Content-Type': 'application/json' },
      ...(body ? { body: new Uint8Array(body).buffer } : {}),
    }));
    return authJson(await response.json(), response.status, cors);
  } catch { return authJson({ error: 'secrets_unavailable' }, 503, cors); }
}
