import { z } from 'zod';
import { containerSecurity, errors, jsonResponse, register, requestBody, type LegacyHandler, type OpenAPIApi } from './openapi-shared';
import { containerStatusSchema, networkPolicySchema, sizeSchema } from './openapi-containers';
import { secretIdSchema } from './openapi-secrets';
import { MAX_MANAGED_POOLS, MAX_POOL_SIZE, MIN_POOL_TTL_SECONDS, MAX_POOL_TTL_SECONDS } from '../../containers/pool-contract.js';

const id = z.string().regex(/^pool_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
const name = z.string().trim().min(1).max(80).regex(/^[^\u0000-\u001f\u007f]+$/);
const targetSize = z.number().int().min(0).max(MAX_POOL_SIZE);
const selection = z.object({ size: sizeSchema, internet: z.boolean(), catalogId: z.string().optional(), imageId: z.string().optional(),
  networkPolicy: networkPolicySchema.optional(), secretBindings: z.array(secretIdSchema).max(16).optional() });
export const managedPoolSchema = z.object({ id, name, targetSize, ready: z.number().int().nonnegative(), starting: z.number().int().nonnegative(),
  status: z.enum(['active', 'paused', 'expired', 'deleting', 'degraded']), createdAt: z.string().datetime(), updatedAt: z.string().datetime(), expiresAt: z.string().datetime(),
  selection, lastError: z.string().optional() }).openapi('ManagedPool');
const response = z.object({ pool: managedPoolSchema });
const headers = z.object({ Origin: z.string().optional() });
const keyedHeaders = headers.extend({ 'Idempotency-Key': z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) });
const params = z.object({ poolId: id });
const failures = errors(400, 401, 402, 403, 404, 405, 409, 410, 413, 429, 503);

export function registerPoolRoutes(api: OpenAPIApi, handler: LegacyHandler): void {
  register(api, 'get', '/pools', { operationId: 'listPools', tags: ['Pools'], security: containerSecurity, summary: 'List account-managed prewarming pools',
    responses: { 200: jsonResponse(z.object({ pools: z.array(managedPoolSchema).max(MAX_MANAGED_POOLS) })), ...failures } }, handler);
  register(api, 'post', '/pools', { operationId: 'createPool', tags: ['Pools'], security: containerSecurity, summary: 'Create a time-bounded pool with automatic replenishment',
    description: 'Requires pools.managed and paid access. Maximum eight pools per account. targetSize is unclaimed inventory, including starts in progress; zero pauses and drains inventory. Required ttlSeconds bounds automatic spending to at most 24 hours. Warm guests are ordinary billed ad-hoc containers and consume existing starts, compute allowance, concurrency and spending caps, even before acquisition. Their original session and idle deadlines remain in effect. Replenishment runs through account Durable Object alarms, remains bounded by billing and quota, and retries temporary errors with backoff; readiness is not guaranteed. Image/network selection and expiry are immutable. On expiry, only unclaimed inventory is stopped. Idempotency-Key retains one pool creation for 24 hours; a deleted original returns 409 pool_no_longer_exists. Cookie mutations require a trusted Origin.',
    request: { headers: keyedHeaders, ...requestBody(selection.partial().extend({ name, targetSize, ttlSeconds: z.number().int().min(MIN_POOL_TTL_SECONDS).max(MAX_POOL_TTL_SECONDS) }).strict()) },
    responses: { 200: jsonResponse(response, 'Idempotent replay.'), 201: jsonResponse(response), ...failures } }, handler);
  register(api, 'get', '/pools/{poolId}', { operationId: 'getPool', tags: ['Pools'], security: containerSecurity, summary: 'Read managed pool readiness and refill errors',
    request: { params }, responses: { 200: jsonResponse(response), ...failures } }, handler);
  register(api, 'patch', '/pools/{poolId}', { operationId: 'updatePool', tags: ['Pools'], security: containerSecurity, summary: 'Rename or resize a managed pool',
    description: 'Only name and targetSize can change. Lowering targetSize stops excess unclaimed inventory; acquired machines are unaffected. Zero pauses replenishment and drains inventory. Expired pools cannot be extended. Cookie mutations require a trusted Origin.',
    request: { params, headers, ...requestBody(z.object({ name: name.optional(), targetSize: targetSize.optional() }).strict()) }, responses: { 200: jsonResponse(response), ...failures } }, handler);
  register(api, 'delete', '/pools/{poolId}', { operationId: 'deletePool', tags: ['Pools'], security: containerSecurity, summary: 'Delete a managed pool and stop its unclaimed guests',
    description: 'Deletion is idempotent and available during billing outages or disabled pool issuance. Acquired guests are unaffected. Ambiguous stops remain generation-fenced and retry on alarms; 503 pool_cleanup_pending means deletion is persisted and cleanup remains in progress. Cookie mutations require a trusted Origin.',
    request: { params, headers }, responses: { 200: jsonResponse(z.object({ deleted: z.literal(true) })), ...failures } }, handler);
  register(api, 'post', '/pools/{poolId}/acquire', { operationId: 'acquirePoolContainer', tags: ['Pools'], security: containerSecurity, summary: 'Atomically acquire one running pool guest',
    description: 'Requires Idempotency-Key; no body or an empty JSON object. Removes exactly one running generation from inventory and schedules replacement. Acquired guests are never returned to a pool. Session and idle deadlines are not reset. Returns 409 pool_empty if none is ready, 410 pool_expired after expiry. Replays retain the original generation for 24 hours; stopped/replaced generations return 409 acquisition_no_longer_running. Reusing a key for a different pool returns 409 idempotency_key_conflict. Cookie mutations require a trusted Origin.',
    request: { params, headers: keyedHeaders, ...requestBody(z.object({}).strict(), false) },
    responses: { 200: jsonResponse(z.object({ poolId: id, container: containerStatusSchema.shape.containers.element })), ...failures } }, handler);
}
