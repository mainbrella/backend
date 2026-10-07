import { authCorsHeaders, authJson } from './auth-core';
import { containerUser } from './container-auth';
import { runningContainer, containerError } from '../lib/container-service';
import { resolveEntitlement } from '../lib/entitlements';
import { validContainerId } from '../../containers/container-account-core.js';
import { boundedPrivateBody, validServiceName, validPrivateMember } from '../../containers/private-services-contract.js';

export function privateServicesConfigured(env: Env): boolean {
  return Boolean(env.USER_CONTAINER && env.CONTAINER_ACCOUNT && (env.PRIVATE_SERVICES_ENABLED === 'true' || env.LOCAL_DEV === 'true'));
}

export async function handlePrivateServicesRequest(request: Request, env: Env): Promise<Response> {
  const cors = authCorsHeaders(request);
  if (cors === null) return authJson({ error: 'origin_not_allowed' }, 403, {});
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const url = new URL(request.url), members = url.pathname === '/private-services/members';
  if (!members && url.pathname !== '/private-services/networks') return authJson({ error: 'not_found' }, 404, cors);
  const methods = members ? ['PUT', 'DELETE'] : ['GET', 'POST', 'DELETE'];
  if (!methods.includes(request.method)) return authJson({ error: 'method_not_allowed' }, 405, { ...cors, allow: [...methods, 'OPTIONS'].join(', ') });
  if (request.method !== 'GET' && !request.headers.has('Origin') && !request.headers.has('Authorization')) return authJson({ error: 'origin_required' }, 403, cors);
  const network = url.searchParams.get('network'), needsNetwork = members || request.method === 'DELETE';
  if (needsNetwork ? !validServiceName(network) || url.searchParams.size !== 1 : url.search !== '') return authJson({ error: 'invalid_request' }, 400, cors);
  try {
    const user = await containerUser(env, request);
    if (!user) return authJson({ error: 'not_authenticated' }, 401, cors);
    if (!env.CONTAINER_ACCOUNT || !env.USER_CONTAINER) throw new Error('private_services_unavailable');
    if (['POST', 'PUT'].includes(request.method) && !privateServicesConfigured(env)) return authJson({ error: 'private_services_unavailable' }, 503, cors);
    let body: unknown;
    if (members || request.method === 'POST') {
      try {
        const bytes = await boundedPrivateBody(request.body, 1024);
        body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } catch (error) {
        const large = error instanceof Error && error.message === 'request_too_large';
        return authJson({ error: large ? 'request_too_large' : 'invalid_request' }, large ? 413 : 400, cors);
      }
      if (members) {
        if (!validPrivateMember(body) || !validContainerId(body.id)) return authJson({ error: 'invalid_request' }, 400, cors);
        if (request.method === 'PUT') {
          const running = await runningContainer(env, user.id, body.id);
          if (!running.container || running.container.createdAt !== body.createdAt) return authJson({ error: 'container_not_running' }, 409, cors);
        }
      } else {
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1
          || !validServiceName((body as { name?: unknown }).name)) return authJson({ error: 'invalid_request' }, 400, cors);
        if (!(await resolveEntitlement(env, user.id)).active) return authJson({ error: 'subscription_required' }, 402, cors);
      }
    }
    const target = new URL(`https://internal${url.pathname}`);
    target.search = url.search;
    const account = env.CONTAINER_ACCOUNT.get(env.CONTAINER_ACCOUNT.idFromName(`account:${user.id}`));
    const response = await account.fetch(new Request(target, { method: request.method,
      headers: { 'x-mainbrella-user': user.id, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    // Never return private runtime headers or caller-supplied identity fields.
    return authJson(await response.json(), response.status, cors);
  } catch (error) {
    const failure = containerError(error, 'private_services_unavailable');
    return authJson({ error: failure.error }, failure.status, cors);
  }
}
