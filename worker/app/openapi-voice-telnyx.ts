import { z } from 'zod';
import { errors, register, type LegacyHandler, type OpenAPIApi } from './openapi-shared';

const signatureHeaders = {
  'telnyx-signature-ed25519': z.string().describe('Base64 Ed25519 signature.'),
  'telnyx-timestamp': z.string().describe('Unix seconds, within five minutes of server time.'),
};
export function registerVoiceTelnyxRoutes(api: OpenAPIApi, handler: LegacyHandler): void {
  register(api,'post','/voice/telnyx/incoming/{agentId}',{
    tags:['Voice'],operationId:'receiveVoiceTelnyxCall',summary:'Receive a signed Telnyx TeXML call',security:[{telnyxSignature:[]}],
    description:'Verifies Ed25519 over timestamp|raw-body and matches TELNYX_ACCOUNT_SID, TELNYX_CONNECTION_ID, TELNYX_AGENT_ID and the destination. To must match TELNYX_PHONE_NUMBER for PSTN, or ToSipUri must match TELNYX_SIP_URI for application-subdomain SIP. Each destination requires its own TELNYX_PHONE_MICRO_USD_PER_MINUTE or TELNYX_SIP_MICRO_USD_PER_MINUTE rate. Calls use the existing prepaid wallet, three-call concurrency limit, 100-call daily limit, 15-minute duration limit and 60-turn limit. Duplicate deliveries cannot allocate another session. Returns TeXML Connect/Stream with PCMU bidirectional RTP and a single-use media token; unavailable or unfunded calls receive a hangup response.',
    request:{params:z.object({agentId:z.uuid()}),headers:z.object(signatureHeaders),body:{required:true,content:{'application/x-www-form-urlencoded':{schema:z.object({
      AccountSid:z.string(),ConnectionId:z.string(),CallSid:z.string(),To:z.string(),ToSipUri:z.string().optional(),From:z.string().optional(),
    }).catchall(z.string())}}}},
    responses:{200:{description:'TeXML call instructions.',content:{'application/xml':{schema:z.string()}}},...errors(400,403,404,405,503)},
  },handler);
  register(api,'get','/voice/telnyx/media/{callId}',{
    tags:['Voice'],operationId:'connectVoiceTelnyxMedia',summary:'Upgrade a signed Telnyx media stream',security:[{telnyxSignature:[]}],
    description:'Verifies Ed25519 over timestamp|configured-wss-url. Query parameters are rejected. A start event must supply the single-use 60-second token through custom parameters, the expected account/call identity and mono PCMU at 8000 Hz. Only active Telnyx calls for the configured agent can connect. Audio is converted to/from the receptionist PCM format; clear messages interrupt playback.',
    request:{params:z.object({callId:z.uuid()}),headers:z.object({...signatureHeaders,Upgrade:z.literal('websocket')})},
    responses:{101:{description:'Telnyx media WebSocket established.'},...errors(403,404,405,426,503)},
  },handler);
}
