import { z } from 'zod';
import { errors, jsonResponse, register, requestBody, type LegacyHandler, type OpenAPIApi } from './openapi-shared';
import { networkPolicySchema } from '../schemas.ts';

const operator = [{ operatorBearer: [] }];
const params = z.object({ runId: z.string().uuid() });
export function registerSecurityInfrastructureRoutes(api: OpenAPIApi, kind: 'relay' | 'ack', handler: LegacyHandler) {
  if (kind === 'relay') {
    register(api, 'post', '/v1/egress', { operationId: 'mediateSecurityEgress', tags: ['Security infrastructure'], security: operator,
      summary: 'Forward an authenticated control-plane egress envelope',
      description: 'Dedicated shared relay service. Requires the operator EGRESS_RELAY_TOKEN, not a customer API key. Validates every DNS result, pins a public allowed address, preserves TLS hostname verification, and denies redirects and credential reflections. Credentials remain in trusted infrastructure. Requests are bounded and buffered; streaming/SSE and WebSockets are unsupported. Sleeps after idle timeout.',
      request: requestBody(z.object({ version: z.literal(1), url: z.string().url(), method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']),
        headers: z.array(z.tuple([z.string(), z.string()])), body: z.string().describe('Base64 request bytes, at most 4 MiB decoded.'), policy: networkPolicySchema,
        injections: z.array(z.object({ header: z.enum(['authorization', 'x-api-key', 'api-key']), prefix: z.string(), value: z.string().max(4096) })).max(16) })),
      responses: { 200: jsonResponse(z.object({ version: z.literal(1), status: z.number().int(), headers: z.array(z.tuple([z.string(), z.string()])), body: z.string() })), ...errors(403, 503) } }, handler);
    return;
  }
  register(api, 'get', '/runs/{runId}/{action}', { operationId: 'acknowledgeSecurityProbe', tags: ['Security infrastructure'], security: [{ upstreamBearer: [] }, {}],
    summary: 'Disposable qualification upstream acknowledgment and adversaries', description: 'Test fixture only. Never returns a credential in an ordinary acknowledgment. Reflection actions deliberately return disposable test credentials to verify relay rejection. Tokens and runs expire after 15 minutes.',
    request: { params: params.extend({ action: z.enum(['public', 'auth', 'slow', 'redirect', 'reflect', 'reflect-base64', 'reflect-header']) }) },
    responses: { 200: { description: 'Fixed JSON acknowledgment, or a deliberately reflected disposable credential for an adversarial action.', content: {
      'application/json': { schema: z.object({ fixture: z.literal('rodeo-security'), runId: z.string().uuid(), authenticated: z.boolean(), version: z.number().int(), internalHeaders: z.boolean() }) },
      'text/plain': { schema: z.string().describe('Only reflection actions return a raw or base64 disposable test credential; the relay must withhold it.') },
    } }, 302: { description: 'Deliberate redirect to an owned denied destination.' }, ...errors(404, 409) } }, handler);
  for (const [method, operationId] of [['post', 'configureSecurityProbe'], ['put', 'rotateSecurityProbe']] as const) register(api, method, '/control/{runId}', {
    operationId, tags: ['Security infrastructure'], security: operator, summary: 'Set a disposable upstream token for a qualification run',
    request: { params, ...requestBody(z.object({ value: z.string().regex(/^[a-f0-9]{64}$/) })) }, responses: { 200: jsonResponse(z.object({ configured: z.literal(true), version: z.number().int() })), ...errors(400, 403, 404, 409) },
  }, handler);
  register(api, 'get', '/control/{runId}', { operationId: 'inspectSecurityProbe', tags: ['Security infrastructure'], security: operator, summary: 'Inspect pending qualification requests without reading the token',
    request: { params }, responses: { 200: jsonResponse(z.object({ exists: z.boolean(), version: z.number().int(), pending: z.boolean() })), ...errors(403) } }, handler);
  register(api, 'delete', '/control/{runId}', { operationId: 'deleteSecurityProbe', tags: ['Security infrastructure'], security: operator, summary: 'Delete only this qualification run and its token',
    request: { params }, responses: { 200: jsonResponse(z.object({ deleted: z.literal(true) })), ...errors(403) } }, handler);
  register(api, 'post', '/control/{runId}/release', { operationId: 'releaseSecurityProbe', tags: ['Security infrastructure'], security: operator, summary: 'Release a pending slow qualification response',
    request: { params }, responses: { 200: jsonResponse(z.object({ released: z.literal(true) })), ...errors(403) } }, handler);
}
