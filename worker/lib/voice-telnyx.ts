import { phoneRate } from './voice-billing';
import { publicVoiceOrigin, voiceEnabled, type VoicePhoneTransport } from './voice';
import { pcmToTwilio, xmlEscape } from './voice-telephony';

/** Telnyx application subdomains accept SIP over UDP/TCP, not TLS. */
export function telnyxSipUri(value: string | null | undefined): string | null {
  if (!value || value.length > 320 || value.trim() !== value) return null;
  const match=/^(?:sip:)?([a-z0-9_.!~*'()+%\-]+)@([a-z0-9-]+\.sip\.telnyx\.com)(?::5060)?(?:;transport=(?:udp|tcp))?$/i.exec(value);
  return match ? `sip:${match[1]}@${match[2].toLowerCase()}` : null;
}
export const validTelnyxCallId = (value: string | null): value is string => Boolean(value &&
  (/^v[23]:[a-z0-9_=-]{1,512}$/i.test(value) || /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)));

// Older TeXML webhooks use a UUID CallSid while media/REST use the opaque
// call-control ID. A legacy stream is bound by its account and one-time token;
// REST responses are bound by the requested resource and returned account.
export const telnyxCallIdMatches = (expected: string, actual: string | null): boolean =>
  expected===actual || (!/^v[23]:/i.test(expected) && validTelnyxCallId(actual));

export function telnyxConfigured(env: Env, agentId: string | null, transport?: VoicePhoneTransport): boolean {
  if (!voiceEnabled(env) || !publicVoiceOrigin(env) || !env.TELNYX_API_KEY ||
    !/^[a-z0-9+/]{43}=$/i.test(env.TELNYX_PUBLIC_KEY || '') ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(env.TELNYX_ACCOUNT_SID || '') ||
    !/^\d{1,30}$/.test(env.TELNYX_CONNECTION_ID || '') || !agentId || env.TELNYX_AGENT_ID !== agentId) return false;
  return (transport ? [transport] : ['pstn','sip'] as const).some(kind=>{
    try { phoneRate(env,kind,'telnyx'); } catch { return false; }
    return kind === 'sip' ? Boolean(telnyxSipUri(env.TELNYX_SIP_URI)) : /^\+[1-9]\d{7,14}$/.test(env.TELNYX_PHONE_NUMBER || '');
  });
}

/** Verify the exact raw body, or the exact WSS stream URL on an upgrade. */
export async function validTelnyxSignature(publicKey: string, headers: Headers, payload: string): Promise<boolean> {
  const timestamp=headers.get('telnyx-timestamp'), signature=headers.get('telnyx-signature-ed25519');
  if (!timestamp || !/^\d{10}$/.test(timestamp) || Math.abs(Date.now()/1000-Number(timestamp))>300 ||
    !signature || !/^[a-z0-9+/]{86}==$/i.test(signature) || !/^[a-z0-9+/]{43}=$/i.test(publicKey)) return false;
  try {
    const bytes=(base64:string)=>Uint8Array.from(atob(base64),character=>character.charCodeAt(0));
    const key=await crypto.subtle.importKey('raw',bytes(publicKey),{name:'Ed25519'},false,['verify']);
    return await crypto.subtle.verify('Ed25519',key,bytes(signature),new TextEncoder().encode(`${timestamp}|${payload}`));
  } catch { return false; }
}

export function streamTexml(mediaUrl: string, token: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${xmlEscape(mediaUrl)}" track="inbound_track" codec="PCMU" bidirectionalMode="rtp" bidirectionalCodec="PCMU" bidirectionalSamplingRate="8000" enableReconnect="false"><Parameter name="token" value="${xmlEscape(token)}" /></Stream></Connect><Hangup /></Response>`;
}

/** Telnyx RTP chunks must contain at least 20 ms; pad a final partial frame. */
export function pcmToTelnyx(audio: ArrayBuffer): string[] {
  return pcmToTwilio(audio).map(payload=>btoa(atob(payload).padEnd(160,'\xff')));
}

/** Complete TeXML calls and settle only provider-reported terminal usage. */
export async function hangupTelnyxCall(env: Env, callId: string, fetcher: typeof fetch = fetch): Promise<{durationSeconds:number;billableMinutes:number}> {
  if (!validTelnyxCallId(callId) || !env.TELNYX_ACCOUNT_SID || !env.TELNYX_API_KEY) throw new Error('voice_telephony_unavailable');
  const url=`https://api.telnyx.com/v2/texml/Accounts/${encodeURIComponent(env.TELNYX_ACCOUNT_SID)}/Calls/${encodeURIComponent(callId)}`;
  const headers={authorization:`Bearer ${env.TELNYX_API_KEY}`};
  const response=await fetcher(url,{method:'POST',headers:{...headers,'content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({Status:'completed'}),signal:AbortSignal.timeout(5000)});
  if (!response.ok && ![400,404,409,422].includes(response.status)) throw new Error('voice_telephony_stop_failed');
  // TeXML reads are eventually consistent. An update acknowledgment alone is
  // not evidence of final duration; the durable call retries pending usage.
  const observed=await fetcher(url,{headers,signal:AbortSignal.timeout(5000)});
  if (!observed.ok) throw new Error('voice_telephony_usage_pending');
  const result=await observed.json() as {sid?:string;account_sid?:string;status?:string;duration?:string|null;end_time?:string|null};
  if (!telnyxCallIdMatches(callId,result.sid || null) || result.account_sid!==env.TELNYX_ACCOUNT_SID) throw new Error('voice_telephony_usage_pending');
  if (['canceled','failed','busy','no-answer'].includes(result.status || '')) return {durationSeconds:0,billableMinutes:0};
  if (result.status!=='completed' || !result.end_time || !/^\d+$/.test(result.duration || '')) throw new Error('voice_telephony_usage_pending');
  const durationSeconds=Number(result.duration);
  if (!Number.isSafeInteger(durationSeconds)) throw new Error('voice_telephony_usage_pending');
  return {durationSeconds,billableMinutes:Math.max(1,Math.ceil(durationSeconds/60))};
}
