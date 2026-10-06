import { z } from 'zod';
import { machineSizeSchema } from './openapi-containers';
import { errors, jsonResponse, register, type LegacyHandler, type OpenAPIApi } from './openapi-shared';

const flags = <T extends string>(...names: T[]) => z.object(Object.fromEntries(names.map(name => [name, z.boolean()])) as Record<T, z.ZodBoolean>);
const limit = z.number().int().nonnegative();
export const capabilitiesSchema = z.object({
  apiVersion: z.string(),
  authentication: flags('apiKeys', 'browserSessions', 'browserTerminalCookieOnly'),
  containers: z.object({ idempotentCreate: z.boolean(), creationRetentionMs: limit, generationRequired: z.boolean(),
    accountLimitsPath: z.string(), configurableDeadline: z.boolean() }),
  execution: flags('foreground', 'streaming', 'background', 'cancellation', 'reconnect', 'pty', 'programmaticPty', 'ptyResize', 'stdin', 'signals', 'argv', 'managedProcessListing', 'processListing').extend({
    maxCommandBytes: limit, maxTimeoutMs: limit, maxOutputBytes: limit, maxConcurrentOperations: limit,
    maxManagedTimeoutMs: limit, retentionMs: limit, maxRetainedExecutions: limit, maxStdinChunkBytes: limit, maxStdinBytes: limit, maxPendingStdinBytes: limit }),
  files: flags('read', 'write', 'binary', 'atomicReplacement', 'list', 'stat', 'mkdir', 'delete', 'move', 'chmod', 'watch', 'sharedExecutionPool')
    .extend({ maxFileBytes: limit, maxPathBytes: limit, timeoutMs: limit, maxDirectoryEntries: limit, maxDirectoryOffset: limit, maxMetadataBytes: limit }),
  persistence: flags('filesystemAfterStop', 'snapshots', 'workspaces', 'exports', 'memory', 'volumes'),
  observability: flags('lifecycleEvents', 'metrics', 'webhooks', 'otlp', 'activityWebSocket').extend({ eventRetentionMs: limit, maxLifecycleEvents: limit, maxMetricRangeMs: limit, metricBucketMs: limit }),
  previews: flags('supported', 'signedUrls'),
  images: z.object({ catalog: z.boolean(), availableCatalogPath: z.string(), customBuilds: z.boolean(), limits: z.object({
    maxBuildsPerMonth: limit, maxSavedImages: limit, maxContextBytes: limit, maxDockerfileBytes: limit, maxBuildSeconds: limit }) }),
  resources: z.array(machineSizeSchema),
  networking: flags('outboundInternet', 'internetControl', 'egressPolicies', 'regionSelection'),
  access: z.object({ maxTerminalConnections: limit, maxSSHAccessTokens: limit, sshTokenLifetimeMs: limit }),
}).openapi('Capabilities');

export function registerCapabilityRoutes(api: OpenAPIApi, handler: LegacyHandler): void {
  register(api, 'get', '/capabilities', {
    operationId: 'getCapabilities', tags: ['Operations'], summary: 'Discover API features and runtime limits', security: [],
    description: 'Public, read-only deployment contract. Requires no credentials, paid access, or provisioning. No query parameters. Does not establish live component health. Obtain account allowances and deployed image catalog through authenticated GET /containers. Unsupported features are explicit; customBuilds reflects build-service configuration. previews.supported requires explicit enablement, an isolated preview domain, routing database and runtime binding. Preview URLs use opaque bearer tokens rather than signatures, so signedUrls remains false.',
    responses: { 200: jsonResponse(capabilitiesSchema), ...errors(400, 403, 405) },
  }, handler);
}
