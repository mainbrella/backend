# Voice

Voice owns the receptionist product: browser/text calls, Twilio and Telnyx
integration, speech options, number search, call transcripts, and metered usage.
See the root [product boundaries](../../README.md#product-boundaries) for the
destination of the extraction.

| Source | Ownership |
| --- | --- |
| `worker/app/` | Voice request handlers, OpenAPI schemas, and API tests |
| `worker/lib/` | Voice resources, speech, telephony, provider rates, and usage receipts |
| `worker/durable-objects/` | Receptionist conversation runtime and Workers integration tests |
| `worker/fixtures/` | Deterministic AI and shared-wallet fixture for runtime tests |
| `web/` | Browser behavior, API client, transport, number search, and browser tests |

Backend composes the `@canopy/voice/routes`, `/openapi`, `/billing`, and `/call`
exports into its existing API Worker. Keep the call export separate: importing
HTTP routes in Node tests must not load the Cloudflare Durable Object runtime.
Web's small `src/voice.ts` entry supplies the API origin and shared session reader
to `@canopy/voice/web`; `src/voice-landing.ts` loads the landing behavior.

This workspace is a source boundary. Run the existing backend and web development
commands from the repository root. Voice's URLs, worker bindings, cron, secrets,
and ordered database migrations remain owned by those deployment hosts. Voice's
HTML and styles remain in web for this first milestone. Deployment setup is still
described in the [backend Voice guide](../backend/README.md#ai-receptionist).

```sh
npm run test:api
npm run type-check
npm run check:boundaries
```

Backend API checks run Voice's worker tests; web checks run its browser tests.
Runtime tests exercise real Workers WebSockets, persistence, provider signature
validation, and the shared wallet with deterministic AI responses. They do not
make paid inference or telephony calls.
