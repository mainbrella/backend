import { z } from 'zod';
import { containerSecurity, errors, jsonResponse, register, requestBody, type LegacyHandler, type OpenAPIApi } from './openapi-shared';
import { MAX_COMMAND_BYTES } from '../../containers/command-contract.js';
import { MAX_MANAGED_TIMEOUT_MS, EXECUTION_RETENTION_MS, MAX_RETAINED_EXECUTIONS, EXECUTION_STREAM_MS } from '../../containers/execution-contract.js';

export const executionSchema = z.object({ id: z.uuid(), createdAt: z.iso.datetime(), startedAt: z.iso.datetime(), finishedAt: z.iso.datetime().optional(),
  status: z.enum(['starting', 'running', 'succeeded', 'failed', 'canceled', 'timed_out', 'output_limit', 'interrupted']),
  retainUntil: z.number().int(), cursor: z.number().int().nonnegative(), outputBytes: z.number().int().nonnegative(),
  exitCode: z.number().int().nullable(), timedOut: z.boolean(), outputTruncated: z.boolean() }).openapi('Execution');
const query = z.object({ id: z.string(), createdAt: z.iso.datetime() });
const headers = z.object({ Origin: z.string().optional() });
const params = z.object({ executionId: z.uuid() });
export function registerExecutionRoutes(api: OpenAPIApi, handler: LegacyHandler): void {
  register(api, 'post', '/containers/executions', {
    operationId: 'startContainerExecution', tags: ['Containers'], summary: 'Start an idempotent managed shell command', security: containerSecurity,
    description: `Requires owned running generation and paid access. Idempotency-Key is required and scoped to that generation. Matching retries return the retained execution; changed command/timeout returns 409. Disconnect does not cancel. Timeout defaults to 30000 ms, caps at ${MAX_MANAGED_TIMEOUT_MS} ms and the hard deadline. Active work renews idle activity. Shares the four-operation pool with foreground commands/files. Combined output caps at 1 MiB and 512 chunks. Up to ${MAX_RETAINED_EXECUTIONS} records are retained for ${EXECUTION_RETENTION_MS} ms from admission; admission rejects when full. A runtime restart marks unfinished work interrupted and stops its generation to revoke orphan processes. No command is replayed. Cookie mutations require trusted Origin.`,
    request: { query, headers: headers.extend({ 'Idempotency-Key': z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) }),
      ...requestBody(z.object({ command: z.string().min(1).max(MAX_COMMAND_BYTES), timeoutMs: z.number().int().min(1).max(MAX_MANAGED_TIMEOUT_MS).optional() }).strict()) },
    responses: { 202: jsonResponse(executionSchema), ...errors(400, 401, 402, 403, 409, 413, 429, 503) },
  }, handler);
  register(api, 'get', '/containers/executions/:executionId', {
    operationId: 'getContainerExecution', tags: ['Containers'], summary: 'Read retained execution state and output', security: containerSecurity,
    description: 'Owned generation only. Available after stop and during billing outages; never starts a machine or renews idle time. Expired/mismatched records return 404. Does not reveal the command or idempotency key.',
    request: { params, query, headers }, responses: { 200: jsonResponse(executionSchema.extend({ stdout: z.string(), stderr: z.string() })), ...errors(400, 401, 403, 404, 503) },
  }, handler);
  register(api, 'delete', '/containers/executions/:executionId', {
    operationId: 'cancelContainerExecution', tags: ['Containers'], summary: 'Request cancellation of an owned execution', security: containerSecurity,
    description: 'Idempotent cancellation request. 202 returns the observed record; poll until terminal. Available during billing outages and after stop. Cannot affect another generation. Cookie mutations require trusted Origin.',
    request: { params, query, headers }, responses: { 202: jsonResponse(executionSchema), ...errors(400, 401, 403, 404, 503) },
  }, handler);
  register(api, 'get', '/containers/executions/:executionId/events', {
    operationId: 'streamContainerExecution', tags: ['Containers'], summary: 'Stream and replay execution output with a cursor', security: containerSecurity,
    description: `SSE stdout/stderr events contain sequence, type and data; id is the sequence. Resume with cursor equal to the last received id. Cursor must not exceed retained output. status event contains execution metadata; terminal status ends the stream. Streams rotate after ${EXECUTION_STREAM_MS} ms and emit heartbeat comments. Disconnect only detaches. Maximum eight streams per container. Available for retained owned generations during billing outages.`,
    request: { params, query: query.extend({ cursor: z.number().int().nonnegative().optional() }), headers },
    responses: { 200: { description: 'Server-sent execution output events.', content: { 'text/event-stream': { schema: { type: 'string' } } } }, ...errors(400, 401, 403, 404, 429, 503) },
  }, handler);
}
