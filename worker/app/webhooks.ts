import { authCorsHeaders, authJson } from './auth-core';
import { containerUser } from './container-auth';
import { runningContainer, containerError } from '../lib/container-service';
import { machineName, validContainerId } from '../../containers/container-account-core.js';
import { readFileBytes } from '../../containers/file-contract.js';
import { validExecutionId } from '../../containers/execution-contract.js';
import { readWebhookBody, webhookUrl, webhooksConfigured } from '../../containers/webhook-contract.js';

export async function handleWebhookRequest(request: Request, env: Env): Promise<Response> {
  const cors = authCorsHeaders(request);
  if (cors === null) return authJson({ error: 'origin_not_allowed' }, 403, {});
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const url = new URL(request.url), suffix = url.pathname.slice('/containers/webhook'.length);
  if (!['', '/deliveries', '/retry'].includes(suffix)) return authJson({ error: 'not_found' }, 404, cors);
  const methods = suffix === '/deliveries' ? ['GET'] : suffix === '/retry' ? ['POST'] : ['GET', 'PUT', 'DELETE'];
  if (!methods.includes(request.method)) return authJson({ error: 'method_not_allowed' }, 405, { ...cors, allow: `${methods.join(', ')}, OPTIONS` });
  if (request.method !== 'GET' && !request.headers.get('Origin') && !request.headers.has('Authorization')) return authJson({ error: 'origin_required' }, 403, cors);
  const id = url.searchParams.get('id'), createdAt = url.searchParams.get('createdAt');
  if ([...url.searchParams.keys()].some(key => !['id', 'createdAt'].includes(key) || url.searchParams.getAll(key).length !== 1)
    || !id || !validContainerId(id)) return authJson({ error: 'invalid_request' }, 400, cors);
  if (!createdAt || createdAt.length > 32 || !Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) return authJson({ error: 'invalid_generation' }, 400, cors);
  try {
    const user = await containerUser(env, request);
    if (!user) return authJson({ error: 'not_authenticated' }, 401, cors);
    if (!env.USER_CONTAINER) throw new Error('webhooks_unavailable');
    let body;
    if (request.method === 'PUT' || suffix === '/retry') {
      if (!webhooksConfigured(env)) return authJson({ error: 'webhooks_not_configured' }, 503, cors);
      try { body = await readWebhookBody(request); } catch { return authJson({ error: 'invalid_request' }, 400, cors); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return authJson({ error: 'invalid_request' }, 400, cors);
      if (suffix === '/retry') {
        if (Object.keys(body).length !== 1 || !('eventId' in body) || !validExecutionId(body.eventId)) return authJson({ error: 'invalid_request' }, 400, cors);
      } else if (Object.keys(body).some(key => !['url', 'replayFromCursor'].includes(key)) || !('url' in body) || !webhookUrl(body.url, env.WEBHOOK_ALLOWED_HOSTS)
        || 'replayFromCursor' in body && (!Number.isSafeInteger(body.replayFromCursor) || Number(body.replayFromCursor) < 0)) return authJson({ error: 'invalid_webhook' }, 400, cors);
    }
    let stub = env.USER_CONTAINER.get(env.USER_CONTAINER.idFromName(machineName(user.id, id)));
    const headers: Record<string, string> = { 'x-exec-created-at': createdAt, 'x-exec-container-id': id };
    if (request.method === 'PUT') {
      const running = await runningContainer(env, user.id, id);
      if (!running.stub || running.container?.createdAt !== createdAt) return authJson({ error: 'container_not_running' }, 409, cors);
      stub = running.stub; headers['x-exec-expires-at'] = String(Date.parse(running.container.expiresAt));
    }
    if (body) headers['Content-Type'] = 'application/json';
    const response = await stub.fetch(new Request(`https://internal/observations/webhook${suffix}`, { method: request.method, headers,
      ...(body ? { body: JSON.stringify(body) } : {}), signal: request.signal }));
    const bytes = await readFileBytes(response.body, 128 * 1024, request.signal);
    const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!response.ok) {
      if ([400, 404, 409, 429, 503].includes(response.status) && ['invalid_request', 'invalid_webhook', 'invalid_cursor', 'webhook_limit', 'webhook_retry_limit',
        'webhooks_not_configured', 'container_not_running', 'delivery_not_found', 'delivery_not_retryable'].includes(result?.error)) return authJson({ error: result.error }, response.status, cors);
      throw new Error('webhooks_unavailable');
    }
    return authJson(result, response.status, cors);
  } catch (error) { const failure = containerError(error, 'webhooks_unavailable'); return authJson({ error: failure.error }, failure.status, cors); }
}
