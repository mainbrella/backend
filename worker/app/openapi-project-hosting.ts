import { z } from 'zod';
import { cookieSecurity, errors, jsonResponse, register, requestBody, type LegacyHandler, type OpenAPIApi } from './openapi-shared';

const projectQuery = z.object({ id: z.string().uuid() });
const domainQuery = projectQuery.extend({ domainId: z.string().uuid() });
export const projectTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('container'), id: z.string().min(1), createdAt: z.string().datetime(), port: z.number().int().min(1024).max(65535) }).strict(),
  z.object({ kind: z.literal('network'), network: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/), service: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/) }).strict(),
]).openapi('ProjectTarget');
const dnsRecord = z.object({ type: z.string(), name: z.string(), value: z.string(), purpose: z.enum(['ownership', 'routing', 'certificate']) });
export const projectDomainSchema = z.object({
  id: z.string().uuid(), hostname: z.string(), status: z.enum(['pending_dns', 'pending_tls', 'active', 'error']),
  dnsStatus: z.enum(['pending', 'verified']), tlsStatus: z.enum(['pending', 'active', 'error']),
  dnsRecords: z.array(dnsRecord), apexRecords: z.array(dnsRecord).optional(), routingNote: z.string().optional(), error: z.string().nullable(),
}).openapi('ProjectDomain');
const endpoint = z.object({ projectId: z.string().uuid(), url: z.string(), target: projectTargetSchema.nullable(), backendStatus: z.enum(['running', 'unavailable', 'unlinked']) });
const hosting = z.object({ supported: z.boolean(), customDomains: z.boolean(), apexIps: z.array(z.string()) });
const state = z.object({ endpoint, domains: z.array(projectDomainSchema), hosting });
const inspection = 'Requires a browser session and an owned project. Inspection and cleanup remain available when publication is disabled. Domain metadata on the project does not publish an application.';

export function registerProjectHostingRoutes(api: OpenAPIApi, handler: LegacyHandler): void {
  register(api, 'get', '/projects/endpoint', {
    operationId: 'getProjectEndpoint', tags: ['Projects'], summary: 'Inspect a project endpoint and its domains', security: cookieSecurity,
    description: inspection + ' DNS, certificate, and exact-generation backend availability are separate states. The stable default URL is public after publication.',
    request: { query: projectQuery }, responses: { 200: jsonResponse(state), ...errors(400, 401, 403, 404, 503) },
  }, handler);
  register(api, 'put', '/projects/endpoint', {
    operationId: 'publishProjectEndpoint', tags: ['Projects'], summary: 'Publish a project to a container or network service', security: cookieSecurity,
    description: 'Requires a trusted Origin, browser session, paid access, and enabled project hosting. Targets an owned exact running container generation and application port, or resolves one selected registered network service to that generation. Replacement generations require explicit republication. Container leases are unchanged. Revision fencing and persisted cleanup metadata reconcile lost or concurrent publication responses; project_reconciliation_required requires retrying cleanup before publishing again.',
    request: { query: projectQuery, ...requestBody(z.object({ target: projectTargetSchema }).strict()) },
    responses: { 200: jsonResponse(state), ...errors(400, 401, 402, 403, 404, 409, 429, 503) },
  }, handler);
  register(api, 'delete', '/projects/endpoint', {
    operationId: 'unpublishProjectEndpoint', tags: ['Projects'], summary: 'Disconnect a project backend', security: cookieSecurity,
    description: inspection + ' Requires a trusted Origin. Removes public endpoint routing and revokes matching runtime bindings and active transports. Domain registrations are retained. Retry cleanup when project_reconciliation_required is returned.',
    request: { query: projectQuery }, responses: { 200: jsonResponse(state), ...errors(400, 401, 403, 404, 409, 503) },
  }, handler);
  register(api, 'get', '/projects/domains', {
    operationId: 'listProjectDomains', tags: ['Projects'], summary: 'List a project’s custom domains and DNS records', security: cookieSecurity,
    description: inspection, request: { query: projectQuery },
    responses: { 200: jsonResponse(z.object({ domains: z.array(projectDomainSchema) })), ...errors(400, 401, 403, 404, 503) },
  }, handler);
  register(api, 'post', '/projects/domains', {
    operationId: 'addProjectDomain', tags: ['Projects'], summary: 'Register a custom hostname for verification', security: cookieSecurity,
    description: 'Requires a trusted Origin and an owned project. Normalizes a hostname and creates a project-specific TXT ownership challenge. URLs, IP addresses, wildcards, and platform domains are rejected. Pending registrations cannot reserve a hostname globally. Customers retain their DNS provider and nameservers. Root domains need provider-supported ALIAS/flattening or explicitly configured stable ingress IPs; never copy arbitrary Cloudflare edge IPs.',
    request: { query: projectQuery, ...requestBody(z.object({ hostname: z.string().min(1).max(253) }).strict()) },
    responses: { 201: jsonResponse(z.object({ domain: projectDomainSchema })), 200: jsonResponse(z.object({ domain: projectDomainSchema })), ...errors(400, 401, 403, 404, 409, 429, 503) },
  }, handler);
  register(api, 'post', '/projects/domains/verify', {
    operationId: 'verifyProjectDomain', tags: ['Projects'], summary: 'Check domain ownership, routing DNS, and HTTPS', security: cookieSecurity,
    description: 'Requires a trusted Origin and an owned domain registration. Verifies the account/project-specific TXT challenge before claiming routing or provisioning certificates. Cloudflare for SaaS requires both hostname and certificate activation. Static ingress requires configured A/AAAA destinations and an HTTPS gateway challenge, with redirects disabled. Only verified, active hostnames can reach applications.',
    request: { query: domainQuery }, responses: { 200: jsonResponse(z.object({ domain: projectDomainSchema })), ...errors(400, 401, 403, 404, 409, 503) },
  }, handler);
  register(api, 'delete', '/projects/domains', {
    operationId: 'removeProjectDomain', tags: ['Projects'], summary: 'Remove a project’s custom hostname', security: cookieSecurity,
    description: inspection + ' Requires a trusted Origin. Removes only this project’s verified hostname mapping and closes its active origin transports. Provider certificate cleanup is retryable; a stale cleanup cannot remove another project’s claim.',
    request: { query: domainQuery }, responses: { 200: jsonResponse(z.object({ deleted: z.literal(true) })), ...errors(400, 401, 403, 404, 409, 503) },
  }, handler);
}
