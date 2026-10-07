import { z } from 'zod';
import { containerSecurity, errors, jsonResponse, register, requestBody, type LegacyHandler, type OpenAPIApi } from './openapi-shared';
import { MAX_PRIVATE_NETWORKS, MAX_PRIVATE_MEMBERS } from '../../containers/private-services-contract.js';

const name = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
const member = z.object({ id: z.string(), createdAt: z.iso.datetime(), name,
  port: z.number().int().min(1024).max(65535).optional() }).strict().openapi('PrivateServiceMember');
const network = z.object({ name, members: z.array(member).max(MAX_PRIVATE_MEMBERS) }).openapi('PrivateServiceNetwork');
const query = z.object({ network: name });
const headers = z.object({ Origin: z.string().optional() });
const description = 'Private Services HTTP prototype. Account-owned registry; explicit machine membership and exact running generations. Plain HTTP on port 80 to http://NAME.internal routes to a registered application port. No arbitrary TCP, database protocol, private IP, or HTTPS support. Internet policy and machine lifecycles are independent. Public previews remain opt-in. Requests and responses are bounded to 1 MiB; requests time out after 10 seconds. WebSockets and CONNECT are rejected. Application redirects are returned without being followed. Account identity is supplied by the platform; guests need no Mainbrella API key. Cookie mutations require a trusted Origin.';

export function registerPrivateServiceRoutes(api: OpenAPIApi, handler: LegacyHandler): void {
  register(api, 'get', '/private-services/networks', {
    operationId: 'listPrivateServiceNetworks', tags: ['Private Services'], summary: 'List owned networks and registered machine generations',
    security: containerSecurity, description: `${description} Registry entries may outlive stopped generations; stale entries cannot route. With search, page, or limit, returns pagination metadata; page defaults to 1 and limit to 10. Pages beyond the last page clamp to the last page. Without query parameters returns the complete registry for compatibility. Listing remains available when issuance is disabled and does not start machines.`,
    request: { headers, query: z.object({
      search: z.string().max(63).optional().describe('Case-insensitive substring of the network name.'),
      page: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }) }, responses: { 200: jsonResponse(z.object({ networks: z.array(network).max(MAX_PRIVATE_NETWORKS),
      total: z.number().int().nonnegative().optional(), totalNetworks: z.number().int().nonnegative().optional(),
      page: z.number().int().positive().optional(), limit: z.number().int().positive().optional() })), ...errors(400, 401, 403, 405, 503) },
  }, handler);
  register(api, 'post', '/private-services/networks', {
    operationId: 'createPrivateServiceNetwork', tags: ['Private Services'], summary: 'Create an account-owned Private Services network',
    security: containerSecurity, description: `${description} Requires paid access and explicit deployment enablement. Up to ${MAX_PRIVATE_NETWORKS} networks per account. Duplicate name returns network_name_conflict; limit returns network_limit. Body limit 1024 bytes.`,
    request: { headers, ...requestBody(z.object({ name }).strict()) }, responses: { 201: jsonResponse(network), ...errors(400, 401, 402, 403, 405, 409, 413, 429, 503) },
  }, handler);
  register(api, 'delete', '/private-services/networks', {
    operationId: 'deletePrivateServiceNetwork', tags: ['Private Services'], summary: 'Delete an empty owned network',
    security: containerSecurity, description: `${description} Idempotent. Detach all members first; otherwise network_not_empty. Remains available when issuance is disabled or machines are stopped. Does not stop machines.`,
    request: { query, headers }, responses: { 200: jsonResponse(z.object({ deleted: z.literal(true) })), ...errors(400, 401, 403, 405, 409, 503) },
  }, handler);
  register(api, 'put', '/private-services/members', {
    operationId: 'attachPrivateServiceMember', tags: ['Private Services'], summary: 'Attach a running generation and optionally register an HTTP service port',
    security: containerSecurity, description: `${description} Requires paid access and deployment enablement. One network per machine generation. Upsert by machine ID; service names are unique within each network. Omit port for a caller-only machine. Conflicts return service_name_conflict or machine_already_attached. Stopped or replaced generations return container_not_running. Body limit 1024 bytes.`,
    request: { query, headers, ...requestBody(member) }, responses: { 200: jsonResponse(member.extend({ network: name })), ...errors(400, 401, 402, 403, 404, 405, 409, 413, 429, 503) },
  }, handler);
  register(api, 'delete', '/private-services/members', {
    operationId: 'detachPrivateServiceMember', tags: ['Private Services'], summary: 'Detach an exact generation without stopping it',
    security: containerSecurity, description: `${description} Idempotent within an existing network. Delayed cleanup for an old generation cannot remove its replacement. Name is required; the exact ID and createdAt select the membership. Available when issuance is disabled or machines are stopped. Body limit 1024 bytes.`,
    request: { query, headers, ...requestBody(member) }, responses: { 200: jsonResponse(z.object({ detached: z.literal(true) })), ...errors(400, 401, 403, 404, 405, 413, 503) },
  }, handler);
}
