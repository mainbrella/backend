import { z } from 'zod';
import { STATUS_COMPONENTS, observationInput, incidentInput } from './status';
import { errors, jsonResponse, register, requestBody, type LegacyHandler, type OpenAPIApi } from './openapi-shared';

const state = z.enum(['operational', 'degraded', 'outage', 'unknown']);
const component = z.enum(STATUS_COMPONENTS);
const observation = z.object({ id: z.number().int(), component, state, scope: z.enum(['reachability', 'control_plane', 'synthetic']),
  latencyMs: z.number().int().nullable(), checkedAt: z.iso.datetime() });
export function registerStatusRoutes(api: OpenAPIApi, handler: LegacyHandler): void {
  register(api, 'get', '/status', {
    operationId: 'getOperationalStatus', tags: ['Operations'], summary: 'Read component observations and incidents', security: [],
    description: 'Public status with evidence scope. Missing observations or observations older than 15 minutes are unknown. Reachability and control-plane checks do not establish full workflow health. Active incidents prevent an overall operational state. No provisioning occurs.',
    responses: { 200: jsonResponse(z.object({ state, generatedAt: z.iso.datetime(), staleAfterMs: z.number().int(), components: z.array(z.object({
      component, state, stale: z.boolean(), scope: z.enum(['reachability', 'control_plane', 'synthetic']).nullable(), latencyMs: z.number().int().nullable(), checkedAt: z.iso.datetime().nullable() })),
      incidents: z.array(z.object({ id: z.uuid(), component, title: z.string(), state: z.enum(['investigating','identified','monitoring','resolved']), message: z.string(),
        started_at: z.iso.datetime(), updated_at: z.iso.datetime(), resolved_at: z.iso.datetime().nullable() })) })), ...errors(400, 403, 503) },
  }, handler);
  register(api, 'get', '/status/history', {
    operationId: 'getStatusHistory', tags: ['Operations'], summary: 'Read recent component observations', security: [],
    description: 'Returns up to 100 observations before the optional exclusive ISO timestamp, optionally for one component. Observation history is retained for 31 days; incidents are retained separately. Does not estimate availability from missing samples.',
    request: { query: z.object({ before: z.iso.datetime().optional(), component: component.optional() }) },
    responses: { 200: jsonResponse(z.object({ observations: z.array(observation), retentionDays: z.number().int() })), ...errors(400, 403, 503) },
  }, handler);
  register(api, 'post', '/internal/status/observations', {
    operationId: 'recordStatusObservations', tags: ['Internal'], summary: 'Record bounded operational observations', security: [{ monitoring: [] }],
    description: 'Requires configured MONITORING_SECRET Bearer credential. At most seven distinct components per request. Timestamp is assigned by the server. No user/API key authentication.',
    request: requestBody(z.object({ observations: z.array(observationInput).min(1).max(7) }).strict()),
    responses: { 200: jsonResponse(z.object({ ok: z.boolean(), checkedAt: z.iso.datetime() })), ...errors(400, 401, 403, 503) },
  }, handler);
  register(api, 'post', '/internal/status/incidents', {
    operationId: 'recordStatusIncident', tags: ['Internal'], summary: 'Create or update a public incident', security: [{ monitoring: [] }],
    description: 'Requires configured MONITORING_SECRET. Upserts by UUID and preserves initial timestamp. Component cannot change; resolved incidents cannot reopen. Title/message are public operator-authored text.',
    request: requestBody(incidentInput), responses: { 200: jsonResponse(z.object({ ok: z.boolean(), id: z.uuid() })), ...errors(400, 401, 403, 409, 503) },
  }, handler);
}
