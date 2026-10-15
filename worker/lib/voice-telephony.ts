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
