import { z } from 'zod';
import { containerSecurity, errors, jsonResponse, register, type LegacyHandler, type OpenAPIApi } from './openapi-shared';
import { OBSERVATION_RETENTION_MS, MAX_LIFECYCLE_EVENTS, MAX_EVENT_PAGE } from '../../containers/observations.js';
import { MAX_METRIC_RANGE_MS, METRIC_BUCKET_MS } from '../lib/workload-metrics';

const query = z.object({ id: z.string(), createdAt: z.iso.datetime() });
const headers = z.object({ Origin: z.string().optional() });
const event = z.object({ id: z.uuid(), sequence: z.number().int().positive(), createdAt: z.iso.datetime(), occurredAt: z.iso.datetime(),
  type: z.enum(['starting', 'started', 'failed', 'stopped']), reason: z.string().optional(), size: z.string(), retainUntil: z.number().int() });
const measurement = z.number().nonnegative().nullable();
const bucket = z.object({ at: z.iso.datetime(), samples: z.number().int().positive(), cpuSeconds: measurement, memoryPeakBytes: measurement,
  diskUsagePeak: measurement.describe('Provider diskUsage maximum. Unit qualification remains an operator rollout gate; do not label it as bytes or billing usage.') });
export function registerObservationRoutes(api: OpenAPIApi, handler: LegacyHandler) {
  register(api, 'get', '/containers/events', {
    operationId: 'listContainerLifecycleEvents', tags: ['Containers'], summary: 'Read lifecycle history for an owned generation', security: containerSecurity,
    description: `Read-only, available during billing outages and after stop. Does not provision, renew activity or contact the guest. Events have stable IDs and increasing slot-wide sequence numbers; filter by exact generation. Retention ${OBSERVATION_RETENTION_MS} ms, bounded to ${MAX_LIFECYCLE_EVENTS} events per machine slot across generations. Deduplicate by id, order by sequence and use nextCursor for pagination. historyTruncated reports when the starting event has been pruned. A started event establishes readiness; starting alone does not. Failed/stopped observations use bounded reason codes, never provider exception text. Natural-stop timestamps record when the control plane observed stop, not an exact guest timestamp. Legacy/expired generations without observations return 404. Customer webhooks are not yet available.`,
    request: { query: query.extend({ cursor: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(MAX_EVENT_PAGE).optional() }), headers },
    responses: { 200: jsonResponse(z.object({ events: z.array(event), nextCursor: z.number().int().nonnegative(), hasMore: z.boolean(), historyTruncated: z.boolean(), retainForMs: z.number().int() })), ...errors(400, 401, 403, 404, 503) },
  }, handler);
  register(api, 'get', '/containers/metrics', {
    operationId: 'getContainerWorkloadMetrics', tags: ['Containers'], summary: 'Read provider workload metric history for an owned generation', security: containerSecurity,
    description: `Disabled until explicit operator configuration/qualification. Requires observability.metrics capability. Reads provider analytics using an opaque generation label; no guest exec or lease renewal. Requested range stays within that generation, the last seven days and ${MAX_METRIC_RANGE_MS} ms. Default last hour, ${METRIC_BUCKET_MS} ms buckets, bounded 1441 rows. Half-open [from,to); first bucket can begin before an unaligned from. Samples can be delayed/adaptively sampled; empty/legacy data is unobserved, never zero or healthy. CPU seconds and memory peak bytes come from workload metrics; diskUsagePeak preserves the provider value pending unit qualification. This is neither billing resource allocation nor public service health. Credentials and provider identity labels stay in the control plane.`,
    request: { query: query.extend({ from: z.iso.datetime().optional(), to: z.iso.datetime().optional() }), headers },
    responses: { 200: jsonResponse(z.object({ id: z.string(), createdAt: z.iso.datetime(), from: z.iso.datetime(), to: z.iso.datetime(), bucketMs: z.number().int(),
      source: z.literal('cloudflare-workload-analytics'), state: z.enum(['observed', 'unobserved']), buckets: z.array(bucket) })), ...errors(400, 401, 403, 404, 503) },
  }, handler);
}
