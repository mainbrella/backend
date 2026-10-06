import { authCorsHeaders, authJson } from './auth-core';
import { containerUser } from './container-auth';
import { runningContainer, containerError } from '../lib/container-service';
import { machineName, validContainerId, validIdempotencyKey } from '../../containers/container-account-core.js';
import { readCommandBody } from '../../containers/command-contract.js';
import { EXECUTION_SIGNALS, MAX_STDIN_CHUNK_BYTES, validExecution, validExecutionId, validTerminalSize } from '../../containers/execution-contract.js';
import { readFileBytes } from '../../containers/file-contract.js';

export async function handleExecutionRequest(request: Request, env: Env): Promise<Response> {
  const cors = authCorsHeaders(request);
  if (cors === null) return authJson({ error: 'origin_not_allowed' }, 403, {});
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const url = new URL(request.url);
  const match = /^\/containers\/executions(?:\/([a-f0-9-]+)(\/(?:events|stdin|signal|resize))?)?$/.exec(url.pathname);
  if (!match || match[1] && !validExecutionId(match[1])) return authJson({ error: 'not_found' }, 404, cors);
  const starting = !match[1] && request.method === 'POST';
  const events = match[2] === '/events', input = match[2] === '/stdin', signaling = match[2] === '/signal', resizing = match[2] === '/resize';
  const sendingInput = input && request.method === 'POST';
  const allowedMethods = !match[1] ? ['POST', 'GET'] : events ? ['GET'] : input ? ['POST', 'DELETE'] : signaling || resizing ? ['POST'] : ['GET', 'DELETE'];
  if (!allowedMethods.includes(request.method)) {
    return authJson({ error: 'method_not_allowed' }, 405, { ...cors, allow: `${allowedMethods.join(', ')}, OPTIONS` });
  }
  if (request.method !== 'GET' && !request.headers.get('Origin') && !request.headers.has('Authorization')) return authJson({ error: 'origin_required' }, 403, cors);
  const id = url.searchParams.get('id');
  const createdAt = url.searchParams.get('createdAt');
  const allowed = events ? ['id', 'createdAt', 'cursor'] : ['id', 'createdAt'];
  if ([...url.searchParams.keys()].some(key => !allowed.includes(key) || url.searchParams.getAll(key).length !== 1)
    || !id || !validContainerId(id)) return authJson({ error: 'invalid_container_id' }, 400, cors);
  if (!createdAt || createdAt.length > 32 || !Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) {
    return authJson({ error: 'invalid_generation' }, 400, cors);
  }
  const cursor = url.searchParams.get('cursor') ?? '0';
  if (events && (!/^\d+$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))) return authJson({ error: 'invalid_cursor' }, 400, cors);
  try {
    const user = await containerUser(env, request);
    if (!user) return authJson({ error: 'not_authenticated' }, 401, cors);
    if (!env.USER_CONTAINER) throw new Error('execution_unavailable');
    // Inspection/cancellation are owned read/cleanup operations, available even
    // after expiration and during a billing outage. They cannot start a process.
    let stub = env.USER_CONTAINER.get(env.USER_CONTAINER.idFromName(machineName(user.id, id)));
    const headers: Record<string, string> = { 'x-exec-created-at': createdAt };
    let body;
    let inputBytes;
    if (starting) {
      const key = request.headers.get('Idempotency-Key');
      if (!validIdempotencyKey(key)) return authJson({ error: 'invalid_idempotency_key' }, 400, cors);
      try { body = await readCommandBody(request); } catch (error) {
        const large = error instanceof Error && error.message === 'request_too_large';
        return authJson({ error: large ? 'request_too_large' : 'invalid_request' }, large ? 413 : 400, cors);
      }
      if (!validExecution(body)) return authJson({ error: 'invalid_request' }, 400, cors);
      headers['Idempotency-Key'] = key!;
      headers['Content-Type'] = 'application/json';
    }
    if (signaling) {
      try { body = await readCommandBody(request); } catch { return authJson({ error: 'invalid_request' }, 400, cors); }
      if (!body || typeof body !== 'object' || Object.keys(body).length !== 1 || !('signal' in body)
        || typeof body.signal !== 'string' || !EXECUTION_SIGNALS.includes(body.signal)) return authJson({ error: 'invalid_request' }, 400, cors);
      headers['Content-Type'] = 'application/json';
    }
    if (resizing) {
      try { body = await readCommandBody(request); } catch { return authJson({ error: 'invalid_request' }, 400, cors); }
      if (!validTerminalSize(body)) return authJson({ error: 'invalid_request' }, 400, cors);
      headers['Content-Type'] = 'application/json';
    }
    if (sendingInput) {
      try { inputBytes = await readFileBytes(request.body, MAX_STDIN_CHUNK_BYTES, request.signal); }
      catch (error) {
        const large = error instanceof Error && error.message === 'file_too_large';
        return authJson({ error: large ? 'stdin_too_large' : 'invalid_request' }, large ? 413 : 400, cors);
      }
      headers['Content-Type'] = 'application/octet-stream';
    }
    if (starting || sendingInput || resizing) {
      const running = await runningContainer(env, user.id, id);
      const expiresAt = running.container ? Date.parse(running.container.expiresAt) : NaN;
      if (!running.stub || running.container?.createdAt !== createdAt || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) {
        return authJson({ error: 'container_not_running' }, 409, cors);
      }
      stub = running.stub;
      headers['x-exec-expires-at'] = String(expiresAt);
    }
    const internal = new URL(`https://internal/executions${match[1] ? `/${match[1]}${match[2] ?? ''}` : ''}`);
    if (events) internal.searchParams.set('cursor', cursor);
    const response = await stub.fetch(new Request(internal, { method: request.method, headers,
      ...(inputBytes !== undefined ? { body: inputBytes } : body ? { body: JSON.stringify(body) } : {}), signal: request.signal }));
    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as { error?: string };
      const errors = new Set(['invalid_request', 'invalid_cursor', 'invalid_idempotency_key', 'idempotency_key_conflict',
        'container_not_running', 'execution_not_found', 'execution_not_running', 'execution_limit', 'execution_history_limit', 'execution_stream_limit',
        'stdin_closed', 'stdin_too_large', 'stdin_limit', 'stdin_unavailable', 'pty_unavailable']);
      if ([400, 404, 409, 413, 429, 503].includes(response.status) && data.error && errors.has(data.error)) return authJson({ error: data.error }, response.status, cors);
      throw new Error('execution_unavailable');
    }
    if (events) return new Response(response.body, { status: response.status,
      headers: { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    return authJson(await response.json(), response.status, cors);
  } catch (error) {
    const failure = containerError(error, 'execution_unavailable');
    return authJson({ error: failure.error }, failure.status, cors);
  }
}
