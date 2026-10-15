# Telnyx receptionist setup

The Worker supports Telnyx phone numbers and TeXML application SIP subdomains,
using the same receptionist, prepaid wallet, transcripts and limits as Twilio.
Telnyx handles SIP/PSTN and sends bidirectional PCMU audio to the Worker over
WebSockets. The Worker does not listen on a SIP port.

## 1. Finish provisioning the number

In [Telnyx Mission Control](https://portal.telnyx.com), open **Numbers → My
Numbers**. For the number in the screenshot, use `+19362461010` in configuration.
Wait until **Purchase pending** has cleared and the number is active. Add Telnyx
account credit if needed. The **Required for calls** warning will be resolved by
assigning the application below. Messaging-profile setup is independent of voice.

## 2. Save a Mainbrella receptionist

Sign in to Mainbrella at **https://mainbrella.com/voice/** and save your
receptionist's name, business, greeting, instructions and voice. If the fields
are editable but **Save receptionist** is disabled, the receptionist is already
saved and there are no changes to save. Editing a field enables the button.

Open **Phone connection** and copy the **Incoming call webhook**. The UUID at
the end of `/voice/twilio/incoming/UUID` is your `agent.id`. For Telnyx, use the
same UUID with `/voice/telnyx/incoming/UUID` as shown in step 3.

You can also use **GET /voice/agent** from the signed-in app to read `agent.id`.
To create one directly, run this in the browser console on
`https://mainbrella.com` while signed in:

```js
const response = await fetch('https://api.mainbrella.com/voice/agent', {
  method: 'PUT', credentials: 'include',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({
    name: 'Maya', businessName: 'Your business',
    greeting: 'Thanks for calling. How can I help?',
    instructions: 'Answer using these business details: REPLACE WITH YOUR DETAILS.',
    voice: 'asteria', transferNumber: null,
  }),
});
console.log(response.status, await response.json());
```

PUT replaces the saved settings; use GET to retain an existing agent. Add credits
to this Mainbrella account too: Telnyx credit and Mainbrella prepaid credit are
separate. The agent ID, rather than the user ID, goes in the webhook URL.

## 3. Create a TeXML application

Open **Voice → Programmable Voice → TeXML Applications**. The portal may group
Voice under **Real-Time Communications**. Create an application named
`Mainbrella receptionist` and set:

| Setting | Value |
| --- | --- |
| Active | Enabled |
| Voice method | **POST** |
| TeXML webhook / Voice URL | `https://api.mainbrella.com/voice/telnyx/incoming/YOUR_AGENT_ID` |
| Voice fallback URL | Leave empty initially |
| Status callback URL | Leave empty |
| Call cost webhook events | Leave disabled |

Save the application and copy its numeric **application ID / connection ID**.
Do not paste the webhook into a Voice API JSON application: this integration
returns TeXML. Leave media settings to the returned XML; it selects PCMU, inbound
audio, bidirectional RTP, and disables stream reconnection.

In **Numbers → My Numbers**, edit `+1-936-246-1010`, select this TeXML application
under **Connection/Application**, and save. Alternatively, assign the number
from the application's **Numbers** tab. Verify the number lists the application
and no longer says **Required for calls**. An outbound profile is not required
for this inbound-only flow.

See Telnyx's [TeXML quickstart](https://developers.telnyx.com/docs/voice/programmable-voice/texml-setup)
and [application settings](https://developers.telnyx.com/api-reference/texml-applications/creates-a-texml-application).

## 4. Collect credentials and the account ID

Under **Account Settings → Keys & Credentials**:

- Create a **v2 API key** with access to TeXML call resources. The Worker uses it
  to stop calls and fetch their final duration.
- Copy the **Public Key**, the Base64 Ed25519 public key used to verify Telnyx
  webhooks and WebSocket connections. This is different from the API key.
- Obtain the Telnyx account UUID used as **AccountSid** in TeXML requests. This
  is different from the numeric application/connection ID. If the portal does
  not expose it in account details, make one preliminary call to the assigned
  number and inspect its TeXML request in Telnyx's call/webhook debugging view;
  copy the form's `AccountSid`. That preliminary call will fail until the Worker
  has been configured and deployed. Also confirm `ConnectionId` matches the
  application you just created.

If you cannot find the TeXML request in the portal, configure all the other
variables and leave `TELNYX_ACCOUNT_SID` empty temporarily. Deploy the Worker,
start `npx wrangler tail --config wrangler.jsonc`, and call your number. Once
the incoming request's signature, connection ID, agent and destination have
been verified, the Worker logs:

```text
voice_telnyx_account_sid_required {"AccountSid":"YOUR_ACCOUNT_UUID","ConnectionId":"YOUR_APPLICATION_ID"}
```

Copy that `AccountSid` into `TELNYX_ACCOUNT_SID` and redeploy. Until then the
request returns 503 and does not allocate a receptionist session. If the log
instead says `voice_telnyx_webhook_signature_invalid`, the request could not
be authenticated; check the public key and signature/timestamp headers.

Requests use Telnyx's [Ed25519 webhook signature](https://support.telnyx.com/en/articles/4334722-how-to-leverage-webhooks).
The Worker rejects signatures older than five minutes, incorrect destinations,
and mismatched accounts/applications/agents.

## 5. Configure and deploy the Worker

Keep the existing `VOICE_ENABLED="true"` and
`VOICE_PUBLIC_ORIGIN="https://api.mainbrella.com"` in `wrangler.jsonc`. If hosting
elsewhere, use that HTTPS origin without a trailing slash, and update the portal
webhook accordingly. AI and `RECEPTIONIST_CALL` bindings are required.

From this repository, store the API key securely:

```sh
npx wrangler secret put TELNYX_API_KEY --config wrangler.jsonc
```

Add these values to the existing `vars` object in `wrangler.jsonc` (merge them;
do not replace the other variables):

```jsonc
"TELNYX_PUBLIC_KEY": "YOUR_BASE64_ED25519_PUBLIC_KEY",
"TELNYX_ACCOUNT_SID": "YOUR_TELNYX_ACCOUNT_UUID",
"TELNYX_CONNECTION_ID": "YOUR_NUMERIC_TEXML_APPLICATION_ID",
"TELNYX_AGENT_ID": "YOUR_MAINBRELLA_AGENT_UUID",
"TELNYX_PHONE_NUMBER": "+19362461010",
"TELNYX_PHONE_MICRO_USD_PER_MINUTE": "YOUR_TOTAL_PROVIDER_RATE_IN_MICRO_USD"
```

Use your actual combined Telnyx inbound voice and media-streaming per-minute
cost, before Mainbrella's 50% markup. A hypothetical total of $0.0100/minute is
`10000`; this is an arithmetic example, not a quoted Telnyx tariff. The rate must
be a positive integer up to `1000000`. Twilio rate variables do not enable
Telnyx. Number rental is separate. No rate is assumed by default.

Apply the additive `046_voice_telnyx.sql` migration before deploying this code:

```sh
npm run db:migrate:remote
npm run deploy:api
```

These commands change the remote database and deploy the API. They are operator
steps; implementing the integration does not run them. The migration is backward
compatible with existing Twilio rows. For local development, apply
`npm run db:migrate:local` and set the same values in your local environment;
Telnyx needs a publicly reachable HTTPS/WSS endpoint for callbacks.

## 6. Verify and make the test call

From the signed-in browser console:

```js
const config = await fetch('https://api.mainbrella.com/voice/config', {
  credentials: 'include',
}).then(response => response.json());
console.log(config.telephony.telnyx);
```

Expect `configured: true`, `phoneNumber: "+19362461010"`, and the exact webhook
URL entered in Telnyx. `sipUri` is null until optional SIP setup is complete.
The existing `telephony.phoneNumber`, `sipUri`, and `webhookUrl` fields remain
Twilio fields; use `telephony.telnyx` for this provider.

1. Start `npx wrangler tail --config wrangler.jsonc` for Worker errors.
2. Call **+1 (936) 246-1010** from another phone. You should hear the saved greeting.
3. Ask a question covered by the business instructions, then interrupt a reply
   to check playback interruption. Leave a message, then hang up.
4. Read `GET /voice/calls` in the signed-in account. The call should have
   `channel: "phone"`, `phoneProvider: "telnyx"`, `phoneTransport: "pstn"`, its
   transcript and a completed status. You can also end an active call with
   `POST /voice/calls/{callId}/end` from the authenticated app.
5. Check the usage receipt: transport uses `telnyx-inbound`; STT, LLM and TTS
   remain separately metered. Transport reserves the 15-minute maximum and
   settles rounded-up provider-reported minutes, plus 50%. Provider duration
   may be eventually consistent; the durable call retries until final usage is
   available rather than estimating a charge.

Telnyx documents the [stream protocol and WebSocket signatures](https://developers.telnyx.com/docs/voice/programmable-voice/media-streaming),
[Stream TeXML attributes](https://developers.telnyx.com/docs/voice/programmable-voice/texml-verbs/stream),
and [eventually consistent call reads](https://developers.telnyx.com/api-reference/texml-rest-commands/fetch-a-call).

## 7. Optional: receive SIP calls too

In the TeXML application's inbound settings, configure a unique SIP subdomain,
for example `your-business.sip.telnyx.com`. Choose **Only my connections** for
calls originating from your own Telnyx connections, or **Anyone** if you intend
to accept calls from public SIP endpoints. A public subdomain permits incoming
calls that consume your account's credits. Mainbrella still accepts only the
configured called user and subdomain.

Add these Worker variables and redeploy:

```jsonc
"TELNYX_SIP_URI": "sip:receptionist@your-business.sip.telnyx.com",
"TELNYX_SIP_MICRO_USD_PER_MINUTE": "YOUR_TOTAL_SIP_PROVIDER_RATE_IN_MICRO_USD"
```

Use your SIP client's **direct URI calling** feature to dial that URI over UDP
or TCP on port 5060. Telnyx's TeXML application subdomains do not support TLS;
this restriction is documented in the [inbound application settings](https://developers.telnyx.com/api-reference/texml-applications/creates-a-texml-application).
The subdomain routes the call to the same signed webhook. This is an application
SIP destination, not a SIP registrar to which the Worker registers.

Verify `telephony.telnyx.sipUri` is populated and the call history says
`phoneProvider: "telnyx"`, `phoneTransport: "sip"`. SIP receipts use
`telnyx-sip-inbound` and the independent SIP rate. SIP-only setups can omit
`TELNYX_PHONE_NUMBER` and `TELNYX_PHONE_MICRO_USD_PER_MINUTE`.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Purchase pending | Complete provisioning in Telnyx before testing. |
| Required for calls | Assign the number to the saved, active TeXML application. |
| `configured: false` | Voice enabled, AI/Agent bindings, HTTPS origin, key formats, account UUID, numeric connection ID, saved agent ID, destination and its positive rate. |
| Incoming webhook 403 | Public key, fresh signature/timestamp, AccountSid, ConnectionId, agent ID and exact destination. |
| Incoming webhook 503 | Missing/invalid provider configuration, disabled voice, or backend failure. |
| Spoken unavailable message | Mainbrella credits/spending limit, call limits, agent existence or initialization failure. |
| Greeting missing / stream closes | TeXML must use POST; check signed WSS handshake, token expiry, PCMU 8000 Hz mono and stream errors. Do not put a login challenge in front of the provider routes. |
| Receipt still pending | Verify API key permissions and account UUID. Final duration may take time to appear in Telnyx's API. |
| SIP rejected | Exact user and subdomain, permitted source connection and UDP/TCP; TLS and foreign subdomains are rejected. |

Both providers can run together, mapped to the same or different saved agents.
Calls retain the existing three-concurrent-call, 100-per-rolling-day, 15-minute
and 60-turn limits. Outbound calls and transfers are not implemented.
