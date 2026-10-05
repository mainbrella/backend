import { z } from 'zod';
import { containerSecurity, errors, jsonResponse, register, requestBody, type LegacyHandler, type OpenAPIApi } from './openapi-shared';
import { MIN_PREVIEW_PORT, MAX_PREVIEW_PORT, MAX_PREVIEW_TTL_SECONDS, DEFAULT_PREVIEW_TTL_SECONDS, MAX_PREVIEW_GRANTS } from '../../containers/preview-contract.js';

export const previewGrantSchema = z.object({ id: z.string().regex(/^[a-f0-9]{32}$/), port: z.number().int().min(MIN_PREVIEW_PORT).max(MAX_PREVIEW_PORT),
  createdAt: z.iso.datetime(), expiresAt: z.number().int() }).openapi('PreviewGrant');
const query = z.object({ id: z.string(), createdAt: z.iso.datetime() });
const headers = z.object({ Origin: z.string().optional() });
const reconciliation = jsonResponse(z.object({ error: z.string(), previewId: z.string().regex(/^[a-f0-9]{32}$/).optional() }), 'Unavailable or partial failure; retry revocation with previewId when supplied.');

export function registerPreviewRoutes(api: OpenAPIApi, handler: LegacyHandler): void {
  register(api, 'post', '/containers/previews', {
    operationId: 'createContainerPreview', tags: ['Containers'], summary: 'Issue a protected application preview URL', security: containerSecurity,
    description: `Available only on an explicitly configured isolated preview deployment. Requires owned running generation and paid access. Links are bearer capabilities: anyone with the URL may access that port until expiry or revocation. URL returned once; stored routing data contains only the token hash. Ports ${MIN_PREVIEW_PORT}–${MAX_PREVIEW_PORT}; SSH and privileged ports excluded. Up to ${MAX_PREVIEW_GRANTS} active grants per generation. TTL defaults to ${DEFAULT_PREVIEW_TTL_SECONDS} seconds and is clipped to the hard deadline; issuance does not extend the lease. HTTP and WebSockets use the same origin. Cookies are stripped. The app must already be listening. Cookie mutations require trusted Origin. Requests cap at 1024 bytes. Index-write failure triggers grant revocation; partial cleanup returns 503 with previewId for retry. Lost responses: list and revoke, then issue a new URL.`,
    request: { query, headers, ...requestBody(z.object({ port: z.number().int().min(MIN_PREVIEW_PORT).max(MAX_PREVIEW_PORT),
      ttlSeconds: z.number().int().min(60).max(MAX_PREVIEW_TTL_SECONDS).optional() }).strict()) },
    responses: { 201: jsonResponse(previewGrantSchema.extend({ url: z.url() })), ...errors(400, 401, 402, 403, 409, 413, 429), 503: reconciliation },
  }, handler);
  register(api, 'get', '/containers/previews', {
    operationId: 'listContainerPreviews', tags: ['Containers'], summary: 'List active grants for an owned running generation', security: containerSecurity,
    description: 'Requires paid access and exact running generation. Remains available when issuance is disabled. Returns grant metadata only, including grants left by lost issuance responses; no URLs, raw tokens or hashes. Does not create or restart a machine.',
    request: { query, headers }, responses: { 200: jsonResponse(z.object({ previews: z.array(previewGrantSchema).max(MAX_PREVIEW_GRANTS) })), ...errors(400, 401, 402, 403, 409, 503) },
  }, handler);
  register(api, 'delete', '/containers/previews', {
    operationId: 'revokeContainerPreview', tags: ['Containers'], summary: 'Revoke a preview and close its active transports', security: containerSecurity,
    description: 'Owner only; requires paid access and exact running generation. Remains available when issuance is disabled. Idempotent within that generation. Removes the owner-scoped route before closing runtime HTTP/WebSocket transports. Both operations are attempted even when one fails. Partial failures return 503 with previewId; retry the same request. Cookie mutations require trusted Origin.',
    request: { query: query.extend({ previewId: z.string().regex(/^[a-f0-9]{32}$/) }), headers },
    responses: { 200: jsonResponse(z.object({ revoked: z.literal(true) })), ...errors(400, 401, 402, 403, 409), 503: reconciliation },
  }, handler);
}
