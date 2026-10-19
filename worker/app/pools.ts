import { authCorsHeaders, authJson } from './auth-core';
import { containerUser } from './container-auth';
import { ownedImage } from './images';
import { resolveEntitlement } from '../lib/entitlements';
import { entitlementHeaders, machineSize } from '../../containers/plan-policy.js';
import { validContainerName, validIdempotencyKey } from '../../containers/container-account-core.js';
import { validPoolId, validPoolSize, validPoolTTL } from '../../containers/pool-contract.js';
import { IMAGE_CATALOG } from '../../containers/image-catalog.js';
import { normalizeNetworkPolicy, normalizeSecretBindings } from '../../containers/security-contract.js';
import { egressConfigured, vaultConfigured } from '../../containers/account-security.js';
import { readFileBytes } from '../../containers/file-contract.js';
import type { ContainerImageSelection } from '../lib/container-service';

export function managedPoolsConfigured(env: Env): boolean {
  return Boolean(env.CONTAINER_ACCOUNT && env.USER_CONTAINER && env.MANAGED_POOLS_ENABLED === 'true');
}

export async function handlePoolsRequest(request: Request, env: Env): Promise<Response> {
  const cors = authCorsHeaders(request, env);
  if (cors === null) return authJson({ error: 'origin_not_allowed' }, 403, {});
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const url = new URL(request.url), match = /^\/pools(?:\/(pool_[a-f0-9-]+)(\/acquire)?)?$/.exec(url.pathname);
  const poolId = match?.[1], acquire = Boolean(match?.[2]);
  if (!match || poolId && !validPoolId(poolId) || url.search) return authJson({ error: 'invalid_request' }, 400, cors);
  const allowed = acquire ? ['POST'] : poolId ? ['GET', 'PATCH', 'DELETE'] : ['GET', 'POST'];
  if (!allowed.includes(request.method)) return authJson({ error: 'method_not_allowed' }, 405, { ...cors, allow: [...allowed, 'OPTIONS'].join(', ') });
  if (request.method !== 'GET' && !request.headers.has('Authorization') && !request.headers.get('Origin')) return authJson({ error: 'origin_required' }, 403, cors);
  const key = request.headers.get('Idempotency-Key');
  if (request.method === 'POST' && !validIdempotencyKey(key)) return authJson({ error: 'invalid_idempotency_key' }, 400, cors);
  try {
    const user = await containerUser(env, request);
    if (!user) return authJson({ error: 'not_authenticated' }, 401, cors);
    if (!env.CONTAINER_ACCOUNT || !env.USER_CONTAINER || !['GET', 'DELETE'].includes(request.method) && !managedPoolsConfigured(env)) return authJson({ error: 'pools_unavailable' }, 503, cors);
    const entitlement = request.method === 'DELETE' ? { active: false, plan: null, validUntil: null } : await resolveEntitlement(env, user.id);
    let forwarded: object | undefined;
    if (['POST', 'PATCH'].includes(request.method)) {
      let body: Record<string, unknown>;
      try {
        const bytes = request.body ? await readFileBytes(request.body, 65536, request.signal) : new Uint8Array();
        body = bytes.length ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) : {};
      } catch (error) { return authJson({ error: error instanceof SyntaxError || error instanceof TypeError ? 'invalid_request' : 'request_too_large' }, error instanceof SyntaxError || error instanceof TypeError ? 400 : 413, cors); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return authJson({ error: 'invalid_request' }, 400, cors);
      const fields = acquire ? [] : request.method === 'PATCH' ? ['name', 'targetSize'] : ['name', 'targetSize', 'ttlSeconds', 'imageId', 'catalogId', 'size', 'internet', 'networkPolicy', 'secretBindings'];
      if (Object.keys(body).some(key => !fields.includes(key)) || request.method === 'PATCH' && !Object.keys(body).length) return authJson({ error: 'invalid_request' }, 400, cors);
      if (body.name !== undefined && !validContainerName(body.name) || body.targetSize !== undefined && !validPoolSize(body.targetSize)) return authJson({ error: 'invalid_request' }, 400, cors);
      if (acquire) forwarded = {};
      else if (request.method === 'PATCH') forwarded = { ...(body.name === undefined ? {} : { name: (body.name as string).trim() }), ...(body.targetSize === undefined ? {} : { targetSize: body.targetSize }) };
      else {
        if (!validContainerName(body.name) || !validPoolSize(body.targetSize) || !validPoolTTL(body.ttlSeconds) || body.size !== undefined && !machineSize(body.size)) return authJson({ error: 'invalid_request' }, 400, cors);
        if (body.internet !== undefined && typeof body.internet !== 'boolean') return authJson({ error: 'invalid_internet_policy' }, 400, cors);
        const networkPolicy = body.networkPolicy === undefined ? undefined : normalizeNetworkPolicy(body.networkPolicy);
        const secretBindings = body.secretBindings === undefined ? undefined : normalizeSecretBindings(body.secretBindings);
        if (networkPolicy === null || secretBindings === null || networkPolicy && body.internet === true || secretBindings && !networkPolicy) return authJson({ error: 'invalid_network_policy' }, 400, cors);
        if (networkPolicy && !egressConfigured(env) || body.internet === false && !networkPolicy && env.NETWORK_INTERNET_CONTROL_ENABLED !== 'true') return authJson({ error: 'network_policy_unavailable' }, 503, cors);
        if (secretBindings?.length && !vaultConfigured(env)) return authJson({ error: 'secrets_unavailable' }, 503, cors);
        const common = { size: (body.size ?? 'lite') as string, internet: networkPolicy ? false : (body.internet ?? true) as boolean,
          ...(networkPolicy ? { networkPolicy } : {}), ...(secretBindings ? { secretBindings } : {}) };
        let launch: ContainerImageSelection, imageSelection: { imageId?: string; catalogId?: string };
        if (body.imageId !== undefined) {
          if (typeof body.imageId !== 'string' || body.catalogId !== undefined) return authJson({ error: 'invalid_request' }, 400, cors);
          const image = await ownedImage(env, user.id, body.imageId);
          if (!image) return authJson({ error: 'image_not_found' }, 404, cors);
          if (image.status !== 'ready') return authJson({ error: 'image_not_ready' }, 409, cors);
          launch = { ...common, imageId: image.id, imageKey: image.image_key, imageName: image.name };
          imageSelection = { imageId: image.id };
        } else {
          const image = IMAGE_CATALOG.find(image => image.id === (body.catalogId ?? 'node'));
          if (!image) return authJson({ error: 'image_not_found' }, 404, cors);
          launch = { ...common, imageKey: image.key, imageName: image.name };
          imageSelection = { catalogId: image.id };
        }
        forwarded = { name: (body.name as string).trim(), targetSize: body.targetSize, ttlSeconds: body.ttlSeconds, selection: { ...common, ...imageSelection }, launch };
      }
    }
    const response = await env.CONTAINER_ACCOUNT.get(env.CONTAINER_ACCOUNT.idFromName(`account:${user.id}`)).fetch(new Request(`https://internal${url.pathname}`, {
      method: request.method, headers: { ...entitlementHeaders(entitlement), 'x-mainbrella-user': user.id,
        ...(key && request.method === 'POST' ? { 'Idempotency-Key': key } : {}), ...(forwarded ? { 'Content-Type': 'application/json' } : {}) },
      ...(forwarded ? { body: JSON.stringify(forwarded) } : {}),
    }));
    return authJson(await response.json(), response.status, cors);
  } catch { return authJson({ error: 'pools_unavailable' }, 503, cors); }
}
