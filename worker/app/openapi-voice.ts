import { z } from 'zod';
import { cookieSecurity, errors, jsonResponse, register, requestBody, type LegacyHandler, type OpenAPIApi } from './openapi-shared';

const voice = z.enum(['asteria', 'luna', 'athena']);
const channel = z.enum(['browser', 'text', 'phone']);
const headers = z.object({ Origin: z.string().optional() });
const callId = z.object({ callId: z.string().min(1).max(128) });
const agentId = z.object({ agentId: z.string().min(1).max(128) });

const agent = z.object({
  id: z.string(), name: z.string(), businessName: z.string(), greeting: z.string(), instructions: z.string(),
  voice, transferNumber: z.null(), updatedAt: z.iso.datetime(),
}).openapi('VoiceAgentConfig');
const call = z.object({
  id: z.string(), channel, status: z.enum(['active', 'completed', 'failed']), startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(), durationSeconds: z.number().int().nonnegative(),
  transcript: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string() })).max(60),
}).openapi('VoiceCall');
const failures = errors(400, 401, 403, 404, 409, 413, 429, 503);

export function registerVoiceRoutes(api: OpenAPIApi, handler: LegacyHandler): void {
  const common = { tags: ['Voice'], security: cookieSecurity };
  register(api, 'get', '/voice/config', {
    ...common, operationId: 'getVoiceConfig', summary: 'Read AI receptionist availability and model configuration',
    description: 'Reports whether browser calling and telephony are configured. Telephony URLs and numbers may be null. Voice reception supports calls up to 15 minutes and 60 transcript turns.',
    request: { headers }, responses: { 200: jsonResponse(z.object({
      enabled: z.boolean(), browserCalling: z.boolean(), telephony: z.object({ configured: z.boolean(), webhookUrl: z.string().nullable(), phoneNumber: z.string().nullable() }),
      models: z.object({ stt: z.string(), llm: z.string(), tts: z.string() }),
    })), ...errors(401, 403, 503) },
  }, handler);
  register(api, 'get', '/voice/agent', {
    ...common, operationId: 'getVoiceAgent', summary: 'Read the account AI receptionist configuration', request: { headers },
    responses: { 200: jsonResponse(z.object({ agent: agent.nullable() })), ...errors(401, 403, 503) },
  }, handler);
  register(api, 'put', '/voice/agent', {
    ...common, operationId: 'updateVoiceAgent', summary: 'Create or update the account AI receptionist',
    description: 'Agent fields are bounded by the request schema. Number transfer is not supported; CRM and calendar integrations are not available.',
    request: { headers, ...requestBody(z.object({
      name: z.string().min(1).max(80), businessName: z.string().min(1).max(120), greeting: z.string().min(1).max(500),
      instructions: z.string().min(1).max(8000), voice, transferNumber: z.null(),
    }).strict()) },
    responses: { 200: jsonResponse(z.object({ agent })), ...failures },
  }, handler);
  register(api, 'post', '/voice/calls', {
    ...common, operationId: 'createVoiceCall', summary: 'Start a browser or text receptionist call',
    description: 'Allows at most three concurrent active calls per account. Calls expire after 15 minutes and support up to 60 transcript turns. Phone calls are created by the telephony provider.',
    request: { headers, ...requestBody(z.object({ channel: z.enum(['browser', 'text']) }).strict()) },
    responses: { 201: jsonResponse(z.object({ call, websocketUrl: z.string().nullable() })), ...errors(400, 401, 403, 409, 429, 503) },
  }, handler);
  register(api, 'get', '/voice/calls', {
    ...common, operationId: 'listVoiceCalls', summary: 'List recent receptionist calls', request: { headers },
    responses: { 200: jsonResponse(z.object({ calls: z.array(call).max(50) })), ...errors(401, 403, 503) },
  }, handler);
  register(api, 'get', '/voice/calls/{callId}', {
    ...common, operationId: 'getVoiceCall', summary: 'Read an owned receptionist call', request: { params: callId, headers },
    responses: { 200: jsonResponse(z.object({ call })), ...errors(400, 401, 403, 404, 503) },
  }, handler);
  register(api, 'post', '/voice/calls/{callId}/end', {
    ...common, operationId: 'endVoiceCall', summary: 'End an active receptionist call', request: { params: callId, headers },
    responses: { 200: jsonResponse(z.object({ call })), ...errors(400, 401, 403, 404, 409, 503) },
  }, handler);
  register(api, 'get', '/voice/calls/{callId}/connect', {
    ...common, operationId: 'connectVoiceCall', summary: 'Upgrade an owned browser call to WebSocket',
    description: 'Requires the account cookie and a trusted Origin. Query parameters are not accepted; authentication and call credentials are never passed in the URL.',
    request: { params: callId, headers: z.object({ Origin: z.string(), Upgrade: z.literal('websocket') }) },
    responses: { 101: { description: 'Browser call WebSocket established.' }, ...errors(400, 401, 403, 404, 409, 426, 429, 503) },
  }, handler);
  register(api, 'post', '/voice/twilio/incoming/{agentId}', {
    operationId: 'receiveVoiceTwilioCall', tags: ['Voice'], summary: 'Receive a signed Twilio incoming call webhook', security: [{ twilioSignature: [] }],
    description: 'Twilio form-encoded webhook authenticated with X-Twilio-Signature. The response is TwiML XML. Calls expire after 15 minutes and support up to 60 transcript turns.',
    request: { params: agentId, headers: z.object({ 'X-Twilio-Signature': z.string() }), body: { required: true, content: { 'application/x-www-form-urlencoded': { schema: z.record(z.string(), z.string()) } } } },
    responses: { 200: { description: 'TwiML response.', content: { 'text/xml': { schema: z.string() } } }, ...errors(400, 403, 404, 429, 503) },
  }, handler);
  register(api, 'get', '/voice/twilio/media/{callId}', {
    operationId: 'connectVoiceTwilioMedia', tags: ['Voice'], summary: 'Upgrade a signed Twilio media stream', security: [{ twilioSignature: [] }],
    description: 'Requires a valid Twilio WebSocket handshake signature and a media start event containing the call media token in customParameters.token. No query token is accepted.',
    request: { params: callId, headers: z.object({ 'X-Twilio-Signature': z.string(), Upgrade: z.literal('websocket') }) },
    responses: { 101: { description: 'Twilio media WebSocket established.' }, ...errors(400, 403, 404, 409, 426, 429, 503) },
  }, handler);
}
