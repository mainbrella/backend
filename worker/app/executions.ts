import { authCorsHeaders, authJson } from './auth-core';
import { containerUser } from './container-auth';
import { runningContainer, containerError } from '../lib/container-service';
import { machineName, validContainerId, validIdempotencyKey } from '../../containers/container-account-core.js';
import { readCommandBody } from '../../containers/command-contract.js';
import { validExecution, validExecutionId } from '../../containers/execution-contract.js';

export async function handleExecutionRequest(request: Request, env: Env): Promise<Response> {
  const cors = authCorsHeaders(request);
  if (cors === null) return authJson({ error: 'origin_not_allowed' }, 403, {});
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const url = new URL(request.url);
  const match = /^\/containers\/executions(?:\/([a-f0-9-]+)(\/events)?)?$/.exec(url.pathname);
  if (!match || match[1] && !validExecutionId(match[1])) return authJson({ error: 'not_found' }, 404, cors);
  const starting = !match[1] && request.method === 'POST';
  if (!starting && (!match[1] || !['GET', 'DELETE'].includes(request.method) || match[2] && request.method !== 'GET')) {
    return authJson({ error: 'method_not_allowed' }, 405, { ...cors, allow: !match[1] ? 'POST, OPTIONS' : match[2] ? 'GET, OPTIONS' : 'GET, DELETE, OPTIONS' });
  }
  if (request.method !== 'GET' && !request.headers.get('Origin') && !request.headers.has('Authorization')) return authJson({ error: 'origin_required' }, 403, cors);
  const id = url.searchParams.get('id');
  const createdAt = url.searchParams.get('createdAt');
  const allowed = match[2] ? ['id', 'createdAt', 'cursor'] : ['id', 'createdAt'];
  if ([...url.searchParams.keys()].some(key => !allowed.includes(key) || url.searchParams.getAll(key).length !== 1)
    || !id || !validContainerId(id)) return authJson({ error: 'invalid_container_id' }, 400, cors);
  if (!createdAt || createdAt.length > 32 || !Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) {
    return authJson({ error: 'invalid_generation' }, 400, cors);
  }
  const cursor = url.searchParams.get('cursor') ?? '0';
  if (match[2] && (!/^\d+$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))) return authJson({ error: 'invalid_cursor' }, 400, cors);
  try {
    const user = await containerUser(env, request);
    if (!user) return authJson({ error: 'not_authenticated' }, 401, cors);
    if (!env.USER_CONTAINER) throw new Error('execution_unavailable');
    // Inspection/cancellation are owned read/cleanup operations, available even
    // after expiration and during a billing outage. They cannot start a process.
    let stub = env.USER_CONTAINER.get(env.USER_CONTAINER.idFromName(machineName(user.id, id)));
    const headers: Record<string, string> = { 'x-exec-created-at': createdAt };
    let body;
    if (starting) {
      const key = request.headers.get('Idempotency-Key');
      if (!validIdempotencyKey(key)) return authJson({ error: 'invalid_idempotency_key' }, 400, cors);
      try { body = await readCommandBody(request); } catch (error) {
        const large = error instanceof Error && error.message === 'request_too_large';
        return authJson({ error: large ? 'request_too_large' : 'invalid_request' }, large ? 413 : 400, cors);
      }
      if (!validExecution(body)) return authJson({ error: 'invalid_request' }, 400, cors);
      const running = await runningContainer(env, user.id, id);
      const expiresAt = running.container ? Date.parse(running.container.expiresAt) : NaN;
      if (!running.stub || running.container?.createdAt !== createdAt || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) {
        return authJson({ error: 'container_not_running' }, 409, cors);
      }
      stub = running.stub;
      headers['x-exec-expires-at'] = String(expiresAt);
      headers['Idempotency-Key'] = key!;
      headers['Content-Type'] = 'application/json';
    }
    const internal = new URL(`https://internal/executions${match[1] ? `/${match[1]}${match[2] ?? ''}` : ''}`);
    if (match[2]) internal.searchParams.set('cursor', cursor);
    const response = await stub.fetch(new Request(internal, { method: request.method, headers,
      ...(body ? { body: JSON.stringify(body) } : {}), signal: request.signal }));
    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as { error?: string };
      const errors = new Set(['invalid_request', 'invalid_cursor', 'invalid_idempotency_key', 'idempotency_key_conflict',
        'container_not_running', 'execution_not_found', 'execution_limit', 'execution_history_limit', 'execution_stream_limit']);
      if ([400, 404, 409, 429].includes(response.status) && data.error && errors.has(data.error)) return authJson({ error: data.error }, response.status, cors);
      throw new Error('execution_unavailable');
    }
    if (match[2]) return new Response(response.body, { status: response.status,
      headers: { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    return authJson(await response.json(), response.status, cors);
  } catch (error) {
    const failure = containerError(error, 'execution_unavailable');
    return authJson({ error: failure.error }, failure.status, cors);
  }
}
