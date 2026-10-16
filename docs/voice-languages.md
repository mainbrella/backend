# Receptionist models and languages

The receptionist settings in `web/voice/app/` select a speech model, language and
matching voice. `GET /voice/config` provides the capability catalog and marks
external providers unavailable until their credentials and rates are configured.
`PUT /voice/agent` validates the combination. Each call freezes the saved settings;
editing a receptionist affects new calls.

| Model | Languages from the ten-language catalog | Setup |
| --- | --- | --- |
| Aura-1 | English (1/10) | Existing Workers AI binding |
| Aura-2, Cloudflare | English, Spanish (2/10) | Existing Workers AI binding |
| Aura-2, Deepgram | English, Spanish, French, German, Japanese, Italian, Dutch (7/10) | Deepgram through AI Gateway |
| Sonic 3.6, Cartesia | All ten: English, Spanish, French, German, Hindi, Russian, Portuguese, Japanese, Italian, Dutch | Cartesia through AI Gateway |

MeloTTS is excluded because its Cloudflare language support has reported failures.
The language counts describe provider capabilities and implemented routing;
simulated-provider tests do not certify pronunciation or production latency.

English retains Flux transcription and the existing Llama model. Other languages
use streaming Nova-3 with an explicit language and Gemma 4 for multilingual replies
with thinking disabled. Acknowledgments use the selected language. Greetings are
spoken verbatim: write the greeting in the selected language.

The Nova adapter forwards upstream speech-start events to preserve interruptions
for phone callers, including transports without client-side voice detection.

All speech providers return mono PCM16 at 16 kHz for browser, Twilio and Telnyx
transports. Cartesia uses API version `2026-08-14` and the fixed
`sonic-3.6-2026-08-27` snapshot. Curated voices are listed in
`worker/lib/voice-options.ts`.

## Deployment

Apply migration `048_voice_languages.sql` before deploying the API, then deploy
the web app. Existing agents and historical call snapshots retain Aura-1/English.

To enable either external provider, configure these Worker variables:

- `VOICE_AI_GATEWAY_ACCOUNT_ID`: the 32-character Cloudflare account ID.
- `VOICE_AI_GATEWAY_ID`: the existing AI Gateway name.

For an authenticated gateway, set the `VOICE_AI_GATEWAY_TOKEN` Worker secret.
Provider API keys are also Worker secrets:

- Deepgram: `DEEPGRAM_API_KEY`, plus the variable
  `DEEPGRAM_TTS_MICRO_USD_PER_CHARACTER` (for example, `30` for
  $0.030 per 1,000 characters; verify the account's contracted rate).
- Cartesia: `CARTESIA_API_KEY`, plus the variable
  `CARTESIA_TTS_MICRO_USD_PER_CHARACTER`. Set this to the actual rate for the
  account's plan and selected voices; do not assume subscription credits are free.

Rates must be positive integer micro-USD per Unicode character, at most 1,000.
Missing or invalid prices disable the provider. Requests never expose credentials
to the browser. External speech bypasses gateway caching. Provider costs are
reserved before dispatch and charged with the existing 50% markup; failed or
aborted requests with uncertain usage retain their holds and are not retried.

Before enabling a provider for customers, test greetings, names, numbers,
interruptions and turn timing in each target language over a real phone call.

## References

- [Cloudflare Nova-3 languages](https://developers.cloudflare.com/changelog/post/2026-03-06-realtimekit-multilingual-transcription/)
- [Cloudflare Aura-2 Spanish](https://developers.cloudflare.com/workers-ai/models/aura-2-es/)
- [Gemma 4 multilingual support](https://ai.google.dev/gemma/docs/core/model_card_4)
- [Deepgram Aura voices and languages](https://developers.deepgram.com/docs/tts-models)
- [Deepgram AI Gateway integration](https://developers.cloudflare.com/ai-gateway/usage/providers/deepgram/)
- [Cartesia AI Gateway integration](https://developers.cloudflare.com/ai-gateway/usage/providers/cartesia/)
- [Cartesia Sonic languages](https://docs.cartesia.ai/build-with-cartesia/tts-models/latest)
- [Cartesia audio API](https://docs.cartesia.ai/api-reference/tts/bytes)
- [MeloTTS language issue](https://github.com/cloudflare/cloudflare-docs/issues/23308)
