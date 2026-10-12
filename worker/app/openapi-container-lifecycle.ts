import { z } from 'zod';
import { containerStatusSchema, restoreLaunchSchema, restoreReadinessSchema } from './openapi-containers';
import { containerSecurity, errors, jsonResponse, register, requestBody, type LegacyHandler, type OpenAPIApi } from './openapi-shared';

const identity = z.object({ id: z.string().regex(/^(small|c[1-9]\d{0,2})$/), createdAt: z.string().datetime() });
const headers = z.object({ Origin: z.string().optional(), 'Idempotency-Key': z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) });
const creation = z.object({ id: z.string(), containerId: z.string(), createdAt: z.string(), status: z.enum(['starting', 'running', 'stopped']), readiness: restoreReadinessSchema.optional() });

export function registerContainerLifecycleRoutes(api: OpenAPIApi, handler: LegacyHandler): void {
  register(api, 'patch', '/containers/startup', {
    operationId: 'configureContainerStartup', tags: ['Containers'], summary: 'Configure the command for future filesystem restores', security: containerSecurity,
    description: 'Requires persistence.startupConfiguration, paid access and the exact running ad_hoc generation. Saves a canonical foreground launch recipe on the source without starting, restarting or changing its current process. Stop/Resume and Fork inherit this recipe; previously saved snapshots remain immutable. Explicit Save still requires its own launch field. launch:null clears future automatic startup. Requests are limited to 32 KiB; repeated identical requests are safe. Production uses its separate startupCommand supervisor and rejects this setting. An older runtime returns 503 workspace_launch_unavailable. Cookie mutations require a trusted Origin. No RAM or process preservation.',
    request: { headers: z.object({ Origin: z.string().optional() }), ...requestBody(identity.extend({ launch: restoreLaunchSchema.nullable() }).strict()) },
    responses: { 200: jsonResponse(identity.extend({ launch: restoreLaunchSchema.nullable() })), ...errors(400, 401, 402, 403, 405, 409, 413, 503) },
  }, handler);
  for (const [action, operationId, summary, description] of [
    ['stop', 'suspendContainer', 'Save the filesystem and stop a container', 'The snapshot is committed before compute stops. Failure leaves the running source intact. The stopped slot remains listed and reserved for resume without running compute charges. Saved storage quotas and expiry apply. DELETE /containers permanently deletes a machine; this endpoint preserves its filesystem.'],
    ['resume', 'resumeContainer', 'Resume a stopped container from its saved filesystem', 'Restores the reserved slot with a new createdAt generation and a normal paid start. The old generation cannot access the replacement. Expired, deleted, or incompatible snapshots fail without an empty-image fallback.'],
    ['fork', 'forkContainer', 'Fork a running container filesystem into an independent machine', 'Captures an owned running generation and creates a separate machine from that snapshot. Source continues running. Image, size, outbound policy and secret bindings are inherited. Optional name labels the fork. A snapshot and a normal paid start count against account quotas.'],
  ] as const) {
    register(api, 'post', `/containers/${action}`, {
      operationId, tags: ['Containers'], summary, security: containerSecurity,
      description: `${description} Requires persistence.${action === 'fork' ? 'filesystemFork' : 'filesystemAfterStop'}, exact generation and Idempotency-Key. Retry an uncertain result with the same key and body. A configured source launch recipe is inherited and starts a new foreground process once on restore; readiness is reported separately from machine status. Filesystem only: no RAM, processes, mounted volumes, or automatic protection from provider crashes. Quiesce applications before capture for application-consistent data. Cookie mutations require a trusted Origin.`,
      request: { headers, ...requestBody(action === 'fork' ? identity.extend({ name: z.string().trim().min(1).max(80).optional() }) : identity) },
      responses: { 200: jsonResponse(containerStatusSchema.extend({ creation: creation.optional() })), ...errors(400, 401, 402, 403, 404, 405, 409, 410, 413, 429, 503) },
    }, handler);
  }
}
