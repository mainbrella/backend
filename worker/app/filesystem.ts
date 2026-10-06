import { authCorsHeaders, authJson } from './auth-core';
import { containerUser } from './container-auth';
import { runningContainer, containerError } from '../lib/container-service';
import { validContainerId } from '../../containers/container-account-core.js';
import { readFileBytes } from '../../containers/file-contract.js';
import { MAX_FILESYSTEM_OUTPUT_BYTES, readFilesystemBody, validFilesystemOperation } from '../../containers/filesystem-contract.js';

const methods: Record<string, string> = { list: 'GET', stat: 'GET', mkdir: 'POST', remove: 'DELETE', move: 'POST', chmod: 'PATCH' };
const failures: Record<number, Set<string>> = {
  400: new Set(['invalid_request']), 403: new Set(['file_access_denied']), 404: new Set(['file_not_found']),
  409: new Set(['container_not_running', 'not_directory', 'file_exists', 'directory_not_empty', 'symlink_not_allowed', 'unsupported_file_name']),
  413: new Set(['directory_too_large']), 429: new Set(['execution_limit']),
};

export async function handleFilesystemRequest(request: Request, env: Env): Promise<Response> {
  const cors = authCorsHeaders(request);
  if (cors === null) return authJson({ error: 'origin_not_allowed' }, 403, {});
  const url = new URL(request.url);
  const operation = url.pathname.slice('/containers/files/'.length);
  if (!methods[operation]) return authJson({ error: 'not_found' }, 404, cors);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== methods[operation]) return authJson({ error: 'method_not_allowed' }, 405, { ...cors, allow: `${methods[operation]}, OPTIONS` });
  if (request.method !== 'GET' && !request.headers.get('Origin') && !request.headers.has('Authorization')) return authJson({ error: 'origin_required' }, 403, cors);
  const params = url.searchParams;
  const extra = operation === 'list' ? ['path', 'limit', 'offset'] : operation === 'stat' ? ['path', 'followSymlinks']
    : operation === 'remove' ? ['path', 'recursive'] : operation === 'chmod' ? ['path'] : [];
  if ([...params.keys()].some(key => !['id', 'createdAt', ...extra].includes(key) || params.getAll(key).length !== 1)) return authJson({ error: 'invalid_request' }, 400, cors);
  const id = params.get('id'), createdAt = params.get('createdAt');
  if (!id || !validContainerId(id)) return authJson({ error: 'invalid_container_id' }, 400, cors);
  if (!createdAt || createdAt.length > 32 || !Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) return authJson({ error: 'invalid_generation' }, 400, cors);
  try {
    const user = await containerUser(env, request);
    if (!user) return authJson({ error: 'not_authenticated' }, 401, cors);
    let body: unknown;
    try {
      if (['mkdir', 'move', 'chmod'].includes(operation)) {
        body = await readFilesystemBody(request);
        if (operation === 'chmod') {
          if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'mode')) throw new Error('invalid_request');
          body = { ...body, path: params.get('path') };
        }
      } else {
        const values: Record<string, unknown> = { path: params.get('path') };
        for (const name of extra.filter(key => key !== 'path')) {
          const text = params.get(name);
          if (text === null) continue;
          if (['limit', 'offset'].includes(name)) {
            if (!/^\d+$/.test(text)) throw new Error('invalid_request');
            values[name] = Number(text);
          } else {
            if (!['true', 'false'].includes(text)) throw new Error('invalid_request');
            values[name] = text === 'true';
          }
        }
        body = values;
      }
    } catch { return authJson({ error: 'invalid_request' }, 400, cors); }
    if (!validFilesystemOperation(operation, body)) return authJson({ error: 'invalid_request' }, 400, cors);
    const { stub, container } = await runningContainer(env, user.id, id);
    const expiresAt = container ? Date.parse(container.expiresAt) : NaN;
    if (!container || container.createdAt !== createdAt || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return authJson({ error: 'container_not_running' }, 409, cors);
    const response = await stub!.fetch(new Request(`https://internal/filesystem/${operation}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-exec-created-at': createdAt, 'x-exec-expires-at': String(expiresAt) },
      body: JSON.stringify(body), signal: request.signal,
    }));
    if (!response.ok) {
      const data = await response.json() as { error?: string };
      const error = data?.error;
      if (error && failures[response.status]?.has(error)) return authJson({ error }, response.status, cors);
      throw new Error('files_unavailable');
    }
    const bytes = await readFileBytes(response.body, MAX_FILESYSTEM_OUTPUT_BYTES, request.signal);
    const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    // Only runtime metadata is returned; guest stderr and arbitrary transport headers never escape.
    return authJson(data, 200, cors);
  } catch (error) {
    const failure = containerError(error, 'files_unavailable');
    return authJson({ error: failure.error }, failure.status, cors);
  }
}
