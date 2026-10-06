import { z } from 'zod';
import { containerSecurity, errors, jsonResponse, register, requestBody, type LegacyHandler, type OpenAPIApi } from './openapi-shared';
const query = z.object({ id: z.string(), createdAt: z.iso.datetime() });
const headers = z.object({ Origin: z.string().optional() });
const config = z.object({ id: z.uuid(), url: z.url().max(2048), createdAt: z.iso.datetime(), configuredAt: z.iso.datetime(), retainUntil: z.number().int() });
const delivery = z.object({ id: z.uuid(), sequence: z.number().int().positive(), status: z.enum(['pending', 'sending', 'delivered', 'exhausted']),
  attempts: z.number().int().nonnegative(), manualRetries: z.number().int().nonnegative(), nextAt: z.number().int().nullable(), retainUntil: z.number().int(),
  lastAttemptAt: z.number().int().optional(), httpStatus: z.number().int().nullable().optional() });
const responseErrors = errors(400, 401, 402, 403, 404, 409, 429, 503);
export function registerWebhookRoutes(api: OpenAPIApi, handler: LegacyHandler) {
  register(api, 'get', '/containers/webhook', { operationId: 'getContainerWebhook', tags: ['Containers'], summary: 'Read an owned generation webhook', security: containerSecurity,
    description: 'Available after stop and during billing outages. One configured destination per exact generation, up to 32 retained configurations per slot. Signing secrets are never returned by reads. No guest request or lease renewal.',
    request: { query, headers }, responses: { 200: jsonResponse(z.object({ webhook: config.nullable() })), ...responseErrors } }, handler);
  register(api, 'put', '/containers/webhook', { operationId: 'configureContainerWebhook', tags: ['Containers'], summary: 'Configure and rotate an owned generation webhook', security: containerSecurity,
    description: 'Disabled until API/runtime operator configuration. Requires an exact live paid generation. HTTPS targets must match an operator-controlled relay allowlist; arbitrary customer domains, IPs, credentials, custom ports and redirects are unsupported. Body caps at 4096 bytes. Returns a new signingSecret once; encrypted in runtime storage and never sent to the guest. Every PUT rotates the configuration/secret and clears old delivery attempts; no automatic retries. If a response is lost, reconcile with GET and explicitly rotate again if needed. Optional replayFromCursor queues retained generation events after that cursor; otherwise only future events. Configuration expires seven days after setup; deliveries expire with configuration or event retention, whichever is earlier. Cookie mutations require trusted Origin.',
    request: { query, headers, ...requestBody(z.object({ url: z.url().max(2048), replayFromCursor: z.number().int().nonnegative().optional() }).strict()) },
    responses: { 201: jsonResponse(z.object({ webhook: config, signingSecret: z.string() })), ...responseErrors } }, handler);
  register(api, 'delete', '/containers/webhook', { operationId: 'removeContainerWebhook', tags: ['Containers'], summary: 'Remove an owned webhook and future deliveries', security: containerSecurity,
    description: 'Owned cleanup remains available during billing outages and after stop. Cancels in-flight requests and removes queued attempts. A receiver may already have accepted an in-flight request; removal cannot undo delivery. Does not affect replacement generations. Cookie mutations require trusted Origin.',
    request: { query, headers }, responses: { 200: jsonResponse(z.object({ removed: z.literal(true) })), ...responseErrors } }, handler);
  register(api, 'get', '/containers/webhook/deliveries', { operationId: 'listContainerWebhookDeliveries', tags: ['Containers'], summary: 'Read bounded webhook delivery outcomes', security: containerSecurity,
    description: 'Up to 256 retained deliveries per slot. Includes stable lifecycle event ID, sequence, status, current retry-cycle attempts, manual retries, next/last attempt and HTTP status. Payload, response body, signing secret and provider exceptions are excluded. Delivery is at least once; consumers deduplicate by event ID and order by sequence. Eight automatic attempts use bounded backoff; response timeout is 10 seconds and success is any 2xx. Runtime recovery can cause duplicates. Reads remain available during billing outages.',
    request: { query, headers }, responses: { 200: jsonResponse(z.object({ deliveries: z.array(delivery) })), ...responseErrors } }, handler);
  register(api, 'post', '/containers/webhook/retry', { operationId: 'retryContainerWebhookDelivery', tags: ['Containers'], summary: 'Retry an exhausted owned webhook delivery', security: containerSecurity,
    description: 'Only retained exhausted deliveries are eligible. Restarts the eight-attempt retry cycle, at most three manual retries per event. The event ID stays stable. Available during billing outages; never starts a guest or renews activity. Cookie mutations require trusted Origin.',
    request: { query, headers, ...requestBody(z.object({ eventId: z.uuid() }).strict()) }, responses: { 202: jsonResponse(delivery), ...responseErrors } }, handler);
}
