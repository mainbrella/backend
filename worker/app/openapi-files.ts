import { z } from 'zod';
import { containerSecurity, errors, jsonResponse, register, type LegacyHandler, type OpenAPIApi } from './openapi-shared';
import { FILE_TIMEOUT_MS, MAX_FILE_BYTES, MAX_FILE_PATH_BYTES } from '../../containers/file-contract.js';

export function registerFileRoutes(api: OpenAPIApi, handler: LegacyHandler): void {
  const request = {
    query: z.object({ id: z.string(), createdAt: z.iso.datetime(), path: z.string().min(2).max(MAX_FILE_PATH_BYTES)
      .describe('Absolute guest file path, at most 4096 UTF-8 bytes. Empty, dot and parent segments are rejected.') }),
    headers: z.object({ Origin: z.string().optional().describe('Trusted browser origin; required for cookie writes.') }),
  };
  const description = `Accesses files in an owned running generation without SSH. Does not create a machine or consume a start. Files are limited to ${MAX_FILE_BYTES} bytes; oversized reads return an error without partial data. Runtime operations are bounded by ${FILE_TIMEOUT_MS} ms and the hard deadline, share the four-command execution pool, and renew idle activity. Files remain ephemeral. Custom images need /bin/sh and GNU coreutils. Cookie writes require a trusted Origin.`;
  register(api, 'get', '/containers/files', {
    operationId: 'readContainerFile', tags: ['Containers'], summary: 'Read a binary file', security: containerSecurity,
    description: `${description} Reads regular files, including symlink targets inside the guest. Returns raw application/octet-stream bytes with caching disabled.`,
    request,
    responses: { 200: { description: 'Raw file bytes.', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
      ...errors(400, 401, 402, 403, 404, 409, 413, 429, 503) },
  }, handler);
  register(api, 'put', '/containers/files', {
    operationId: 'writeContainerFile', tags: ['Containers'], summary: 'Write a binary file', security: containerSecurity,
    description: `${description} The body is raw bytes; an empty body writes an empty file. The parent directory must exist. Writes use a temporary file and atomic rename; regular files are replaced, while directories and existing symlinks are rejected. New files use mode 0600; replacement preserves permission bits. A lost response may hide a successful write: read to reconcile before retrying.`,
    request: { ...request, body: { required: false, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } } },
    responses: { 200: jsonResponse(z.object({ path: z.string(), size: z.number().int().min(0).max(MAX_FILE_BYTES) })),
      ...errors(400, 401, 402, 403, 404, 409, 413, 429, 503) },
  }, handler);
}
