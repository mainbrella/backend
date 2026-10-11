import { z } from 'zod';
import { containerSecurity, errors, jsonResponse, register, type LegacyHandler, type OpenAPIApi } from './openapi-shared';
import { FILE_TIMEOUT_MS, MAX_FILE_BYTES, MAX_FILE_PATH_BYTES } from '../../containers/file-contract.js';
import { MAX_TRANSFER_BYTES, TRANSFER_TIMEOUT_MS } from '../../containers/file-transfer-contract.js';

export function registerFileRoutes(api: OpenAPIApi, handler: LegacyHandler): void {
  const transferIdentity = { id: z.string(), createdAt: z.iso.datetime(), path: z.string().min(2).max(MAX_FILE_PATH_BYTES) };
  const transferDescription = `Streams a regular file in an owned running generation under backpressure, up to ${MAX_TRANSFER_BYTES} bytes without a file-sized Worker buffer. Shares the execution pool, renews idle activity, and ends within ${TRANSFER_TIMEOUT_MS} ms or the generation deadline. Requires Linux, /bin/sh and GNU coreutils. Files use the sandbox's existing lifecycle and persistence behavior. Transfers cannot resume; mutations are never automatically retried.`;
  register(api, 'get', '/containers/files/transfer', {
    operationId: 'downloadContainerFile', tags: ['Containers'], summary: 'Stream a file download', security: containerSecurity,
    description: `${transferDescription} Returns Content-Length and raw bytes. A changing file is not a consistent snapshot; truncation and disconnects fail the response stream. Consumers must discard incomplete output.`,
    request: { query: z.object(transferIdentity) },
    responses: { 200: { description: 'Streamed file bytes.', headers: { 'Content-Length': { schema: { type: 'integer', maximum: MAX_TRANSFER_BYTES } } },
      content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } }, ...errors(400, 401, 402, 403, 404, 409, 413, 429, 503) },
  }, handler);
  register(api, 'put', '/containers/files/transfer', {
    operationId: 'uploadContainerFile', tags: ['Containers'], summary: 'Stream an atomic file upload', security: containerSecurity,
    description: `${transferDescription} The required size is the exact body length. A short, oversized or aborted input never replaces the destination. A clean EOF authorizes atomic rename after all bytes have arrived. Parent must exist; directories and leaf symlinks are rejected. Mode is 0600 for new files; replacement preserves permission bits. A lost response can hide a completed rename: inspect state before retrying. Interrupted processes may leave a hidden temporary file beside the destination. Cookie writes require a trusted Origin.`,
    request: { query: z.object({ ...transferIdentity, size: z.coerce.number().int().min(0).max(MAX_TRANSFER_BYTES) }),
      headers: z.object({ Origin: z.string().optional() }), body: { required: false, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } } },
    responses: { 200: jsonResponse(z.object({ path: z.string(), size: z.number().int().min(0).max(MAX_TRANSFER_BYTES) })), ...errors(400, 401, 402, 403, 404, 409, 413, 429, 503) },
  }, handler);
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
