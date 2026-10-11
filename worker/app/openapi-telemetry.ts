import { z } from 'zod';
import { containerSecurity, errors, jsonResponse, register, type LegacyHandler, type OpenAPIApi } from './openapi-shared';

const attribute = z.object({ key: z.string(), value: z.union([z.object({ stringValue: z.string() }), z.object({ intValue: z.string() })]) });
const resource = z.object({ attributes: z.array(attribute) });
const scope = z.object({ name: z.string(), version: z.string() });
const point = z.object({ startTimeUnixNano: z.string(), timeUnixNano: z.string(), asDouble: z.number(), attributes: z.array(attribute) });
const query = z.object({ id: z.string(), createdAt: z.iso.datetime() });
export function registerTelemetryRoutes(api: OpenAPIApi, handler: LegacyHandler) {
  register(api, 'get', '/containers/telemetry/logs', {
    operationId: 'exportContainerOtlpLogs', tags: ['Containers'], security: containerSecurity,
    summary: 'Export lifecycle events as an OTLP/HTTP JSON logs request',
    description: 'Pull export; forward the JSON body to your collector /v1/logs. Same ownership, generation and retention as /containers/events. Pagination metadata is returned in Mainbrella-Next-Cursor, Mainbrella-Has-More and Mainbrella-History-Truncated headers. Persist a cursor only after collector acknowledgement and deduplicate on event.id. Does not push to a customer URL or renew compute.',
    request: { query: query.extend({ cursor: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(100).optional() }) },
    responses: { 200: { ...jsonResponse(z.object({ resourceLogs: z.array(z.object({ resource, scopeLogs: z.array(z.object({ scope,
      logRecords: z.array(z.object({ timeUnixNano: z.string(), severityNumber: z.number().int(), severityText: z.string(), body: z.object({ stringValue: z.string() }), attributes: z.array(attribute) })),
    })) })) })), headers: {
      'Mainbrella-Next-Cursor': { schema: { type: 'string' } }, 'Mainbrella-Has-More': { schema: { type: 'string', enum: ['true', 'false'] } },
      'Mainbrella-History-Truncated': { schema: { type: 'string', enum: ['true', 'false'] } },
    } }, ...errors(400, 401, 403, 404, 405, 503) },
  }, handler);
  register(api, 'get', '/containers/telemetry/metrics', {
    operationId: 'exportContainerOtlpMetrics', tags: ['Containers'], security: containerSecurity,
    summary: 'Export workload metrics as an OTLP/HTTP JSON metrics request',
    description: 'Requires observability.metrics. Pull export for a collector /v1/metrics: sampled CPU seconds as delta sums, peak memory bytes as gauges. Uses the same generation/range checks as /containers/metrics. Missing samples are omitted. Unqualified disk units are omitted. Mainbrella-Metrics-State is observed or unobserved. Export non-overlapping intervals to avoid duplicate delta sums.',
    request: { query: query.extend({ from: z.iso.datetime().optional(), to: z.iso.datetime().optional() }) },
    responses: { 200: { ...jsonResponse(z.object({ resourceMetrics: z.array(z.object({ resource, scopeMetrics: z.array(z.object({ scope,
      metrics: z.array(z.object({ name: z.string(), unit: z.string(), description: z.string(),
        sum: z.object({ aggregationTemporality: z.literal(1), isMonotonic: z.literal(true), dataPoints: z.array(point) }).optional(),
        gauge: z.object({ dataPoints: z.array(point) }).optional() })),
    })) })) })), headers: { 'Mainbrella-Metrics-State': { schema: { type: 'string', enum: ['observed', 'unobserved'] } } } }, ...errors(400, 401, 403, 404, 405, 503) },
  }, handler);
}
