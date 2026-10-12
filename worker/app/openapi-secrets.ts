import { z } from 'zod';
import { containerSecurity, errors, jsonResponse, register, requestBody, type LegacyHandler, type OpenAPIApi } from './openapi-shared';

export const secretIdSchema = z.string().regex(/^sec_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
export const secretMetadataSchema = z.object({
  id: secretIdSchema, name: z.string().min(1).max(80), hostname: z.string(),
  header: z.enum(['authorization', 'x-api-key', 'api-key']), prefix: z.string().max(32),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
}).openapi('SecretMetadata');
const headers = z.object({ Origin: z.string().optional() });
const value = z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/).describe('Write-only credential; never returned, logged, or placed in the guest.');
const failures = errors(400, 401, 402, 403, 404, 405, 409, 413, 429, 503);

export function registerSecretRoutes(api: OpenAPIApi, handler: LegacyHandler): void {
  register(api, 'get', '/secrets', { operationId: 'listSecrets', tags: ['Secrets'], security: containerSecurity,
    summary: 'List owned secret metadata', description: 'Metadata only. Available during billing outages and disabled issuance. Values and encrypted records are never returned.',
    responses: { 200: jsonResponse(z.object({ secrets: z.array(secretMetadataSchema) })), ...failures } }, handler);
  register(api, 'post', '/secrets', { operationId: 'createSecret', tags: ['Secrets'], security: containerSecurity,
    summary: 'Store an encrypted, host-scoped outbound credential',
    description: 'Requires secrets.vault, operator rollout access for the authenticated account, and paid access. Hostname, header and prefix are immutable. Bind the returned ID using secretBindings when creating a machine with networkPolicy. Injection happens outside the guest for HTTPS to the exact allowed hostname. Choose a trusted upstream and scoped, revocable token: an upstream can disclose or transform its credentials in responses. Secret mediation is not a guarantee against a malicious upstream. Cookie mutations require a trusted Origin.',
    request: { headers, ...requestBody(z.object({ name: z.string().trim().min(1).max(80), value, hostname: z.string().min(1).max(253), header: z.enum(['authorization', 'x-api-key', 'api-key']), prefix: z.string().max(32).optional() })) },
    responses: { 201: jsonResponse(secretMetadataSchema), ...failures } }, handler);
  register(api, 'put', '/secrets/{secretId}', { operationId: 'rotateSecret', tags: ['Secrets'], security: containerSecurity,
    summary: 'Replace the value of an owned secret', description: 'Requires operator rollout access and paid access. Host/header scope is unchanged. New mediated requests use the replacement value. Already accepted upstream requests cannot be revoked.',
    request: { params: z.object({ secretId: secretIdSchema }), headers, ...requestBody(z.object({ value })) },
    responses: { 200: jsonResponse(secretMetadataSchema), ...failures } }, handler);
  register(api, 'delete', '/secrets/{secretId}', { operationId: 'deleteSecret', tags: ['Secrets'], security: containerSecurity,
    summary: 'Revoke an owned secret', description: 'Available without paid access or enabled issuance. Subsequent requests that require this binding fail closed; already accepted upstream requests may complete. Revoke the upstream credential separately when necessary.',
    request: { params: z.object({ secretId: secretIdSchema }), headers },
    responses: { 200: jsonResponse(z.object({ deleted: z.literal(true) })), ...failures } }, handler);
}
