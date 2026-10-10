import { authCorsHeaders, authJson } from './auth-core';
import { containerUser } from './container-auth';
import { runningContainer, containerError } from '../lib/container-service';
import { machineName, validContainerId } from '../../containers/container-account-core.js';
import { MAX_PREVIEW_GRANTS, validPreviewId, validPreviewOptions, validPreviewToken } from '../../containers/preview-contract.js';
import { previewOrigin, previewsConfigured, previewTokenHash, validPreviewGeneration, validPreviewGrant,
  type PreviewGrant } from '../lib/preview-routing';

async function readOptions(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('invalid_request');
  let size = 0;
  let text = '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024) throw new Error('request_too_large');
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

const publicGrant = (grant: PreviewGrant): PreviewGrant => ({
  id: grant.id, port: grant.port, createdAt: grant.createdAt, expiresAt: grant.expiresAt,
});

export async function handlePreviewRequest(request: Request, env: Env): Promise<Response> {
  const cors = authCorsHeaders(request);
  if (cors === null) return authJson({ error: 'origin_not_allowed' }, 403, {});
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  try {
    const user = await containerUser(env, request);
    if (!user) return authJson({ error: 'not_authenticated' }, 401, cors);
    return handleOwnedPreviewRequest(request, env, user.id);
  } catch (error) {
    const failure = containerError(error, 'previews_unavailable');
    return authJson({ error: failure.error }, failure.status, cors);
  }
}

// Internal workflows supply a server-resolved owner; no browser credentials are
// stored in a long-running job. This function is not registered as an API route.
export async function handleOwnedPreviewRequest(request: Request, env: Env, userId: string): Promise<Response> {
  const cors = authCorsHeaders(request);
  if (cors === null) return authJson({ error: 'origin_not_allowed' }, 403, {});
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (!['GET', 'POST', 'DELETE'].includes(request.method)) {
    return authJson({ error: 'method_not_allowed' }, 405, { ...cors, allow: 'GET, POST, DELETE, OPTIONS' });
  }
  if (request.method !== 'GET' && !request.headers.get('Origin') && !request.headers.has('Authorization')) {
    return authJson({ error: 'origin_required' }, 403, cors);
  }
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  const createdAt = url.searchParams.get('createdAt');
  const previewId = url.searchParams.get('previewId');
  const allowed = request.method === 'DELETE' ? ['id', 'createdAt', 'previewId'] : ['id', 'createdAt'];
  if ([...url.searchParams.keys()].some(key => !allowed.includes(key) || url.searchParams.getAll(key).length !== 1)) {
    return authJson({ error: 'invalid_request' }, 400, cors);
  }
  if (!id || !validContainerId(id)) return authJson({ error: 'invalid_container_id' }, 400, cors);
  if (!validPreviewGeneration(createdAt)) return authJson({ error: 'invalid_generation' }, 400, cors);
  if (request.method === 'DELETE' && !validPreviewId(previewId)) return authJson({ error: 'invalid_request' }, 400, cors);
  try {
    // Disabling issuance must not prevent owners from inspecting/revoking grants
    // left by lost responses or already attached transports.
    if (request.method === 'POST' && !previewsConfigured(env)) return authJson({ error: 'previews_unavailable' }, 503, cors);
    if (!env.USER_CONTAINER) throw new Error('previews_unavailable');
    let options: { port: number; ttlSeconds?: number } | undefined;
    if (request.method === 'POST') {
      let body: unknown;
      try { body = await readOptions(request); } catch (error) {
        const large = error instanceof Error && error.message === 'request_too_large';
        return authJson({ error: large ? 'request_too_large' : 'invalid_request' }, large ? 413 : 400, cors);
      }
      if (!validPreviewOptions(body)) return authJson({ error: 'invalid_request' }, 400, cors);
      options = body;
    }
    const running = await runningContainer(env, userId, id);
    const expiresAt = running.container ? Date.parse(running.container.expiresAt) : NaN;
    if (!running.stub || running.container?.createdAt !== createdAt || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) {
      return authJson({ error: 'container_not_running' }, 409, cors);
    }
    const stub = running.stub;
    const name = machineName(userId, id);
    const database = env.PREVIEW_ROUTES!;
    const internal = (method: string, grantId?: string) => {
      const target = new URL('https://internal/previews');
      if (grantId) target.searchParams.set('previewId', grantId);
      return new Request(target, { method, headers: { 'x-preview-created-at': createdAt,
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
        ...(method === 'POST' ? { body: JSON.stringify(options) } : {}) });
    };
    const removeRoute = async (grantId: string) => {
      // Scope all mutations by the owner-resolved address AND exact generation.
      const result = await database.prepare('DELETE FROM preview_routes WHERE preview_id = ? AND container_name = ? AND created_at = ?')
        .bind(grantId, name, createdAt).run();
      if (!result.success) throw new Error('preview_index_unavailable');
    };
    const revoke = async (grantId: string) => {
      // Both cleanup operations run even when one fails. A retry with the same
      // previewId reconciles partial failures without recovering the raw token.
      let complete = true;
      try { await removeRoute(grantId); } catch { complete = false; }
      try {
        const response = await stub.fetch(internal('DELETE', grantId));
        const result = await response.json() as { revoked?: boolean };
        if (!response.ok || result.revoked !== true) complete = false;
      } catch { complete = false; }
      return complete;
    };
    if (request.method === 'DELETE') {
      return await revoke(previewId!) ? authJson({ revoked: true }, 200, cors)
        : authJson({ error: 'preview_reconciliation_required', previewId }, 503, cors);
    }
    const response = await stub.fetch(internal(request.method));
    if (!response.ok) {
      const failure = await response.json().catch(() => ({})) as { error?: string };
      if (response.status === 409 && failure.error === 'container_not_running'
        || response.status === 429 && failure.error === 'preview_limit') return authJson({ error: failure.error }, response.status, cors);
      throw new Error('previews_unavailable');
    }
    const result = await response.json() as PreviewGrant & { token?: string; previews?: PreviewGrant[] };
    if (request.method === 'GET') {
      if (!Array.isArray(result.previews) || result.previews.length > MAX_PREVIEW_GRANTS
        || !result.previews.every(grant => validPreviewGrant(grant, createdAt))) throw new Error('previews_unavailable');
      return authJson({ previews: result.previews.map(publicGrant) }, 200, cors);
    }
    try {
      if (response.status !== 201 || !validPreviewGrant(result, createdAt) || result.port !== options!.port
        || result.expiresAt > expiresAt || !validPreviewToken(result.token)) throw new Error('invalid_preview_response');
      const inserted = await database.prepare(`INSERT INTO preview_routes
        (token_hash, preview_id, container_name, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`)
        .bind(await previewTokenHash(result.token), result.id, name, createdAt, result.expiresAt).run();
      if (!inserted.success) throw new Error('preview_index_unavailable');
      return authJson({ ...publicGrant(result), url: `${previewOrigin(env, result.token)}/` }, 201, cors);
    } catch {
      if (validPreviewId(result.id) && !await revoke(result.id)) {
        return authJson({ error: 'preview_reconciliation_required', previewId: result.id }, 503, cors);
      }
      throw new Error('previews_unavailable');
    }
  } catch (error) {
    const failure = containerError(error, 'previews_unavailable');
    return authJson({ error: failure.error }, failure.status, cors);
  }
}
