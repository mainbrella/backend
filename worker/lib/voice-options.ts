import { z } from 'zod';

// Speech support is the intersection of transcription, reply generation and TTS.
// https://developers.cloudflare.com/changelog/post/2026-03-06-realtimekit-multilingual-transcription/
export const voiceLanguage = z.enum(['en', 'es', 'fr', 'de', 'hi', 'ru', 'pt', 'ja', 'it', 'nl']);
export const voiceModel = z.enum(['aura-1', 'aura-2', 'aura-2-gateway', 'sonic-3.6']);
export type VoiceLanguage = z.infer<typeof voiceLanguage>;
export type VoiceModel = z.infer<typeof voiceModel>;
export type SpeechSelection = { model?: VoiceModel; language?: VoiceLanguage; voice: string };
export const VOICE_LANGUAGES = [
  { code: 'en', name: 'English' }, { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' }, { code: 'de', name: 'German' },
  { code: 'hi', name: 'Hindi' }, { code: 'ru', name: 'Russian' },
  { code: 'pt', name: 'Portuguese' }, { code: 'ja', name: 'Japanese' },
  { code: 'it', name: 'Italian' }, { code: 'nl', name: 'Dutch' },
] as const;
const names = (values: string[]) => values.map(id => ({ id, name: id[0].toUpperCase() + id.slice(1) }));
const english = names(['asteria', 'luna', 'athena', 'thalia', 'andromeda', 'helena', 'apollo', 'arcas', 'aries']);
const spanish = names(['celeste', 'estrella', 'nestor', 'sirio', 'carina', 'alvaro', 'diana', 'aquila', 'selena', 'javier']);
const auraLanguages = [
  { code: 'en', voices: english }, { code: 'es', voices: spanish },
  { code: 'fr', voices: names(['agathe', 'hector']) },
  { code: 'de', voices: names(['julius', 'viktoria']) },
  { code: 'it', voices: names(['livia', 'dionisio']) },
  { code: 'ja', voices: names(['fujin', 'izanami']) },
  { code: 'nl', voices: names(['rhea', 'sander', 'beatrix']) },
];
// Curated multilingual voices from Cartesia's Sonic 3.6 documentation.
const sonicVoices = [
  { id: 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4', name: 'Skylar' },
  { id: '47c38ca4-5f35-497b-b1a3-415245fb35e1', name: 'Daniel' },
];
export const VOICE_SPEECH_MODELS = [
  { id: 'aura-1', name: 'Aura-1', languages: [{ code: 'en', voices: names(['asteria', 'luna', 'athena']) }] },
  { id: 'aura-2', name: 'Aura-2 · Cloudflare', languages: auraLanguages.slice(0, 2) },
  { id: 'aura-2-gateway', name: 'Aura-2 · Deepgram', languages: auraLanguages },
  { id: 'sonic-3.6', name: 'Sonic 3.6 · Cartesia', languages: VOICE_LANGUAGES.map(({ code }) => ({ code, voices: sonicVoices })) },
] as const;

export function validSpeechSelection(config: SpeechSelection): boolean {
  return Boolean(VOICE_SPEECH_MODELS.find(model => model.id === (config.model ?? 'aura-1'))
    ?.languages.find(language => language.code === (config.language ?? 'en'))?.voices.some(voice => voice.id === config.voice));
}

function gatewayConfigured(env: Env): boolean {
  return /^[a-f0-9]{32}$/i.test(env.VOICE_AI_GATEWAY_ACCOUNT_ID || '')
    && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(env.VOICE_AI_GATEWAY_ID || '');
}
export function speechRate(env: Env, model: VoiceModel): number {
  if (model === 'aura-1') return 15;
  if (model === 'aura-2') return 30;
  const rate = Number(model === 'aura-2-gateway' ? env.DEEPGRAM_TTS_MICRO_USD_PER_CHARACTER : env.CARTESIA_TTS_MICRO_USD_PER_CHARACTER);
  if (!Number.isSafeInteger(rate) || rate <= 0 || rate > 1000) throw new Error('voice_model_unavailable');
  return rate;
}
export function speechModelAvailable(env: Env, model: VoiceModel): boolean {
  if (model === 'aura-1' || model === 'aura-2') return true;
  if (!gatewayConfigured(env) || !(model === 'aura-2-gateway' ? env.DEEPGRAM_API_KEY : env.CARTESIA_API_KEY)) return false;
  try { speechRate(env, model); return true; } catch { return false; }
}
export function speechOptions(env: Env) {
  return { languages: VOICE_LANGUAGES, models: VOICE_SPEECH_MODELS.map(model => {
    const available = speechModelAvailable(env, model.id);
    return { ...model, available, unavailableReason: available ? null : 'Not configured' };
  }) };
}
export function resolveVoiceModels(config: Pick<SpeechSelection, 'model' | 'language'>) {
  const model = config.model ?? 'aura-1', language = config.language ?? 'en';
  return {
    stt: language === 'en' ? '@cf/deepgram/flux' : '@cf/deepgram/nova-3',
    llm: language === 'en' ? '@cf/meta/llama-3.3-70b-instruct-fp8-fast' : '@cf/google/gemma-4-26b-a4b-it',
    tts: model === 'aura-1' ? '@cf/deepgram/aura-1' : model === 'aura-2' ? `@cf/deepgram/aura-2-${language}`
      : model === 'aura-2-gateway' ? `deepgram/aura-2-${language}` : 'cartesia/sonic-3.6',
  };
}
