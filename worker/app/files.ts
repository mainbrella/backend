import { authCorsHeaders, authJson } from './auth-core';
import { containerUser } from './container-auth';
import { runningContainer, containerError } from '../lib/container-service';
import { validContainerId } from '../../containers/container-account-core.js';
import { MAX_FILE_BYTES, readFileBytes, validFilePath } from '../../containers/file-contract.js';

export async function handleFileRequest(request: Request, env: Env): Promise<Response> {
  const cors = authCorsHeaders(request);
  if (cors === null) return authJson({ error: 'origin_not_allowed' }, 403, {});
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (!['GET', 'PUT'].includes(request.method)) return authJson({ error: 'method_not_allowed' }, 405, { ...cors, allow: 'GET, PUT, OPTIONS' });
  if (request.method === 'PUT' && !request.headers.get('Origin') && !request.headers.has('Authorization')) return authJson({ error: 'origin_required' }, 403, cors);
  const params = new URL(request.url).searchParams;
  const id = params.get('id');
  const createdAt = params.get('createdAt');
  const path = params.get('path');
  if ([...params.keys()].some(key => !['id', 'createdAt', 'path'].includes(key) || params.getAll(key).length !== 1)
    || !id || !validContainerId(id)) return authJson({ error: 'invalid_container_id' }, 400, cors);
  if (!createdAt || createdAt.length > 32 || !Number.isFinite(Date.parse(createdAt))
    || new Date(createdAt).toISOString() !== createdAt) return authJson({ error: 'invalid_generation' }, 400, cors);
  if (!validFilePath(path)) return authJson({ error: 'invalid_file_path' }, 400, cors);
  try {
    const user = await containerUser(env, request);
    if (!user) return authJson({ error: 'not_authenticated' }, 401, cors);
    let input;
    try { input = request.method === 'PUT' ? await readFileBytes(request.body, MAX_FILE_BYTES, request.signal) : undefined; }
    catch (error) {
      const large = error instanceof Error && error.message === 'file_too_large';
      return authJson({ error: large ? 'file_too_large' : 'invalid_request' }, large ? 413 : 400, cors);
    }
    const { stub, container } = await runningContainer(env, user.id, id);
    const expiresAt = container ? Date.parse(container.expiresAt) : NaN;
    if (!container || container.createdAt !== createdAt || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) {
      return authJson({ error: 'container_not_running' }, 409, cors);
    }
    const url = new URL('https://internal/files');
    url.searchParams.set('path', path);
    const response = await stub!.fetch(new Request(url, {
      method: request.method,
      headers: { 'Content-Type': 'application/octet-stream', 'x-exec-created-at': createdAt, 'x-exec-expires-at': String(expiresAt) },
      body: input, signal: request.signal,
    }));
    if (!response.ok) {
      const failure: Record<number, string> = { 403: 'file_access_denied', 404: 'file_not_found', 413: 'file_too_large', 429: 'execution_limit' };
      if (response.status === 409) {
        const data = await response.json() as { error?: string };
        return authJson({ error: data.error === 'not_regular_file' ? 'not_regular_file' : 'container_not_running' }, 409, cors);
      }
      if (failure[response.status]) return authJson({ error: failure[response.status] }, response.status, cors);
      throw new Error('files_unavailable');
    }
    if (request.method === 'PUT') return authJson({ path, size: input!.byteLength }, 200, cors);
    const bytes = await readFileBytes(response.body, MAX_FILE_BYTES, request.signal);
    return new Response(bytes, { headers: { ...cors, 'content-type': 'application/octet-stream',
      'content-disposition': 'attachment', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
  } catch (error) {
    const failure = containerError(error, 'files_unavailable');
    return authJson({ error: failure.error }, failure.status, cors);
  }
}
