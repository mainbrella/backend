import { z } from 'zod';
import { containerSecurity, errors, jsonResponse, register, requestBody, type LegacyHandler, type OpenAPIApi } from './openapi-shared';
import { MAX_COMMAND_BYTES, MAX_TIMEOUT_MS } from '../../containers/command-contract.js';
import { MAX_CODE_CONTEXT_MS, MAX_CODE_RESULT_BYTES } from '../../containers/code-contract.js';

export const codeContextSchema = z.object({ id: z.uuid(), language: z.literal('python'), createdAt: z.iso.datetime(), expiresAt: z.number().int() }).openapi('CodeContext');
export const codeResultSchema = z.object({ stdout: z.string(), stderr: z.string(), outputTruncated: z.boolean(),
  results: z.array(z.object({ mimeType: z.enum(['text/plain', 'application/json', 'text/html', 'image/png']), data: z.string() })).max(4),
  error: z.object({ name: z.string(), message: z.string(), traceback: z.string() }).nullable() }).openapi('CodeResult');

export function registerCodeContextRoutes(api: OpenAPIApi, handler: LegacyHandler): void {
  const query = z.object({ id: z.string(), createdAt: z.iso.datetime() });
  const headers = z.object({ Origin: z.string().optional() });
  const params = z.object({ contextId: z.uuid() });
  const base = { tags: ['Containers'], security: containerSecurity };
  register(api, 'get', '/containers/code-contexts', { ...base, operationId: 'listCodeContexts', summary: 'List live interpreter contexts for one generation',
    description: 'Owned read operation available during billing outages. Only executable contexts are listed; closing contexts are omitted even while cleanup remains pending. Contexts disappear on expiration, stop, or runtime recovery.', request: { query, headers },
    responses: { 200: jsonResponse(z.object({ contexts: z.array(codeContextSchema) })), ...errors(400, 401, 403, 503) } }, handler);
  register(api, 'post', '/containers/code-contexts', { ...base, operationId: 'createCodeContext', summary: 'Create a stateful Python interpreter',
    description: `Requires an owned paid running generation with python3 and GNU timeout installed. Python globals and imported modules persist within this context. Contexts expire after at most ${MAX_CODE_CONTEXT_MS} ms and consume one of the shared four concurrent operation slots until closed. Idle contexts do not renew container activity. Stop, timeout, disconnect during execution, or runtime recovery destroys the context. Context memory is never snapshotted or restored. Creation is not automatically retried. Cookie mutations require trusted Origin.`,
    request: { query, headers, ...requestBody(z.object({ language: z.literal('python') }).strict()) },
    responses: { 201: jsonResponse(codeContextSchema), ...errors(400, 401, 402, 403, 409, 413, 429, 503) } }, handler);
  register(api, 'post', '/containers/code-contexts/:contextId/execute', { ...base, operationId: 'executeCodeInContext', summary: 'Execute Python with persistent variables and rich results',
    description: `Code is UTF-8 and limited to ${MAX_COMMAND_BYTES} bytes. One execution per context; overlap returns 409. Timeout defaults to 30000 ms and caps at ${MAX_TIMEOUT_MS} ms and context expiration. Python stdout, stderr, the final expression (text, JSON and optional HTML/base64 PNG), and structured exceptions are returned. Python exceptions preserve the context. All returned string contents (stdout, stderr including native output, MIME types/data, and error fields) share a ${MAX_CODE_RESULT_BYTES}-byte UTF-8 budget with outputTruncated; JSON escaping/field names are excluded, and the encoded response is bounded at 2 MiB. At most four MIME results; oversized JSON/HTML/PNG representations are omitted whole. Native/subprocess stdout and stderr are combined in stderr and also have a separate 1 MiB ingestion hard limit. Rich output is untrusted: sanitize HTML before rendering. Blocking stdin receives EOF. Timeouts, cancellation, protocol failure, or native ingestion overflow close the context. Code is never automatically retried; an ambiguous request may have executed and must not be blindly resubmitted. This process has the same sandbox privileges as commands; it is not a security boundary within the guest.`,
    request: { query, params, headers, ...requestBody(z.object({ code: z.string().min(1).max(MAX_COMMAND_BYTES), timeoutMs: z.number().int().min(1).max(MAX_TIMEOUT_MS).optional() }).strict()) },
    responses: { 200: jsonResponse(codeResultSchema), ...errors(400, 401, 402, 403, 404, 409, 413, 503, 504) } }, handler);
  register(api, 'delete', '/containers/code-contexts/:contextId', { ...base, operationId: 'closeCodeContext', summary: 'Close an interpreter and release its operation slot',
    description: 'Owned cleanup remains available during billing outages. Kills the interpreter process group; does not delete sandbox files. Concurrent deletes await the same cleanup. Failed cleanup retains the context ID and occupied operation slot for another DELETE; execution on a closing context returns 409 code_context_closed. A successful response confirms cleanup. Cookie mutations require trusted Origin.',
    request: { query, params, headers }, responses: { 200: jsonResponse(z.object({ closed: z.literal(true) })), ...errors(400, 401, 403, 404, 409, 503) } }, handler);
}
