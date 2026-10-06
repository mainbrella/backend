import { z } from 'zod';
import { containerSecurity, errors, jsonResponse, register, requestBody, type LegacyHandler, type OpenAPIApi } from './openapi-shared';
import { MAX_COMMAND_BYTES } from '../../containers/command-contract.js';
import { MAX_MANAGED_TIMEOUT_MS, EXECUTION_RETENTION_MS, MAX_RETAINED_EXECUTIONS, EXECUTION_STREAM_MS,
  MAX_STDIN_CHUNK_BYTES, MAX_STDIN_BYTES, MAX_PENDING_STDIN_BYTES } from '../../containers/execution-contract.js';

const terminalSize = z.object({ cols: z.number().int().min(1).max(1000), rows: z.number().int().min(1).max(1000) }).strict();
export const executionSchema = z.object({ id: z.uuid(), createdAt: z.iso.datetime(), startedAt: z.iso.datetime(), finishedAt: z.iso.datetime().optional(),
  status: z.enum(['starting', 'running', 'succeeded', 'failed', 'canceled', 'timed_out', 'output_limit', 'interrupted']),
  retainUntil: z.number().int(), cursor: z.number().int().nonnegative(), outputBytes: z.number().int().nonnegative(),
  exitCode: z.number().int().nullable(), timedOut: z.boolean(), outputTruncated: z.boolean(),
  stdinEnabled: z.boolean().optional(), stdinClosed: z.boolean().optional(), stdinBytes: z.number().int().nonnegative().optional(), pty: terminalSize.optional() }).openapi('Execution');
const query = z.object({ id: z.string(), createdAt: z.iso.datetime() });
const headers = z.object({ Origin: z.string().optional() });
const params = z.object({ executionId: z.uuid() });
export function registerExecutionRoutes(api: OpenAPIApi, handler: LegacyHandler): void {
  const options = { pty: terminalSize.optional().describe('Requires stdin=true; combined output on stdout with terminal line discipline.'), timeoutMs: z.number().int().min(1).max(MAX_MANAGED_TIMEOUT_MS).optional(), stdin: z.boolean().optional(),
    cwd: z.string().min(1).max(4096).optional().describe('Absolute UTF-8 working directory; no dot or parent segments.'),
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), z.string().max(4096)).optional()
      .describe('At most 64 names and 16 KiB of encoded JSON. Variables other than PATH are not inherited by the provider exec API.') };
  register(api, 'get', '/containers/executions', {
    operationId: 'listContainerExecutions', tags: ['Containers'], summary: 'List retained managed jobs for one generation', security: containerSecurity,
    description: 'Lists up to 32 retained records for the exact owned generation, including running/terminal state. Commands, argv, environment values and idempotency keys are excluded. This is managed-job listing, not a guest-wide OS process table. Available after stop and during billing outages; never starts a machine or renews activity.',
    request: { query, headers }, responses: { 200: jsonResponse(z.object({ executions: z.array(executionSchema) })), ...errors(400, 401, 403, 503) },
  }, handler);
  register(api, 'post', '/containers/executions', {
    operationId: 'startContainerExecution', tags: ['Containers'], summary: 'Start an idempotent managed shell command', security: containerSecurity,
    description: `Requires owned running generation and paid access. Supply exactly one of command (shell) or argv (direct executable/arguments, no shell expansion). Optional cwd/env, stdin=true and pty={cols,rows}. PTY requires stdin=true and combines stdout/stderr on stdout; terminal line endings and input behavior apply. Closing input may hang up the PTY. Dimensions cap at 1000. Resize with the managed job endpoint. stdin defaults to closed/EOF. Idempotency-Key is required and scoped to that generation. Changed command/argv, timeout, input mode, cwd, env or initial terminal dimensions conflicts. Matching retries return retained execution. Command, argv and env values are not retained. Disconnect does not cancel. Timeout defaults to 30000 ms, caps at ${MAX_MANAGED_TIMEOUT_MS} ms and the hard deadline. Active work renews idle activity. Shares the four-operation pool with foreground commands/files. Combined output caps at 1 MiB and 512 chunks. Up to ${MAX_RETAINED_EXECUTIONS} records are retained for ${EXECUTION_RETENTION_MS} ms from admission; admission rejects when full. Cancellation targets the operation process group; deliberately detached processes remain bounded by the machine lease. A runtime restart interrupts unfinished work and stops its generation. No command is replayed. Requires GNU timeout in the image. Cookie mutations require trusted Origin.`,
    request: { query, headers: headers.extend({ 'Idempotency-Key': z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) }),
      ...requestBody(z.union([z.object({ command: z.string().min(1).max(MAX_COMMAND_BYTES), ...options }).strict(),
        z.object({ argv: z.array(z.string().max(MAX_COMMAND_BYTES)).min(1).max(64).describe('Total argv bytes at most the shared command limit.'), ...options }).strict()])) },
    responses: { 202: jsonResponse(executionSchema), ...errors(400, 401, 402, 403, 409, 413, 429, 503) },
  }, handler);
  register(api, 'post', '/containers/executions/:executionId/stdin', {
    operationId: 'writeContainerExecutionInput', tags: ['Containers'], summary: 'Send raw bytes to an owned managed job', security: containerSecurity,
    description: `Requires a running job created with stdin=true and a running paid generation. Writes are ordered and backpressure-aware. At most ${MAX_STDIN_CHUNK_BYTES} bytes per request, ${MAX_STDIN_BYTES} accepted bytes per job and ${MAX_PENDING_STDIN_BYTES} pending bytes. Accepted bytes remain counted after ambiguous writes. Input is not retained, replayed or retried. A 30-second response bound does not undo an accepted write; reconcile application state before sending again. Cookie mutations require trusted Origin.`,
    request: { params, query, headers, body: { required: false, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } } },
    responses: { 200: jsonResponse(z.object({ bytes: z.number().int().nonnegative(), stdinClosed: z.boolean() })), ...errors(400, 401, 402, 403, 404, 409, 413, 429, 503) },
  }, handler);
  register(api, 'delete', '/containers/executions/:executionId/stdin', {
    operationId: 'closeContainerExecutionInput', tags: ['Containers'], summary: 'Send EOF to an owned managed job', security: containerSecurity,
    description: 'Closes input after previously accepted writes. Does not cancel the job. Available as an owned cleanup operation during billing outages. A stopped/closed input returns a conflict. Cookie mutations require trusted Origin.',
    request: { params, query, headers }, responses: { 200: jsonResponse(z.object({ bytes: z.literal(0), stdinClosed: z.boolean() })), ...errors(400, 401, 403, 404, 409, 503) },
  }, handler);
  register(api, 'post', '/containers/executions/:executionId/signal', {
    operationId: 'signalContainerExecution', tags: ['Containers'], summary: 'Signal the process group of an owned managed job', security: containerSecurity,
    description: 'Accepts SIGINT, SIGTERM or SIGKILL. Signal delivery is a request, not proof of exit; inspect retained state/output. SIGKILL requests cancellation. Other signals may be handled or ignored. No arbitrary PID input. Cleanup checks the current generation again before signaling and remains available during billing outages. Cookie mutations require trusted Origin.',
    request: { params, query, headers, ...requestBody(z.object({ signal: z.enum(['SIGINT', 'SIGTERM', 'SIGKILL']) }).strict()) },
    responses: { 202: jsonResponse(executionSchema), ...errors(400, 401, 403, 404, 409, 503) },
  }, handler);
  register(api, 'post', '/containers/executions/:executionId/resize', {
    operationId: 'resizeContainerExecutionTerminal', tags: ['Containers'], summary: 'Resize an owned managed pseudo-terminal', security: containerSecurity,
    description: 'Requires the exact running paid generation and a live job started with pty. Each dimension is 1–1000. Does not create, attach to arbitrary guest processes or change the original idempotency fingerprint. Disconnecting the output stream only detaches. Cookie mutations require trusted Origin.',
    request: { params, query, headers, ...requestBody(terminalSize) }, responses: { 200: jsonResponse(executionSchema), ...errors(400, 401, 402, 403, 404, 409, 503) },
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
