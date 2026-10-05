import { z } from 'zod';
import { containerSecurity, errors, jsonResponse, register, requestBody, type LegacyHandler, type OpenAPIApi } from './openapi-shared';
import { MAX_COMMAND_BYTES, MAX_TIMEOUT_MS } from '../../containers/command-contract.js';

export function registerCommandRoutes(api: OpenAPIApi, handler: LegacyHandler): void {
  register(api, 'post', '/containers/exec', {
    operationId: 'executeContainerCommand', tags: ['Containers'], summary: 'Run a bounded foreground shell command', security: containerSecurity,
    description: `Runs /bin/sh -lc without a PTY on an owned running generation. Does not create a machine or reserve a start. Command is limited to ${MAX_COMMAND_BYTES} UTF-8 bytes; request body to 32 KiB. Combined stdout/stderr is limited to 1 MiB. Timeout includes process startup and is capped by the hard deadline. Timeout or excess output terminates the process and returns partial output with a null exitCode. A disconnect requests cancellation when observable; the timeout always bounds the request. Results are not retained and commands are not idempotent: do not blindly retry after transport failure. Cookie requests require a trusted Origin.`,
    request: {
      query: z.object({ id: z.string(), createdAt: z.iso.datetime() }),
      headers: z.object({ Origin: z.string().optional().describe('Trusted browser origin; required for cookie mutations.') }),
      ...requestBody(z.object({ command: z.string().min(1).max(MAX_COMMAND_BYTES).describe('Shell command, at most 16 KiB in UTF-8.'), timeoutMs: z.number().int().min(1).max(MAX_TIMEOUT_MS).default(30_000) }).strict()),
    },
    responses: {
      200: jsonResponse(z.object({ stdout: z.string(), stderr: z.string(), exitCode: z.number().int().nullable(), timedOut: z.boolean(), outputTruncated: z.boolean() })),
      ...errors(400, 401, 402, 403, 409, 413, 429, 503),
    },
  }, handler);
}
