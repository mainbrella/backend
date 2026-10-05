import { authCorsHeaders, authJson } from './auth-core';
import { containerUser } from './container-auth';
import { runningContainer, containerError } from '../lib/container-service';
import { validContainerId } from '../../containers/container-account-core.js';
import { readCommandBody, validCommand } from '../../containers/command-contract.js';

export async function handleCommandRequest(request: Request, env: Env): Promise<Response> {
  const cors = authCorsHeaders(request);
  if (cors === null) return authJson({ error: 'origin_not_allowed' }, 403, {});
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return authJson({ error: 'method_not_allowed' }, 405, { ...cors, allow: 'POST, OPTIONS' });
  if (!request.headers.get('Origin') && !request.headers.has('Authorization')) return authJson({ error: 'origin_required' }, 403, cors);
  const params = new URL(request.url).searchParams;
  const id = params.get('id');
  const createdAt = params.get('createdAt');
  if ([...params.keys()].some(key => !['id', 'createdAt'].includes(key) || params.getAll(key).length !== 1)
    || !id || !validContainerId(id)) return authJson({ error: 'invalid_container_id' }, 400, cors);
  if (!createdAt || createdAt.length > 32 || !Number.isFinite(Date.parse(createdAt))
    || new Date(createdAt).toISOString() !== createdAt) return authJson({ error: 'invalid_generation' }, 400, cors);
  try {
    const user = await containerUser(env, request);
    if (!user) return authJson({ error: 'not_authenticated' }, 401, cors);
    let body;
    try { body = await readCommandBody(request); }
    catch (error) {
      const large = error instanceof Error && error.message === 'request_too_large';
      return authJson({ error: large ? 'request_too_large' : 'invalid_request' }, large ? 413 : 400, cors);
    }
    if (!validCommand(body)) return authJson({ error: 'invalid_request' }, 400, cors);
    const { stub, container } = await runningContainer(env, user.id, id);
    const expiresAt = container ? Date.parse(container.expiresAt) : NaN;
    if (!container || container.createdAt !== createdAt || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) {
      return authJson({ error: 'container_not_running' }, 409, cors);
    }
    const response = await stub!.fetch(new Request('https://internal/exec', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-exec-created-at': createdAt,
        'x-exec-expires-at': String(expiresAt),
      },
      body: JSON.stringify(body),
      signal: request.signal,
    }));
    if ([409, 429].includes(response.status)) return authJson({ error: response.status === 409 ? 'container_not_running' : 'execution_limit' }, response.status, cors);
    if (!response.ok) throw new Error('execution_failed');
    return authJson(await response.json(), 200, cors);
  } catch (error) {
    const failure = containerError(error, 'execution_unavailable');
    return authJson({ error: failure.error }, failure.status, cors);
  }
}
