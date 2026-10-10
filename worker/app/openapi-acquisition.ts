import { z } from 'zod';
import { errors, jsonResponse, register, cookieSecurity, type LegacyHandler, type OpenAPIApi } from './openapi-shared';

const attribution = z.object({
  entryPage: z.string(), variant: z.string(), utm_source: z.string().optional(), utm_medium: z.string().optional(),
  utm_campaign: z.string().optional(), utm_content: z.string().optional(), utm_term: z.string().optional(), creator: z.string().optional(),
  gclid: z.string().optional(), fbclid: z.string().optional(), msclkid: z.string().optional(), ttclid: z.string().optional(),
});
const lead = z.object({ id: z.uuid(), repo: z.string(), attribution, createdAt: z.number(), userId: z.string().nullable(),
  contactEmail: z.string().nullable(), capturedAt: z.number().nullable() });
const event = z.object({ sequence: z.number(), key: z.string(), type: z.string(), userId: z.string().nullable(), leadId: z.string().nullable(),
  occurredAt: z.number(), recordedAt: z.number(), data: z.record(z.string(), z.unknown()), repo: z.string().nullable(), attribution: attribution.nullable() });
const pagination = z.object({ limit: z.number(), next: z.union([z.string(), z.number()]).nullable() });

export function registerAcquisitionRoutes(api: OpenAPIApi, handler: LegacyHandler): void {
  register(api, 'post', '/acquisition/repositories', {
    operationId: 'submitAcquisitionRepository', tags: ['Acquisition'], summary: 'Record an anonymous public repository submission',
    description: 'Requires an allowed browser Origin. Accepts only a public GitHub repository, a 64-character browser-generated token, and allowlisted attribution fields; verifies repository visibility with GitHub before storing. Repeating the same token and repository returns the original lead without a second GitHub lookup; a changed repository returns 409. Does not create a captured lead or allocate compute. Enabled only when ACQUISITION_ENABLED is true.',
    security: [], request: { headers: z.object({ Origin: z.string() }), body: { required: true, content: { 'application/json': { schema: z.object({
      token: z.string().regex(/^[a-f0-9]{64}$/), repo: z.string(), attribution: z.object({ entryPage: z.string(), variant: z.string().optional(),
        utm_source: z.string().optional(), utm_medium: z.string().optional(), utm_campaign: z.string().optional(), utm_content: z.string().optional(),
        utm_term: z.string().optional(), creator: z.string().optional(), gclid: z.string().optional(), fbclid: z.string().optional(),
        msclkid: z.string().optional(), ttclid: z.string().optional() }).strict() }).strict() } } } },
    responses: { 200: jsonResponse(z.object({ leadId: z.uuid(), repo: z.string() })), 201: jsonResponse(z.object({ leadId: z.uuid(), repo: z.string() })), ...errors(400, 403, 409, 413, 429, 503) },
  }, handler);
  register(api, 'post', '/acquisition/link', {
    operationId: 'linkAcquisitionLead', tags: ['Acquisition'], summary: 'Link an anonymous repository submission to the signed-in account',
    description: 'Requires an allowed Origin and browser session. The backend uses the signed-in account email and accepts only the submission token; a lead can be linked once, within 30 days. Appends lead.captured only after linking the verified repository intent to a real account contact. Enabled only when ACQUISITION_ENABLED is true.',
    security: cookieSecurity, request: { headers: z.object({ Origin: z.string() }), body: { required: true, content: { 'application/json': { schema: z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) }).strict() } } } },
    responses: { 200: jsonResponse(z.object({ linked: z.literal(true) })), ...errors(400, 401, 403, 404, 409, 413, 503) },
  }, handler);
  register(api, 'get', '/admin/acquisition/leads', {
    operationId: 'listAdminAcquisitionLeads', tags: ['Admin'], summary: 'List acquisition leads',
    description: 'Requires a browser session for oneone@gmail.com. Returns stored lead contact and attribution fields but never the token hash. Bounded newest-first pagination uses an opaque lead ID cursor; limit is at most 100.',
    security: cookieSecurity, request: { query: z.object({ limit: z.coerce.number().int().min(1).max(100).optional(), after: z.uuid().optional(), userId: z.string().optional(), leadId: z.uuid().optional() }) },
    responses: { 200: jsonResponse(z.object({ leads: z.array(lead), next: z.uuid().nullable(), limit: z.number() })), ...errors(400, 401, 403, 405, 503) },
  }, handler);
  register(api, 'get', '/admin/acquisition/events', {
    operationId: 'listAdminAcquisitionEvents', tags: ['Admin'], summary: 'List acquisition product events',
    description: 'Requires a browser session for oneone@gmail.com. Returns append-only product events with effective account first-touch attribution when available. Sequence cursor is exclusive; limit is at most 100.',
    security: cookieSecurity, request: { query: z.object({ limit: z.coerce.number().int().min(1).max(100).optional(), after: z.coerce.number().int().min(0).optional(),
      userId: z.string().optional(), leadId: z.uuid().optional(), event: z.enum(['repo.submitted','lead.captured','user.created','workspace.started','workload.activated','preview.opened','developer.qualified','wallet.funded_paid','compute.consumed_paid','launch.failed']).optional() }) },
    responses: { 200: jsonResponse(z.object({ events: z.array(event), next: z.number().nullable(), limit: z.number() })), ...errors(400, 401, 403, 405, 503) },
  }, handler);
}
