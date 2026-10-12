import { authCorsHeaders, authJson } from './auth-core';
import { containerUser } from './container-auth';
import { runningContainer, containerError } from '../lib/container-service';
import { validContainerId } from '../../containers/container-account-core.js';
import { fixedByteStream, transferSize, validTransferPath } from '../../containers/file-transfer-contract.js';
import { readFileBytes } from '../../containers/file-contract.js';

export async function handleFileTransferRequest(request: Request, env: Env): Promise<Response> {
  const cors = authCorsHeaders(request);
  if (cors === null) return authJson({ error: 'origin_not_allowed' }, 403, {});
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (!['GET', 'PUT'].includes(request.method)) return authJson({ error: 'method_not_allowed' }, 405, { ...cors, allow: 'GET, PUT, OPTIONS' });
  if (request.method === 'PUT' && !request.headers.get('Origin') && !request.headers.has('Authorization')) return authJson({ error: 'origin_required' }, 403, cors);
  const params = new URL(request.url).searchParams;
  const allowed = ['id', 'createdAt', 'path', ...(request.method === 'PUT' ? ['size'] : [])];
  if ([...params.keys()].some(key => !allowed.includes(key) || params.getAll(key).length !== 1)) return authJson({ error: 'invalid_request' }, 400, cors);
  const id = params.get('id'), createdAt = params.get('createdAt'), path = params.get('path');
  if (!id || !validContainerId(id)) return authJson({ error: 'invalid_container_id' }, 400, cors);
  if (!createdAt || createdAt.length > 32 || !Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) return authJson({ error: 'invalid_generation' }, 400, cors);
  if (!validTransferPath(path)) return authJson({ error: 'invalid_file_path' }, 400, cors);
  const size = request.method === 'PUT' ? transferSize(params.get('size')) : null;
  if (request.method === 'PUT' && size === null) return authJson({ error: 'invalid_transfer_size' }, 400, cors);
  try {
    const user = await containerUser(env, request);
    if (!user) return authJson({ error: 'not_authenticated' }, 401, cors);
    const { stub, container } = await runningContainer(env, user.id, id);
    const expiresAt = container ? Date.parse(container.expiresAt) : NaN;
    if (!container || container.createdAt !== createdAt || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return authJson({ error: 'container_not_running' }, 409, cors);
    const url = new URL('https://internal/files/transfer');
    url.searchParams.set('path', path);
    if (size !== null) url.searchParams.set('size', String(size));
    // Do not buffer in the Worker. The runtime validates again before publishing
    // a file and strips its transfer protocol before returning download bytes.
    const response = await stub!.fetch(new Request(url, {
      method: request.method,
      headers: { 'Content-Type': 'application/octet-stream', 'x-exec-created-at': createdAt, 'x-exec-expires-at': String(expiresAt) },
      body: request.method === 'PUT' ? request.body : undefined, signal: request.signal,
      duplex: 'half',
    } as RequestInit));
    if (!response.ok) {
      const data = JSON.parse(new TextDecoder().decode(await readFileBytes(response.body, 8192, request.signal))) as { error?: string };
      const failures: Record<number, string[]> = { 400: ['file_size_mismatch', 'invalid_request'], 403: ['file_access_denied'],
        404: ['file_not_found'], 409: ['not_regular_file', 'container_not_running'], 413: ['file_too_large'], 429: ['execution_limit'] };
      if (data.error && failures[response.status]?.includes(data.error)) return authJson({ error: data.error }, response.status, cors);
      throw new Error('files_unavailable');
    }
    if (request.method === 'PUT') return authJson({ path, size }, 200, cors);
    const length = transferSize(response.headers.get('content-length'));
    if (length === null) { await response.body?.cancel(); throw new Error('files_unavailable'); }
    return new Response(fixedByteStream(response.body, length, request.signal), { headers: { ...cors,
      'content-type': 'application/octet-stream', 'content-length': String(length), 'content-disposition': 'attachment',
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
  } catch (error) {
    const failure = containerError(error, 'files_unavailable');
    return authJson({ error: failure.error }, failure.status, cors);
  }
}
