import { resolveVoiceModels, speechModelAvailable, type SpeechSelection } from './voice-options';

/** All transports consume mono 16 kHz signed little-endian PCM16. */
export async function synthesizeVoiceSpeech(env: Env, config: SpeechSelection, text: string, signal?: AbortSignal,
  fetcher: typeof fetch = fetch): Promise<ArrayBuffer> {
  const model = config.model ?? 'aura-1', language = config.language ?? 'en';
  if (!speechModelAvailable(env, model)) throw new Error('voice_model_unavailable');
  const options = { encoding: 'linear16', container: 'none', sample_rate: 16000 };
  let response: Response;
  if (model === 'aura-1' || model === 'aura-2') {
    response = await env.AI.run(resolveVoiceModels(config).tts as Parameters<Ai['run']>[0], {
      text, speaker: config.voice, ...options,
    }, { returnRawResponse: true, signal }) as unknown as Response;
  } else {
    const base = `https://gateway.ai.cloudflare.com/v1/${env.VOICE_AI_GATEWAY_ACCOUNT_ID}/${env.VOICE_AI_GATEWAY_ID}`;
    const headers: Record<string, string> = { 'content-type': 'application/json', 'cf-aig-skip-cache': 'true' };
    if (env.VOICE_AI_GATEWAY_TOKEN) headers['cf-aig-authorization'] = `Bearer ${env.VOICE_AI_GATEWAY_TOKEN}`;
    let url: string, body: Record<string, unknown>;
    if (model === 'aura-2-gateway') {
      const query = new URLSearchParams({ model: `aura-2-${config.voice}-${language}`, ...Object.fromEntries(Object.entries(options).map(([key, value]) => [key, String(value)])) });
      url = `${base}/deepgram/v1/speak?${query}`;
      headers.authorization = `Token ${env.DEEPGRAM_API_KEY}`;
      body = { text };
    } else {
      url = `${base}/cartesia/tts/bytes`;
      headers.authorization = `Bearer ${env.CARTESIA_API_KEY}`;
      headers['Cartesia-Version'] = '2026-08-14';
      body = { model_id: 'sonic-3.6-2026-08-27', transcript: text, language, voice: config.voice,
        output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 16000 } };
    }
    response = await fetcher(url, { method: 'POST', headers, body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
  }
  if (!response.ok || /json|text\//i.test(response.headers.get('content-type') || '')) throw new Error('tts_failed');
  const audio = await response.arrayBuffer();
  if (!audio.byteLength || audio.byteLength % 2) throw new Error('tts_invalid_pcm');
  // Validate bytes instead of an audio MIME type, which providers may default
  // independently of the explicitly requested raw PCM encoding.
  const prefix = new TextDecoder().decode(audio.slice(0, 12));
  if ((prefix.startsWith('RIFF') && prefix.slice(8,12)==='WAVE') || /^(ID3|OggS|fLaC)/.test(prefix)) throw new Error('tts_invalid_pcm');
  return audio;
}
