import { authCorsHeaders, authJson } from './auth-core';
import { MAX_COMMAND_BYTES, MAX_EXECUTIONS, MAX_OUTPUT_BYTES, MAX_TIMEOUT_MS } from '../../containers/command-contract.js';
import { FILE_TIMEOUT_MS, MAX_FILE_BYTES, MAX_FILE_PATH_BYTES } from '../../containers/file-contract.js';
import { MACHINE_SIZES, ACCESS_LIMITS } from '../../containers/plan-policy.js';
import { IMAGE_LIMITS } from './images';
import { MAX_MANAGED_TIMEOUT_MS, EXECUTION_RETENTION_MS, MAX_RETAINED_EXECUTIONS } from '../../containers/execution-contract.js';
import { previewsConfigured } from '../lib/preview-routing';

// This contract describes this API deployment, not account access or live health.
// The authenticated /containers response owns allowances and deployed catalog IDs.
export function capabilities(env: Env) {
  return {
    apiVersion: '2026-10-05',
    authentication: { apiKeys: true, browserSessions: true, browserTerminalCookieOnly: true },
    containers: { idempotentCreate: true, creationRetentionMs: 86_400_000, generationRequired: true,
      accountLimitsPath: '/containers', configurableDeadline: false },
    execution: { foreground: true, streaming: true, background: true, cancellation: true, reconnect: true,
      pty: true, maxCommandBytes: MAX_COMMAND_BYTES, maxTimeoutMs: MAX_TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES, maxConcurrentOperations: MAX_EXECUTIONS,
      maxManagedTimeoutMs: MAX_MANAGED_TIMEOUT_MS, retentionMs: EXECUTION_RETENTION_MS, maxRetainedExecutions: MAX_RETAINED_EXECUTIONS },
    files: { read: true, write: true, binary: true, atomicReplacement: true, list: false, stat: false,
      mkdir: false, delete: false, watch: false, maxFileBytes: MAX_FILE_BYTES,
      maxPathBytes: MAX_FILE_PATH_BYTES, timeoutMs: FILE_TIMEOUT_MS, sharedExecutionPool: true },
    persistence: { filesystemAfterStop: false, snapshots: false, memory: false, volumes: false },
    previews: { supported: previewsConfigured(env), signedUrls: false },
    images: { catalog: true, availableCatalogPath: '/containers',
      customBuilds: Boolean(env.IMAGE_BUILD_SECRET && env.IMAGE_BUILD_GITHUB_TOKEN), limits: IMAGE_LIMITS },
    resources: MACHINE_SIZES,
    networking: { outboundInternet: true, egressPolicies: false, regionSelection: false },
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
