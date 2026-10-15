import { validateRequest } from 'twilio/lib/webhooks/webhooks.js';

/** Validate against the public, configured URL; never trust forwarded host headers. */
export function validTwilioSignature(token: string, signature: string | null, url: string, fields: URLSearchParams | null = null): boolean {
  if (!signature || signature.length>128) return false;
  const params: Record<string,string|string[]> = {};
  for (const key of new Set(fields?.keys())) {
    const values = fields!.getAll(key);
    params[key] = values.length===1 ? values[0] : values;
  }
  try { return validateRequest(token,signature,url,params); } catch { return false; }
}
export function xmlEscape(value: string): string {
  return value.replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[character]!));
}
export function streamTwiml(mediaUrl: string, token: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${xmlEscape(mediaUrl)}"><Parameter name="token" value="${xmlEscape(token)}" /></Stream></Connect><Hangup /></Response>`;
}
function decodeMuLaw(value: number): number {
  const inverse = ~value & 255;
  const sample = (((inverse&15)<<3)+132) << ((inverse>>4)&7);
  return (inverse&128) ? 132-sample : sample-132;
}
function encodeMuLaw(sample: number): number {
  const sign = sample<0 ? 128 : 0;
  sample = Math.min(32635,Math.abs(sample))+132;
  let exponent=7;
  for (let mask=16384; exponent>0 && !(sample&mask); mask>>=1) exponent--;
  return ~(sign|(exponent<<4)|((sample>>(exponent+3))&15))&255;
}
/** Twilio's 8kHz mono G.711 μ-law → little-endian 16kHz PCM expected by Flux. */
export function twilioToPCM(payload: string): ArrayBuffer {
  const binary = atob(payload);
  if (binary.length>8000) throw new Error('audio_frame_too_large');
  const output = new ArrayBuffer(binary.length*4);
  const view = new DataView(output);
  for (let i=0;i<binary.length;i++) {
    const sample=decodeMuLaw(binary.charCodeAt(i));
    view.setInt16(i*4,sample,true);
    view.setInt16(i*4+2,sample,true);
  }
  return output;
}
/** Native Aura PCM16 at 16kHz → 8kHz μ-law, with a two-sample box low-pass. */
export function pcmToTwilio(audio: ArrayBuffer): string[] {
  if (audio.byteLength%2) throw new Error('invalid_pcm_audio');
  const view = new DataView(audio);
  const frames: string[] = [];
  let frame='';
  for (let offset=0;offset<audio.byteLength;offset+=4) {
    const first=view.getInt16(offset,true);
    const second=offset+2<audio.byteLength ? view.getInt16(offset+2,true) : first;
    frame+=String.fromCharCode(encodeMuLaw((first+second)/2));
    if (frame.length===160) { frames.push(btoa(frame)); frame=''; }
  }
  if (frame) frames.push(btoa(frame));
  return frames;
}

/** End the provider call and use its reported duration for billing, even on a retry. */
export async function hangupTwilioCall(env: Env, callSid: string, fetcher: typeof fetch = fetch): Promise<{durationSeconds:number;billableMinutes:number}> {
  if (!/^CA[a-f0-9]{32}$/i.test(callSid) || !/^AC[a-f0-9]{32}$/i.test(env.TWILIO_ACCOUNT_SID || '') || !env.TWILIO_AUTH_TOKEN)
    throw new Error('voice_telephony_unavailable');
  const url=`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Calls/${callSid}.json`;
  const headers={authorization:`Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}`};
  const response=await fetcher(url,{
    method:'POST',headers:{...headers,'content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({Status:'completed'}),signal:AbortSignal.timeout(5000),
  });
  const readUsage=(result:{sid?:string;status?:string;duration?:string|null})=>{
    if(result.sid!==callSid)return null;
    if(['canceled','failed','busy','no-answer'].includes(result.status || ''))return {durationSeconds:0,billableMinutes:0};
    if(result.status!=='completed' || !/^\d+$/.test(result.duration || ''))return null;
    const durationSeconds=Number(result.duration);
    return Number.isSafeInteger(durationSeconds)?{durationSeconds,billableMinutes:Math.max(1,Math.ceil(durationSeconds/60))}:null;
  };
  if(response.ok) {
    const usage=readUsage(await response.json());
    if(usage)return usage;
  } else if(![400,404,409].includes(response.status))throw new Error('voice_telephony_stop_failed');
  // A previous completion may have succeeded before its acknowledgement was
  // lost. Confirm terminal state and duration; never estimate a financial charge.
  const observed=await fetcher(url,{headers,signal:AbortSignal.timeout(5000)});
  if(!observed.ok)throw new Error('voice_telephony_stop_failed');
  const usage=readUsage(await observed.json());
  if(!usage)throw new Error('voice_telephony_usage_pending');
  return usage;
}
