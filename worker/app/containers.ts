import { authCorsHeaders, authJson } from './auth-core';
import { ownedImage } from './images';
import { containerUser } from './container-auth';
import { resolveBillingState } from '../lib/entitlements';
import { accountResponse, containerError, syncAccountEntitlement, type ContainerImageSelection } from '../lib/container-service';
import { validContainerId, validIdempotencyKey } from '../../containers/container-account-core.js';
import { machineSize } from '../../containers/plan-policy.js';
import { IMAGE_CATALOG } from '../../containers/image-catalog.js';

export async function handleContainersRequest(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const cors = authCorsHeaders(request);
  if (cors === null) return authJson({ error: 'origin_not_allowed' }, 403, {});
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const url = new URL(request.url);
  if (url.pathname !== '/containers') return authJson({ error: 'not_found' }, 404, cors);
  if (!['GET', 'POST', 'DELETE'].includes(request.method)) return authJson({ error: 'method_not_allowed' }, 405, { ...cors, allow: 'GET, POST, DELETE, OPTIONS' });
  if (request.method !== 'GET' && !request.headers.get('Origin') && !request.headers.has('Authorization')) return authJson({ error: 'origin_required' }, 403, cors);
  const id = url.searchParams.get('id');
  if ([...url.searchParams.keys()].some(key => key !== 'id' && key !== 'createdAt') || (id !== null && (!validContainerId(id) || url.searchParams.getAll('id').length !== 1))) return authJson({ error: 'invalid_container_id' }, 400, cors);
  if (request.method !== 'DELETE' && url.searchParams.has('createdAt')) return authJson({ error: 'invalid_request' }, 400, cors);
  if (url.searchParams.getAll('createdAt').length > 1) return authJson({ error: 'invalid_request' }, 400, cors);
  if (request.method === 'POST' && id !== null) return authJson({ error: 'invalid_request' }, 400, cors);
  const idempotencyKey = request.method === 'POST' ? request.headers.get('Idempotency-Key') : null;
  if (idempotencyKey !== null && !validIdempotencyKey(idempotencyKey)) return authJson({ error: 'invalid_idempotency_key' }, 400, cors);
  try {
    const user = await containerUser(env, request);
    if (!user) return authJson({ error: 'not_authenticated' }, 401, cors);
    const billing = request.method === 'DELETE' ? null : await resolveBillingState(env, user.id);
    const entitlement = billing?.entitlement ?? { plan: null, active: false, validUntil: null };
    // Reject the first unpaid start before reserving quota or asking a machine to boot.
    if (request.method === 'POST' && !entitlement.active) {
      // Propagate an observed loss of payment to existing accounts, including
      // open terminals, even if the signed webhook is delayed. Never-billed
      // users still receive 402 without touching any container coordinator.
      if (billing?.record) {
        const revocation = syncAccountEntitlement(env, user.id, entitlement)
          .catch(() => { console.error('containers_revocation_failed'); });
        if (ctx) ctx.waitUntil(revocation);
        else await revocation;
      }
      return authJson({ error: 'subscription_required' }, 402, cors);
    }
    let selection: ContainerImageSelection | undefined;
    if (request.method === 'POST' && request.body) {
      const body = await request.json().catch(() => null) as { imageId?: unknown; catalogId?: unknown; size?: unknown } | null;
      if (!body || typeof body !== 'object' || Array.isArray(body)) return authJson({ error: 'invalid_request' }, 400, cors);
      if (body.size !== undefined && !machineSize(body.size)) return authJson({ error: 'invalid_size' }, 400, cors);
      if (body.catalogId !== undefined) {
        if (body.imageId !== undefined || typeof body.catalogId !== 'string') return authJson({ error: 'invalid_request' }, 400, cors);
        const image = IMAGE_CATALOG.find(image => image.id === body.catalogId);
        if (!image) return authJson({ error: 'image_not_found' }, 404, cors);
        selection = { imageKey: image.key, imageName: image.name };
      }
      if (body.imageId !== undefined) {
        if (typeof body.imageId !== 'string') return authJson({ error: 'invalid_request' }, 400, cors);
        const image = await ownedImage(env, user.id, body.imageId);
        if (!image) return authJson({ error: 'image_not_found' }, 404, cors);
        if (image.status !== 'ready') return authJson({ error: 'image_not_ready' }, 409, cors);
        selection = { imageKey: image.image_key, imageId: image.id, imageName: image.name };
      }
      if (body.size !== undefined) selection = { ...selection, size: String(body.size) };
    }
    // Forward only the server-resolved image, never browser image keys or resources.
    const response = await accountResponse(env, user.id, entitlement, request.method, id, url.searchParams.get('createdAt'), selection, idempotencyKey);
    const data = await response.json() as { error?: string };
    if ([400, 402, 409, 429].includes(response.status)) return authJson(data, response.status, cors);
    if (!response.ok) throw new Error('machine_request_failed');
    return authJson(data, response.status, cors);
  } catch (error) {
    console.error('containers_request_failed', error instanceof Error ? error.message : 'unknown');
    const failure = containerError(error, 'containers_unavailable');
    return authJson({ error: failure.error }, failure.status, cors);
  }
}
