import { z } from 'zod';
import { machineSizeSchema } from './openapi-containers';
import { containerSecurity, errors, jsonResponse, register, type LegacyHandler, type OpenAPIApi } from './openapi-shared';

const flags = <T extends string>(...names: T[]) => z.object(Object.fromEntries(names.map(name => [name, z.boolean()])) as Record<T, z.ZodBoolean>);
const limit = z.number().int().nonnegative();
export const capabilitiesSchema = z.object({
  apiVersion: z.string(),
  authentication: flags('apiKeys', 'browserSessions', 'browserTerminalCookieOnly'),
  containers: z.object({ idempotentCreate: z.boolean(), creationRetentionMs: limit, generationRequired: z.boolean(),
    accountLimitsPath: z.string(), configurableDeadline: z.boolean() }),
  execution: flags('foreground', 'streaming', 'background', 'cancellation', 'reconnect', 'pty', 'programmaticPty', 'ptyResize', 'stdin', 'signals', 'argv', 'managedProcessListing', 'processListing').extend({
    maxCommandBytes: limit, maxTimeoutMs: limit, maxOutputBytes: limit, maxConcurrentOperations: limit,
    maxManagedTimeoutMs: limit, retentionMs: limit, maxRetainedExecutions: limit, maxRetainedOutputBytes: limit, maxRetainedEvents: limit, retentionScope: z.literal('container-slot'), maxStdinChunkBytes: limit, maxStdinBytes: limit, maxPendingStdinBytes: limit }),
  codeInterpreter: z.object({ supported: z.boolean(), languages: z.array(z.literal('python')), stateful: z.boolean(), memoryPersistence: z.boolean(), maxCodeBytes: limit, maxTimeoutMs: limit, maxContextMs: limit, maxResultBytes: limit }),
  pools: flags('managed', 'sdkPrewarming').extend({ maxPools: limit, maxPoolSize: limit, maxTtlSeconds: limit }),
  files: flags('streamingTransfers', 'read', 'write', 'binary', 'atomicReplacement', 'list', 'stat', 'mkdir', 'delete', 'move', 'chmod', 'watch', 'sharedExecutionPool')
    .extend({ maxTransferBytes: limit, transferTimeoutMs: limit, maxFileBytes: limit, maxPathBytes: limit, timeoutMs: limit, maxDirectoryEntries: limit, maxDirectoryOffset: limit, maxMetadataBytes: limit }),
  persistence: flags('startupConfiguration', 'restoreLaunch', 'filesystemAfterStop', 'filesystemFork', 'snapshots', 'workspaces', 'exports', 'memory', 'volumes'),
  observability: flags('lifecycleEvents', 'metrics', 'webhooks', 'otlp', 'activityWebSocket').extend({ eventRetentionMs: limit, maxLifecycleEvents: limit, maxMetricRangeMs: limit, metricBucketMs: limit }),
  previews: flags('supported', 'signedUrls'),
  projects: flags('supported', 'customDomains', 'localDevelopment').extend({ apexIps: z.array(z.string()) }),
  images: z.object({ tags: z.boolean(), catalog: z.boolean(), availableCatalogPath: z.string(), repositoryLaunch: z.boolean(), customBuilds: z.boolean(), crossBuildCache: z.boolean(), privateRegistryImports: z.boolean(), limits: z.object({
    maxBuildsPerMonth: limit, maxSavedImages: limit, maxContextBytes: limit, maxDockerfileBytes: limit, maxBuildSeconds: limit, maxTags: limit }) }),
  resources: z.array(machineSizeSchema),
  networking: flags('outboundInternet', 'internetControl', 'privateServices', 'egressPolicies', 'regionSelection'),
  secrets: flags('vault'),
  access: z.object({ maxTerminalConnections: limit, maxSSHAccessTokens: limit, sshTokenLifetimeMs: limit }),
}).openapi('Capabilities');

export function registerCapabilityRoutes(api: OpenAPIApi, handler: LegacyHandler): void {
  register(api, 'get', '/capabilities', {
    operationId: 'getCapabilities', tags: ['Operations'], summary: 'Discover API features and runtime limits', security: [...containerSecurity, {}],
    description: 'Read-only deployment contract with optional API-key or browser-session authentication. During a private security rollout, networking.egressPolicies and secrets.vault reflect the authenticated account; anonymous and non-allowlisted callers see false. Responses are not cached and vary on Authorization and Cookie. Requires no credentials, paid access, or provisioning. No query parameters. Does not establish live component health. Obtain account allowances and deployed image catalog through authenticated GET /containers. Unsupported features are explicit; customBuilds reflects build-service configuration. previews.supported requires explicit enablement, an isolated preview domain, routing database and runtime binding. Preview URLs use opaque bearer tokens rather than signatures, so signedUrls remains false. projects.supported requires explicit project hosting enablement and routing/runtime bindings; projects.customDomains additionally requires a configured certificate provider, except in local development. projects.localDevelopment is true only when LOCAL_DEV=true and PROJECT_DOMAIN_PROVIDER=local; it enables *.localhost aliases with simulated DNS and TLS. apexIps contains only operator-configured ingress addresses and is empty for local development.',
    responses: { 200: jsonResponse(capabilitiesSchema), ...errors(400, 403, 405) },
  }, handler);
}
