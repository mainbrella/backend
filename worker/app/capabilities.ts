import { authCorsHeaders, authJson } from './auth-core';
import { MAX_COMMAND_BYTES, MAX_EXECUTIONS, MAX_OUTPUT_BYTES, MAX_TIMEOUT_MS } from '../../containers/command-contract.js';
import { FILE_TIMEOUT_MS, MAX_FILE_BYTES, MAX_FILE_PATH_BYTES } from '../../containers/file-contract.js';
import { MACHINE_SIZES, ACCESS_LIMITS } from '../../containers/plan-policy.js';
import { IMAGE_LIMITS } from './images';
import { MAX_MANAGED_TIMEOUT_MS, EXECUTION_RETENTION_MS, MAX_RETAINED_EXECUTIONS,
  MAX_STDIN_CHUNK_BYTES, MAX_STDIN_BYTES, MAX_PENDING_STDIN_BYTES } from '../../containers/execution-contract.js';
import { previewsConfigured } from '../lib/preview-routing';
import { MAX_DIRECTORY_ENTRIES, MAX_DIRECTORY_OFFSET, MAX_FILESYSTEM_OUTPUT_BYTES } from '../../containers/filesystem-contract.js';
import { metricsConfigured, MAX_METRIC_RANGE_MS, METRIC_BUCKET_MS } from '../lib/workload-metrics';
import { OBSERVATION_RETENTION_MS, MAX_LIFECYCLE_EVENTS } from '../../containers/observations.js';
import { webhooksConfigured } from '../../containers/webhook-contract.js';
import { activityConfigured } from './activity';

// This contract describes this API deployment, not account access or live health.
// The authenticated /containers response owns allowances and deployed catalog IDs.
export function capabilities(env: Env) {
  return {
    apiVersion: '2026-10-05',
    authentication: { apiKeys: true, browserSessions: true, browserTerminalCookieOnly: true },
    containers: { idempotentCreate: true, creationRetentionMs: 86_400_000, generationRequired: true,
      accountLimitsPath: '/containers', configurableDeadline: false },
    execution: { foreground: true, streaming: true, background: true, cancellation: true, reconnect: true,
      programmaticPty: true, ptyResize: true, stdin: true, signals: true, argv: true, managedProcessListing: true, processListing: false,
      maxStdinChunkBytes: MAX_STDIN_CHUNK_BYTES, maxStdinBytes: MAX_STDIN_BYTES, maxPendingStdinBytes: MAX_PENDING_STDIN_BYTES,
      pty: true, maxCommandBytes: MAX_COMMAND_BYTES, maxTimeoutMs: MAX_TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES, maxConcurrentOperations: MAX_EXECUTIONS,
      maxManagedTimeoutMs: MAX_MANAGED_TIMEOUT_MS, retentionMs: EXECUTION_RETENTION_MS, maxRetainedExecutions: MAX_RETAINED_EXECUTIONS },
    files: { read: true, write: true, binary: true, atomicReplacement: true, list: true, stat: true,
      mkdir: true, delete: true, move: true, chmod: true, watch: false, maxDirectoryEntries: MAX_DIRECTORY_ENTRIES,
      maxDirectoryOffset: MAX_DIRECTORY_OFFSET, maxMetadataBytes: MAX_FILESYSTEM_OUTPUT_BYTES, maxFileBytes: MAX_FILE_BYTES,
      maxPathBytes: MAX_FILE_PATH_BYTES, timeoutMs: FILE_TIMEOUT_MS, sharedExecutionPool: true },
    persistence: { filesystemAfterStop: false, snapshots: Boolean(env.USER_CONTAINER && env.CONTAINER_ACCOUNT && env.WORKSPACE_PERSISTENCE_ENABLED==='true'), workspaces:Boolean(env.USER_CONTAINER && env.CONTAINER_ACCOUNT), exports:Boolean(env.USER_CONTAINER && env.CONTAINER_ACCOUNT), memory: false, volumes: false },
    observability: { lifecycleEvents: true, activityWebSocket: activityConfigured(env), metrics: metricsConfigured(env), webhooks: Boolean(env.USER_CONTAINER && webhooksConfigured(env)), otlp: false,
      eventRetentionMs: OBSERVATION_RETENTION_MS, maxLifecycleEvents: MAX_LIFECYCLE_EVENTS, maxMetricRangeMs: MAX_METRIC_RANGE_MS, metricBucketMs: METRIC_BUCKET_MS },
    previews: { supported: previewsConfigured(env), signedUrls: false },
    images: { catalog: true, availableCatalogPath: '/containers',
      customBuilds: Boolean(env.IMAGE_BUILD_SECRET && env.IMAGE_BUILD_GITHUB_TOKEN), limits: IMAGE_LIMITS },
    resources: MACHINE_SIZES,
    networking: { outboundInternet: true, internetControl: Boolean(env.USER_CONTAINER && env.CONTAINER_ACCOUNT && env.NETWORK_INTERNET_CONTROL_ENABLED === 'true'), egressPolicies: false, regionSelection: false },
    access: ACCESS_LIMITS,
  };
}

export async function handleCapabilitiesRequest(request: Request, env: Env): Promise<Response> {
  const cors = authCorsHeaders(request);
  if (cors === null) return authJson({ error: 'origin_not_allowed' }, 403, {});
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'GET') return authJson({ error: 'method_not_allowed' }, 405, { ...cors, allow: 'GET, OPTIONS' });
  if (new URL(request.url).search) return authJson({ error: 'invalid_request' }, 400, cors);
  return authJson(capabilities(env), 200, cors);
}
