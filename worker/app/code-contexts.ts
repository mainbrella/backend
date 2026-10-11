import { authCorsHeaders, authJson } from './auth-core';
import { containerUser } from './container-auth';
import { runningContainer, containerError } from '../lib/container-service';
import { machineName, validContainerId } from '../../containers/container-account-core.js';
import { readCommandBody } from '../../containers/command-contract.js';
import { validCodeContext, validCodeContextId, validCodeExecution } from '../../containers/code-contract.js';

export async function handleCodeContextRequest(request: Request, env: Env): Promise<Response> {
  const cors = authCorsHeaders(request);
  if (cors === null) return authJson({ error: 'origin_not_allowed' }, 403, {});
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const url = new URL(request.url);
  const match = /^\/containers\/code-contexts(?:\/([^/]+)(\/execute)?)?$/.exec(url.pathname);
  if (!match || match[1] && !validCodeContextId(match[1])) return authJson({ error: 'not_found' }, 404, cors);
  const allowed = !match[1] ? ['POST', 'GET'] : match[2] ? ['POST'] : ['DELETE'];
  if (!allowed.includes(request.method)) return authJson({ error: 'method_not_allowed' }, 405, { ...cors, allow: `${allowed.join(', ')}, OPTIONS` });
  if (request.method !== 'GET' && !request.headers.get('Origin') && !request.headers.has('Authorization')) return authJson({ error: 'origin_required' }, 403, cors);
  const id = url.searchParams.get('id'), createdAt = url.searchParams.get('createdAt');
  if (!id || !validContainerId(id) || [...url.searchParams.keys()].some(key => !['id', 'createdAt'].includes(key) || url.searchParams.getAll(key).length !== 1)) return authJson({ error: 'invalid_container_id' }, 400, cors);
  if (!createdAt || createdAt.length > 32 || !Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) return authJson({ error: 'invalid_generation' }, 400, cors);
  try {
    const user = await containerUser(env, request);
    if (!user) return authJson({ error: 'not_authenticated' }, 401, cors);
    if (!env.USER_CONTAINER) throw new Error('code_context_unavailable');
    let stub = env.USER_CONTAINER.get(env.USER_CONTAINER.idFromName(machineName(user.id, id)));
    let body;
    const headers: Record<string, string> = { 'x-exec-created-at': createdAt };
    if (request.method === 'POST') {
      try { body = await readCommandBody(request); } catch (error) {
        const large = error instanceof Error && error.message === 'request_too_large';
        return authJson({ error: large ? 'request_too_large' : 'invalid_request' }, large ? 413 : 400, cors);
      }
      if (!(match[2] ? validCodeExecution(body) : validCodeContext(body))) return authJson({ error: 'invalid_request' }, 400, cors);
      const running = await runningContainer(env, user.id, id);
      const expiresAt = running.container ? Date.parse(running.container.expiresAt) : NaN;
      if (!running.stub || running.container?.createdAt !== createdAt || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return authJson({ error: 'container_not_running' }, 409, cors);
      stub = running.stub;
      headers['x-exec-expires-at'] = String(expiresAt);
      headers['Content-Type'] = 'application/json';
    }
    const response = await stub.fetch(new Request(`https://internal/code-contexts${match[1] ? `/${match[1]}${match[2] ?? ''}` : ''}`, {
      method: request.method, headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: request.signal,
    }));
    const data = await response.json() as { error?: string };
    if (!response.ok && (![400, 404, 409, 413, 429, 503, 504].includes(response.status) || !data.error
      || !['invalid_request', 'container_not_running', 'execution_limit', 'code_context_not_found', 'code_context_busy',
        'code_context_closed', 'code_output_limit', 'code_execution_timeout', 'code_context_unavailable'].includes(data.error))) throw new Error('code_context_unavailable');
    return authJson(data, response.status, cors);
  } catch (error) {
    const result = containerError(error, 'code_context_unavailable');
    return authJson({ error: result.error }, result.status, cors);
  }
}
