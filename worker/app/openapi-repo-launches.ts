import { z } from 'zod';
import { containerSecurity, errors, jsonResponse, register, requestBody, type LegacyHandler, type OpenAPIApi } from './openapi-shared';
import { launchOptionsSchema, repoCwd, repoName, repoRef } from '../lib/repo-launch';

const repository = z.object({ repo: repoName, ref: repoRef, commit: z.string().regex(/^[a-f0-9]{40}$/), suggestedCatalogId: z.string(), manifests: z.array(z.string()) }).openapi('ResolvedRepository');
const launch = z.object({ id: z.uuid(), phase: z.enum(['allocating', 'cloning', 'setup', 'starting', 'ready', 'failed', 'stopped']),
  options: launchOptionsSchema, repository, container: z.object({ id: z.string(), createdAt: z.iso.datetime(), expiresAt: z.iso.datetime() }).nullable(),
  executions: z.object({ cloning: z.uuid().optional(), setup: z.uuid().optional(), starting: z.uuid().optional() }),
  attempts: z.record(z.string(), z.number()), createdAt: z.number(), shellReadyAt: z.number().nullable(), previewReadyAt: z.number().nullable(), error: z.string().nullable(),
}).openapi('RepositoryLaunch');
const headers = z.object({ Origin: z.string().optional() });
const params = z.object({ launchId: z.uuid() });
export function registerRepoLaunchRoutes(api: OpenAPIApi, handler: LegacyHandler): void {
  register(api, 'get', '/repo-launches/resolve', {
    operationId: 'resolvePublicRepository', tags: ['Containers'], summary: 'Validate a public GitHub repository and suggest a runtime', security: containerSecurity,
    description: 'Read-only. Resolves a branch, tag or commit to an immutable commit and detects manifests in cwd. No GitHub authentication, allocation or execution. GitHub rate limits may return 429. GitHub redirects are not followed and return github_unavailable (503).',
    request: { query: z.object({ repo: repoName, ref: repoRef.optional(), cwd: repoCwd.optional() }), headers },
    responses: { 200: jsonResponse(repository), ...errors(400, 401, 403, 429, 503) },
  }, handler);
  register(api, 'post', '/repo-launches', {
    operationId: 'createRepositoryLaunch', tags: ['Containers'], summary: 'Create an owner-scoped repository launch', security: containerSecurity,
    description: 'Requires paid or trial access and a stable Idempotency-Key. Validates and resolves the public GitHub repository before recording a launch. No allocation until advance. Small is the default size; cwd is relative to /workspace/repo. Setup and start commands execute only after explicit launch. Supply startCommand and port together. Each recipient creates a private launch in their own account. Repeated keys return the original launch; conflicting options return 409. Server-side repo_launch_request_failed logs include the failing stage and dependency diagnostics; HTTP errors contain only the error code.',
    request: { headers: headers.extend({ 'Idempotency-Key': z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) }), ...requestBody(launchOptionsSchema) },
    responses: { 200: jsonResponse(launch), 201: jsonResponse(launch), ...errors(400, 401, 402, 403, 409, 413, 429, 503) },
  }, handler);
  register(api, 'get', '/repo-launches/{launchId}', {
    operationId: 'getRepositoryLaunch', tags: ['Containers'], summary: 'Read an owned repository launch', security: containerSecurity,
    description: 'Read-only persisted progress, exact generation and retained execution IDs. No allocation or replay. Execution logs use the existing executions API; preview URLs use the existing previews API and are never persisted in launch records.',
    request: { params, headers }, responses: { 200: jsonResponse(launch), ...errors(400, 401, 403, 404, 503) },
  }, handler);
  register(api, 'post', '/repo-launches/{launchId}/advance', {
    operationId: 'advanceRepositoryLaunch', tags: ['Containers'], summary: 'Advance or reconcile an owned repository launch', security: containerSecurity,
    description: 'Repeat to resume after refresh. Uses a durable lease and stable allocation/execution keys, pins the exact container generation, and inspects retained executions before advancing. Never silently reruns failed setup. After idempotency retention expires, uncertain operations require manual reconciliation. Creates the main tmux shell in /workspace/repo before setup. Preview servers run in a separate tmux session under existing idle/hard deadlines; readiness checks HTTP for up to three minutes. Failed setup/start preserves the shell. Active plan required to advance; GET remains available without paid access.',
    request: { params, headers }, responses: { 200: jsonResponse(launch), ...errors(400, 401, 402, 403, 404, 409, 429, 503) },
  }, handler);
}
