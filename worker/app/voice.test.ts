import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getExpectedTwilioSignature } from 'twilio/lib/webhooks/webhooks.js';
import { handleRequest } from './router';
import { paidContainerFixture, SESSION_ONE, SESSION_TWO, USER_ONE, USER_TWO } from './paid-container-test-helpers';
import { voiceBillingFixture } from './voice-billing-test-helpers';
import { hangupTwilioCall, pcmToTwilio, twilioToPCM } from '../lib/voice-telephony';
import { publicCall, twilioSipUri, type VoiceCallRow } from '../lib/voice';
import { hangupTelnyxCall, pcmToTelnyx, telnyxCallIdMatches, telnyxSipUri, validTelnyxSignature } from '../lib/voice-telnyx';
import { TELNYX_TEST_ACCOUNT, TELNYX_TEST_BINDINGS, TELNYX_TEST_CALL, TELNYX_TEST_CONNECTION, TELNYX_TEST_SIP, telnyxTestSignature } from './voice-telnyx-test-helpers';

const API = 'https://api.mainbrella.com';
const ORIGIN = 'https://mainbrella.com';
const PUBLIC_ORIGIN = 'https://api.mainbrella.com';
const AUTH_TOKEN = 'twilio-auth-token-for-tests';
const ACCOUNT_SID = `AC${'a'.repeat(32)}`;
const PHONE_NUMBER = '+15551234567';
const CALL_SID = `CA${'b'.repeat(32)}`;
const SIP_URI = 'sip:receptionist@mainbrella.sip.twilio.com';

type VoiceMockCall = { name: string; request: Request };
function upgradeResponse(): Response {
  return Object.defineProperties(new Response(null), { status: { value: 101 }, webSocket: { value: {} } });
}

async function fixture(t: TestContext) {
  const f = await paidContainerFixture(t);
  t.after(() => f.close());
  f.sqlite.exec(readFileSync(fileURLToPath(new URL('../../migrations/043_voice_receptionist.sql', import.meta.url)), 'utf8'));
  f.sqlite.exec(readFileSync(fileURLToPath(new URL('../../migrations/045_voice_sip.sql', import.meta.url)), 'utf8'));
  f.sqlite.exec(readFileSync(fileURLToPath(new URL('../../migrations/046_voice_telnyx.sql', import.meta.url)), 'utf8'));
  f.sqlite.exec(readFileSync(fileURLToPath(new URL('../../migrations/047_voice_logic.sql', import.meta.url)), 'utf8'));
  const billing=await voiceBillingFixture(f.env,f.sqlite,USER_ONE);
  f.env.VOICE_PHONE_MICRO_USD_PER_MINUTE='12500';
  f.env.AI = {} as Ai;
  f.env.VOICE_ENABLED = 'true';
  f.env.VOICE_PUBLIC_ORIGIN = PUBLIC_ORIGIN;
  f.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
  f.env.TWILIO_ACCOUNT_SID = ACCOUNT_SID;
  f.env.TWILIO_PHONE_NUMBER = PHONE_NUMBER;
  const calls: VoiceMockCall[] = [];
  f.env.RECEPTIONIST_CALL = {
    idFromName(name: string) { return name; },
    get(name: string) { return { async fetch(request: Request) {
      calls.push({ name, request });
      const path = new URL(request.url).pathname;
      if (path === '/end' || path === '/billing-stop') {
        await f.env.DB.prepare("UPDATE voice_calls SET status='completed',ended_at=? WHERE id=? AND status='active'")
          .bind(new Date().toISOString(), name).run();
      }
      if (path === '/connect') return upgradeResponse();
      return Response.json({ ok: true });
    } }; },
  } as unknown as Env['RECEPTIONIST_CALL'];
  return { ...f, calls, billing };
}

function request(path: string, method = 'GET', body?: unknown, options: { session?: string | null; origin?: string | null; headers?: Record<string, string> } = {}) {
  const { session = SESSION_ONE, origin = ORIGIN, headers = {} } = options;
  return new Request(`${API}${path}`, {
    method,
    headers: {
      ...(origin === null ? {} : { Origin: origin }),
      ...(session === null ? {} : { Cookie: `mainbrella_session=${session}` }),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
}

const input = (overrides: Record<string, unknown> = {}) => ({
  name: 'Aster', businessName: 'North Star Dental', greeting: 'Thanks for calling North Star Dental.',
  instructions: 'Answer questions using these business details.', voice: 'asteria', transferNumber: null, ...overrides,
});

async function saveAgent(f: Awaited<ReturnType<typeof fixture>>, session = SESSION_ONE, overrides: Record<string, unknown> = {}) {
  const response = await handleRequest(request('/voice/agent', 'PUT', input(overrides), { session }), f.env);
  assert.equal(response.status, 200);
  return (await response.json() as { agent: { id: string; name: string; voiceLogic: string } }).agent;
}

function signedForm(path: string, fields: Record<string, string>, url = `${PUBLIC_ORIGIN}${path}`) {
  const signature = getExpectedTwilioSignature(AUTH_TOKEN, url, fields);
  return new Request(`${API}${path}`, { method: 'POST', headers: {
    'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': signature,
  }, body: new URLSearchParams(fields).toString() });
}

test('voice customer routes enforce session, trusted-origin CORS and mutation CSRF rules', async t => {
  const f = await fixture(t);
  assert.equal((await handleRequest(request('/voice/agent', 'GET', undefined, { session: null }), f.env)).status, 401);
  assert.equal((await handleRequest(request('/voice/agent', 'GET', undefined, { origin: 'https://attacker.example' }), f.env)).status, 403);
  for (const method of ['PUT', 'POST']) {
    assert.equal((await handleRequest(request('/voice/agent', method, input(), { origin: null }), f.env)).status, 403);
  }
  assert.equal((await handleRequest(request('/voice/agent', 'GET', undefined, { origin: null }), f.env)).status, 200);
  const preflight = await handleRequest(new Request(`${API}/voice/agent`, { method: 'OPTIONS', headers: { Origin: ORIGIN } }), f.env);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), ORIGIN);
});

test('agent save, read, account isolation, stable ID and strict field limits', async t => {
  const f = await fixture(t);
  assert.deepEqual(await (await handleRequest(request('/voice/agent'), f.env)).json(), { agent: null });
  const created = await saveAgent(f);
  assert.equal(created.name, 'Aster');
  assert.equal(created.voiceLogic, 'original_no_reply');
  const other = await handleRequest(request('/voice/agent', 'GET', undefined, { session: SESSION_TWO }), f.env);
  assert.deepEqual(await other.json(), { agent: null });
  const updated = await saveAgent(f, SESSION_ONE, { name: 'Luna', voice: 'luna', voiceLogic: 'reply_right_away' });
  assert.equal(updated.id, created.id);
  assert.equal(updated.voiceLogic, 'reply_right_away');
  assert.equal((await saveAgent(f, SESSION_TWO)).id === created.id, false);
  const saved = f.sqlite.prepare('SELECT id,voice,voice_logic FROM voice_agents WHERE user_id=?').get(USER_ONE) as { id: string; voice: string; voice_logic: string };
  assert.equal(saved.id, created.id);
  assert.equal(saved.voice, 'luna');
  assert.equal(saved.voice_logic, 'reply_right_away');
  for (const bad of [
    input({ transferNumber: '+15550001111' }), input({ voice: 'unsupported' }), input({ voiceLogic: 'unsupported' }), input({ name: 'x'.repeat(81) }),
    input({ businessName: 'x'.repeat(121) }), input({ greeting: 'x'.repeat(501) }), input({ instructions: 'x'.repeat(8001) }),
    { ...input(), extra: true }, input({ name: '' }),
  ]) {
    assert.equal((await handleRequest(request('/voice/agent', 'PUT', bad), f.env)).status, 400);
  }
});

test('voice logic migration defaults existing agent rows', async t => {
  const f = await paidContainerFixture(t);
  t.after(() => f.close());
  for (const migration of ['043_voice_receptionist', '045_voice_sip', '046_voice_telnyx']) {
    f.sqlite.exec(readFileSync(fileURLToPath(new URL(`../../migrations/${migration}.sql`, import.meta.url)), 'utf8'));
  }
  f.sqlite.prepare(`INSERT INTO voice_agents(id,user_id,name,business_name,greeting,instructions,voice,updated_at)
    VALUES(?,?,?,?,?,?,?,?)`).run(crypto.randomUUID(), USER_ONE, 'Legacy', 'Business', 'Hello', 'Instructions', 'asteria', new Date().toISOString());
  f.sqlite.exec(readFileSync(fileURLToPath(new URL('../../migrations/047_voice_logic.sql', import.meta.url)), 'utf8'));
  const existing = f.sqlite.prepare('SELECT voice_logic FROM voice_agents WHERE user_id=?').get(USER_ONE) as { voice_logic: string };
  assert.equal(existing.voice_logic, 'original_no_reply');
});

test('config reflects enablement and telephony is mapped only to its configured agent', async t => {
  const f = await fixture(t);
  const before = await (await handleRequest(request('/voice/config'), f.env)).json() as any;
  assert.equal(before.enabled, true);
  assert.equal(before.browserCalling, true);
  assert.equal(before.telephony.configured, false);
  assert.equal(before.telephony.phoneNumber, null);
  assert.equal(before.telephony.sipUri, null);
  const agent = await saveAgent(f);
  f.env.TWILIO_AGENT_ID = agent.id;
  const configured = await (await handleRequest(request('/voice/config'), f.env)).json() as any;
  assert.equal(configured.telephony.configured, true);
  assert.equal(configured.telephony.phoneNumber, PHONE_NUMBER);
  assert.equal(configured.telephony.webhookUrl, `${PUBLIC_ORIGIN}/voice/twilio/incoming/${agent.id}`);
  f.env.TWILIO_AGENT_ID = 'different-agent';
  assert.equal(((await (await handleRequest(request('/voice/config'), f.env)).json() as any).telephony.configured), false);
  f.env.VOICE_ENABLED = 'false';
  const disabled = await (await handleRequest(request('/voice/config'), f.env)).json() as any;
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.browserCalling, false);
  assert.equal(disabled.telephony.configured, false);
});

test('SIP-only and combined telephony report independently priced destinations only to their mapped agent', async t => {
  const f=await fixture(t);
  const agent=await saveAgent(f);f.env.TWILIO_AGENT_ID=agent.id;
  f.env.TWILIO_SIP_URI=SIP_URI;
  const config=async(session=SESSION_ONE)=>(await (await handleRequest(request('/voice/config','GET',undefined,{session}),f.env)).json() as any).telephony;
  assert.equal((await config()).sipUri,null); // PSTN pricing cannot enable SIP.
  f.env.VOICE_SIP_MICRO_USD_PER_MINUTE='4000';
  assert.deepEqual(await config(),{configured:true,webhookUrl:`${PUBLIC_ORIGIN}/voice/twilio/incoming/${agent.id}`,phoneNumber:PHONE_NUMBER,sipUri:SIP_URI,telnyx:{configured:false,webhookUrl:null,phoneNumber:null,sipUri:null}});
  delete f.env.TWILIO_PHONE_NUMBER;delete f.env.VOICE_PHONE_MICRO_USD_PER_MINUTE;
  assert.deepEqual(await config(),{configured:true,webhookUrl:`${PUBLIC_ORIGIN}/voice/twilio/incoming/${agent.id}`,phoneNumber:null,sipUri:SIP_URI,telnyx:{configured:false,webhookUrl:null,phoneNumber:null,sipUri:null}});
  await saveAgent(f,SESSION_TWO);
  const other=await config(SESSION_TWO);
  assert.equal(other.configured,false);assert.equal(other.sipUri,null);assert.equal(other.phoneNumber,null);
  for (const rate of ['', '0', '-1', 'NaN', '1.5', '1000001']) {
    f.env.VOICE_SIP_MICRO_USD_PER_MINUTE=rate;
    assert.equal((await config()).configured,false,rate);
  }
  f.env.VOICE_SIP_MICRO_USD_PER_MINUTE='4000';
  f.env.TWILIO_SIP_URI='sip:receptionist@untrusted.example';
  assert.equal((await config()).configured,false);
  f.env.TWILIO_SIP_URI=SIP_URI;f.env.VOICE_ENABLED='false';
  assert.equal((await config()).sipUri,null);
});

test('SIP destination parsing preserves the called user and rejects ambiguous or foreign URIs', () => {
  for (const uri of [SIP_URI,'SIP:receptionist@MAINBRELLA.SIP.TWILIO.COM:5061;transport=tls',`${SIP_URI}:5060;transport=udp`,`${SIP_URI};transport=tcp`]) {
    assert.equal(twilioSipUri(uri),SIP_URI);
  }
  assert.equal(twilioSipUri('sip:Receptionist@mainbrella.sip.twilio.com'),'sip:Receptionist@mainbrella.sip.twilio.com');
  assert.equal(twilioSipUri('sip:receptionist@mainbrella.sip.us1.twilio.com'),'sip:receptionist@mainbrella.sip.us1.twilio.com');
  for (const uri of [null,'',PHONE_NUMBER,'sip:receptionist@evil.example',`${SIP_URI}.evil.example`,`${SIP_URI}@evil.example`,
    `${SIP_URI}?To=${PHONE_NUMBER}`,`${SIP_URI};user=phone`,`${SIP_URI};transport=tls;extra=1`,`${SIP_URI}:9999`,
    'sip:receptionist:password@mainbrella.sip.twilio.com',`${SIP_URI}\r\n`,`${SIP_URI}\n`, `sip:${'x'.repeat(321)}@mainbrella.sip.twilio.com`]) {
    assert.equal(twilioSipUri(uri),null,String(uri));
  }
});

test('text and browser calls initialize with frozen config, then list, detail and end remain account-scoped', async t => {
  const f = await fixture(t);
  const agent = await saveAgent(f, SESSION_ONE, { voiceLogic: 'reply_right_away' });
  const browserResponse = await handleRequest(request('/voice/calls', 'POST', { channel: 'browser' }), f.env);
  assert.equal(browserResponse.status, 201);
  const browserBody = await browserResponse.json() as any;
  const browser = browserBody.call;
  assert.equal(browser.channel, 'browser');
  assert.equal(browser.phoneTransport, null);
  assert.equal(browser.status, 'active');
  assert.match(browserBody.websocketUrl, /^wss:/);
  const snapshot = f.sqlite.prepare('SELECT config_json FROM voice_calls WHERE id=?').get(browser.id) as { config_json: string };
  assert.equal(JSON.parse(snapshot.config_json).name, 'Aster');
  assert.equal(JSON.parse(snapshot.config_json).voiceLogic, 'reply_right_away');
  await saveAgent(f, SESSION_ONE, { name: 'Updated later', voiceLogic: 'original_no_reply' });
  assert.equal(JSON.parse(snapshot.config_json).name, 'Aster');
  assert.equal(JSON.parse(snapshot.config_json).voiceLogic, 'reply_right_away');
  const textResponse = await handleRequest(request('/voice/calls', 'POST', { channel: 'text' }), f.env);
  assert.equal(textResponse.status, 201);
  const textCall = (await textResponse.json() as any).call;
  assert.equal(textCall.channel, 'text');
  assert.equal(f.calls.filter(call => new URL(call.request.url).pathname === '/initialize').length, 2);
  const list = await (await handleRequest(request('/voice/calls'), f.env)).json() as any;
  assert.equal(list.calls.length, 2);
  assert.equal((await handleRequest(request(`/voice/calls/${browser.id}`), f.env)).status, 200);
  assert.equal((await handleRequest(request(`/voice/calls/${browser.id}`, 'GET', undefined, { session: SESSION_TWO }), f.env)).status, 404);
  const ended = await handleRequest(request(`/voice/calls/${browser.id}/end`, 'POST', {}), f.env);
  assert.equal(ended.status, 200);
  assert.equal((await ended.json() as any).call.status, 'completed');
  assert.equal((await handleRequest(request(`/voice/calls/${browser.id}/end`, 'POST', {}, { session: SESSION_TWO }), f.env)).status, 404);
});

test('browser WebSocket connection requires an owned active call, trusted Origin, and no query string', async t => {
  const f = await fixture(t);
  await saveAgent(f);
  const created = await (await handleRequest(request('/voice/calls', 'POST', { channel: 'browser' }), f.env)).json() as any;
  const path = `/voice/calls/${created.call.id}/connect`;
  assert.equal((await handleRequest(request(path, 'GET', undefined, { origin: null }), f.env)).status, 403);
  assert.equal((await handleRequest(request(`${path}?token=secret`), f.env)).status, 400);
  assert.equal((await handleRequest(request(path, 'GET', undefined, { session: SESSION_TWO }), f.env)).status, 404);
  assert.equal((await handleRequest(request(path), f.env)).status, 426);
  const response = await handleRequest(request(path, 'GET', undefined, { headers: { Upgrade: 'websocket' } }), f.env);
  assert.equal(response.status, 101);
  assert.ok((response as Response & { webSocket?: unknown }).webSocket);
  assert.equal(new URL(f.calls.at(-1)!.request.url).pathname, '/connect');
});

test('call expiration and atomic per-account active and rolling daily limits use SQLite writes', async t => {
  const f = await fixture(t);
  await saveAgent(f);
  const oldId = crypto.randomUUID();
  f.sqlite.prepare(`INSERT INTO voice_calls(id,user_id,agent_id,channel,status,started_at,transcript_json,config_json)
    VALUES(?,?,?,'text','active',?,'[]','{}')`).run(oldId, USER_ONE,
      (f.sqlite.prepare('SELECT id FROM voice_agents WHERE user_id=?').get(USER_ONE) as any).id,
      new Date(Date.now() - 16 * 60_000).toISOString());
  const listed = await (await handleRequest(request('/voice/calls'), f.env)).json() as any;
  assert.equal(listed.calls.find((call: any) => call.id === oldId).status, 'completed');
  const attempts = await Promise.all(Array.from({ length: 5 }, () => handleRequest(request('/voice/calls', 'POST', { channel: 'text' }), f.env)));
  assert.equal(attempts.filter(response => response.status === 201).length, 3);
  assert.equal(attempts.filter(response => response.status === 429).length, 2);
  f.sqlite.prepare("UPDATE voice_calls SET status='completed',ended_at=? WHERE user_id=?").run(new Date().toISOString(), USER_ONE);
  f.sqlite.prepare('DELETE FROM voice_calls WHERE user_id=?').run(USER_ONE);
  const agent = f.sqlite.prepare('SELECT * FROM voice_agents WHERE user_id=?').get(USER_ONE) as any;
  const insertDaily = f.sqlite.prepare(`INSERT INTO voice_calls(id,user_id,agent_id,channel,status,started_at,ended_at,transcript_json,config_json)
    VALUES(?,?,?,'text','completed',?,?,'[]','{}')`);
  for (let i = 0; i < 97; i++) insertDaily.run(crypto.randomUUID(), USER_ONE, agent.id, new Date(Date.now() - i * 1000).toISOString(), new Date().toISOString());
  const remaining = await Promise.all(Array.from({ length: 4 }, () => handleRequest(request('/voice/calls', 'POST', { channel: 'text' }), f.env)));
  assert.equal(remaining.filter(response => response.status === 201).length, 3);
  assert.equal(remaining.filter(response => response.status === 429).length, 1);
});

test('Twilio incoming webhooks require valid signatures, mapped identities and replay-safe allocation', async t => {
  const f = await fixture(t);
  const agent = await saveAgent(f);
  f.env.TWILIO_AGENT_ID = agent.id;
  const path = `/voice/twilio/incoming/${agent.id}`;
  const fields = { AccountSid: ACCOUNT_SID, CallSid: CALL_SID, From: '+15557654321', To: PHONE_NUMBER };
  const invalid = signedForm(path, fields);
  invalid.headers.set('X-Twilio-Signature', 'invalid-signature');
  assert.equal((await handleRequest(invalid, f.env)).status, 403);
  const wrongNumber = signedForm(path, { ...fields, To: '+15550000000' });
  assert.equal((await handleRequest(wrongNumber, f.env)).status, 403);
  const wrongAccount = signedForm(path, { ...fields, AccountSid: `AC${'c'.repeat(32)}` });
  assert.equal((await handleRequest(wrongAccount, f.env)).status, 403);
  const wrongAgent = signedForm(`/voice/twilio/incoming/${crypto.randomUUID()}`, fields);
  assert.equal((await handleRequest(wrongAgent, f.env)).status, 403);
  const incoming = signedForm(path, fields);
  const first = await handleRequest(incoming, f.env);
  assert.equal(first.status, 200);
  assert.match(first.headers.get('content-type') || '', /application\/xml/);
  const xml = await first.text();
  assert.match(xml, /<Parameter name="token" value="[a-f0-9]{64}"/);
  assert.equal((f.sqlite.prepare('SELECT count(*) AS count FROM voice_calls WHERE provider_call_id=?').get(CALL_SID) as any).count, 1);
  const replay = await handleRequest(signedForm(path, fields), f.env);
  assert.equal(replay.status, 200);
  assert.match(await replay.text(), /<Hangup \/>/);
  assert.equal((f.sqlite.prepare('SELECT count(*) AS count FROM voice_calls WHERE provider_call_id=?').get(CALL_SID) as any).count, 1);
  assert.equal(f.calls.filter(call => new URL(call.request.url).pathname === '/initialize').length, 1);
  const row=f.sqlite.prepare('SELECT * FROM voice_calls WHERE provider_call_id=?').get(CALL_SID) as unknown as VoiceCallRow;
  assert.equal(publicCall(row).phoneTransport,'pstn');
  f.sqlite.prepare('UPDATE voice_calls SET phone_transport=NULL WHERE id=?').run(row.id);
  const legacy=f.sqlite.prepare('SELECT * FROM voice_calls WHERE id=?').get(row.id) as unknown as VoiceCallRow;
  assert.equal(publicCall(legacy).phoneTransport,'pstn');
});

test('signed SIP calls require the configured destination, account, agent and SIP rate before allocation', async t => {
  const f=await fixture(t);const agent=await saveAgent(f);f.env.TWILIO_AGENT_ID=agent.id;
  const path=`/voice/twilio/incoming/${agent.id}`;
  const fields={AccountSid:ACCOUNT_SID,CallSid:CALL_SID,From:'sip:caller@pbx.example',To:SIP_URI};
  assert.equal((await handleRequest(signedForm(path,fields),f.env)).status,403);
  f.env.TWILIO_SIP_URI=SIP_URI;
  assert.equal((await handleRequest(signedForm(path,fields),f.env)).status,503);
  f.env.VOICE_SIP_MICRO_USD_PER_MINUTE='4000';
  delete f.env.VOICE_PHONE_MICRO_USD_PER_MINUTE;
  assert.equal((await handleRequest(signedForm(path,{...fields,To:PHONE_NUMBER}),f.env)).status,503);
  f.env.VOICE_PHONE_MICRO_USD_PER_MINUTE='12500';
  const invalid=signedForm(path,fields);invalid.headers.set('X-Twilio-Signature','invalid');
  assert.equal((await handleRequest(invalid,f.env)).status,403);
  for (const To of ['sip:someone-else@mainbrella.sip.twilio.com','sip:Receptionist@mainbrella.sip.twilio.com',
    'sip:receptionist@other.sip.twilio.com',`${SIP_URI}.evil.example`,`${SIP_URI};user=phone`,`${SIP_URI}?x=1`]) {
    assert.equal((await handleRequest(signedForm(path,{...fields,To}),f.env)).status,403,To);
  }
  assert.equal((await handleRequest(signedForm(path,{...fields,AccountSid:`AC${'c'.repeat(32)}`}),f.env)).status,403);
  assert.equal((await handleRequest(signedForm(`/voice/twilio/incoming/${crypto.randomUUID()}`,fields),f.env)).status,403);
  assert.equal((await handleRequest(signedForm(path,{...fields,CallSid:'invalid'}),f.env)).status,403);
  assert.equal((f.sqlite.prepare('SELECT count(*) AS count FROM voice_calls').get() as any).count,0);
  delete f.env.TWILIO_PHONE_NUMBER;delete f.env.VOICE_PHONE_MICRO_USD_PER_MINUTE;
  const response=await handleRequest(signedForm(path,{...fields,To:'sip:receptionist@MAINBRELLA.SIP.TWILIO.COM:5061;transport=tls'}),f.env);
  assert.equal(response.status,200);assert.match(await response.text(),/<Connect><Stream/);
  const row=f.sqlite.prepare('SELECT * FROM voice_calls WHERE provider_call_id=?').get(CALL_SID) as unknown as VoiceCallRow;
  assert.equal(row.phone_transport,'sip');assert.equal(publicCall(row).phoneTransport,'sip');
  assert.equal(row.channel,'phone');
  const replay=await handleRequest(signedForm(path,fields),f.env);
  assert.match(await replay.text(),/<Hangup \/>/);
  assert.equal(f.calls.filter(call=>new URL(call.request.url).pathname==='/initialize').length,1);
});

test('unfunded SIP calls hang up without allocating a paid session', async t => {
  const f=await fixture(t);const agent=await saveAgent(f);f.env.TWILIO_AGENT_ID=agent.id;
  f.env.TWILIO_SIP_URI=SIP_URI;f.env.VOICE_SIP_MICRO_USD_PER_MINUTE='4000';
  delete f.env.TWILIO_PHONE_NUMBER;
  const state=f.billing.stored.get('containerAccount') as any;
  state.wallet.fundings.pi_voice.refundedCents=500;f.billing.stored.set('containerAccount',state);
  const response=await handleRequest(signedForm(`/voice/twilio/incoming/${agent.id}`,{AccountSid:ACCOUNT_SID,CallSid:CALL_SID,To:SIP_URI}),f.env);
  assert.equal(response.status,200);assert.match(await response.text(),/<Hangup \/>/);
  assert.equal((f.sqlite.prepare('SELECT count(*) AS count FROM voice_calls').get() as any).count,0);
  assert.equal(f.calls.filter(call=>new URL(call.request.url).pathname==='/initialize').length,0);
});

test('Twilio μ-law conversion produces bounded 16 kHz PCM and valid 8 kHz frame shapes', () => {
  const silence = btoa(String.fromCharCode(...new Uint8Array(160).fill(0xff)));
  const pcm = twilioToPCM(silence);
  assert.equal(pcm.byteLength, 160 * 4);
  const view = new DataView(pcm);
  for (let i = 0; i < pcm.byteLength; i += 2) assert.equal(view.getInt16(i, true), 0);
  const outbound = new ArrayBuffer(320 * 4);
  const samples = new DataView(outbound);
  for (let i = 0; i < 320; i++) {
    samples.setInt16(i * 4, Math.round(Math.sin(i / 12) * 12000), true);
    samples.setInt16(i * 4 + 2, Math.round(Math.sin((i + 1) / 12) * 12000), true);
  }
  const frames = pcmToTwilio(outbound);
  assert.equal(frames.length, 2);
  assert.ok(frames.every(frame => atob(frame).length === 160));
  assert.equal(twilioToPCM(frames[0]).byteLength, 160 * 4);
  assert.equal(twilioToPCM(btoa(String.fromCharCode(...new Uint8Array(8000).fill(0xff)))).byteLength, 8000 * 4);
  assert.throws(() => twilioToPCM(btoa(String.fromCharCode(...new Uint8Array(8001)))), /audio_frame_too_large/);
  assert.throws(() => pcmToTwilio(new ArrayBuffer(3)), /invalid_pcm_audio/);
});

test('unfunded calls fail before allocation and stop all existing owned calls',async t=>{
  const f=await fixture(t);await saveAgent(f);
  const started=await handleRequest(request('/voice/calls','POST',{channel:'text'}),f.env);
  assert.equal(started.status,201);
  const id=(await started.json() as any).call.id;
  const state=f.billing.stored.get('containerAccount') as any;
  state.wallet.fundings.pi_voice.refundedCents=500;
  f.billing.stored.set('containerAccount',state);
  for (const channel of ['text','browser']) {
    const response=await handleRequest(request('/voice/calls','POST',{channel}),f.env);
    assert.equal(response.status,402);
    assert.equal((await response.json() as any).error,'insufficient_balance');
  }
  assert.ok(f.calls.some(call=>call.name===id&&new URL(call.request.url).pathname==='/billing-stop'));
  assert.equal((f.sqlite.prepare('SELECT count(*) AS count FROM voice_calls').get() as any).count,1);
  assert.equal((await handleRequest(request('/voice/calls','POST',{channel:'text'},{session:SESSION_TWO}),f.env)).status,409);
});

test('unfunded signed phone calls return Hangup without allocating a session',async t=>{
  const f=await fixture(t);const agent=await saveAgent(f);f.env.TWILIO_AGENT_ID=agent.id;
  const state=f.billing.stored.get('containerAccount') as any;
  state.wallet.fundings.pi_voice.refundedCents=500;f.billing.stored.set('containerAccount',state);
  const response=await handleRequest(signedForm(`/voice/twilio/incoming/${agent.id}`,{
    AccountSid:ACCOUNT_SID,CallSid:CALL_SID,To:PHONE_NUMBER,
  }),f.env);
  assert.equal(response.status,200);assert.match(await response.text(),/<Hangup \/>/);
  assert.equal((f.sqlite.prepare('SELECT count(*) AS count FROM voice_calls').get() as any).count,0);
});


test('phone shutdown completes the provider call with authenticated Twilio API and retries errors',async()=>{
  const env={TWILIO_ACCOUNT_SID:ACCOUNT_SID,TWILIO_AUTH_TOKEN:AUTH_TOKEN} as Env;
  await hangupTwilioCall(env,CALL_SID,(async(url,init)=>{
    assert.equal(url,`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Calls/${CALL_SID}.json`);
    assert.equal(init?.method,'POST');assert.equal(String(init?.body),'Status=completed');
    assert.equal((init?.headers as Record<string,string>).authorization,`Basic ${btoa(`${ACCOUNT_SID}:${AUTH_TOKEN}`)}`);
    return Response.json({sid:CALL_SID,status:'completed',duration:'61'});
  }) as typeof fetch);
  await assert.rejects(hangupTwilioCall(env,CALL_SID,(async()=>new Response(null,{status:503})) as typeof fetch),/voice_telephony_stop_failed/);
});


test('phone billing recovers provider duration after a lost hangup acknowledgement',async()=>{
  const env={TWILIO_ACCOUNT_SID:ACCOUNT_SID,TWILIO_AUTH_TOKEN:AUTH_TOKEN} as Env;let requests=0;
  const usage=await hangupTwilioCall(env,CALL_SID,(async(_url,init)=>{
    requests++;
    return init?.method==='POST'?new Response(null,{status:400}):Response.json({sid:CALL_SID,status:'completed',duration:'61'});
  }) as typeof fetch);
  assert.equal(requests,2);assert.deepEqual(usage,{durationSeconds:61,billableMinutes:2});
  await assert.rejects(hangupTwilioCall(env,CALL_SID,(async()=>Response.json({sid:CALL_SID,status:'completed',duration:null})) as typeof fetch),/voice_telephony_usage_pending/);
});

const telnyxFields = (overrides:Record<string,string>={}) => ({AccountSid:TELNYX_TEST_ACCOUNT,ConnectionId:TELNYX_TEST_CONNECTION,
  CallSid:TELNYX_TEST_CALL,To:TELNYX_TEST_BINDINGS.TELNYX_PHONE_NUMBER,ToSipUri:`${TELNYX_TEST_BINDINGS.TELNYX_PHONE_NUMBER}@sip.telnyx.com`,...overrides});
function telnyxForm(path:string,fields=telnyxFields(),timestamp?:string) {
  const body=new URLSearchParams(fields).toString();
  return new Request(`${API}${path}`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',...telnyxTestSignature(body,timestamp)},body});
}

test('Telnyx account SID discovery logs only verified mapped identities and never allocates calls',async t=>{
  const f=await fixture(t);const agent=await saveAgent(f);
  Object.assign(f.env,TELNYX_TEST_BINDINGS,{TELNYX_AGENT_ID:agent.id,TELNYX_ACCOUNT_SID:''});
  const warnings=t.mock.method(console,'warn',()=>{});
  const path=`/voice/telnyx/incoming/${agent.id}`;
  const unsigned=telnyxForm(path);unsigned.headers.delete('telnyx-signature-ed25519');
  assert.equal((await handleRequest(unsigned,f.env)).status,403);
  const stale=telnyxForm(path,telnyxFields(),String(Math.floor(Date.now()/1000)-400));
  assert.equal((await handleRequest(stale,f.env)).status,403);
  assert.equal((await handleRequest(telnyxForm(path,telnyxFields({ConnectionId:'123'})),f.env)).status,403);
  assert.equal((await handleRequest(telnyxForm(path,telnyxFields({To:'+15550000000'})),f.env)).status,403);
  assert.equal((await handleRequest(telnyxForm(`/voice/telnyx/incoming/${crypto.randomUUID()}`),f.env)).status,403);
  assert.equal((await handleRequest(telnyxForm(path,telnyxFields({AccountSid:'untrusted\nlog-injection'})),f.env)).status,503);
  assert.equal(warnings.mock.calls.some(call=>call.arguments[0]==='voice_telnyx_account_sid_required'),false);

  const response=await handleRequest(telnyxForm(path),f.env);
  assert.equal(response.status,503);assert.equal(await response.text(),'');
  const discovery=warnings.mock.calls.filter(call=>call.arguments[0]==='voice_telnyx_account_sid_required');
  assert.equal(discovery.length,1);
  assert.deepEqual(JSON.parse(discovery[0].arguments[1]),{AccountSid:TELNYX_TEST_ACCOUNT,ConnectionId:TELNYX_TEST_CONNECTION});
  assert.equal(f.env.TELNYX_ACCOUNT_SID,'');
  assert.equal((f.sqlite.prepare('SELECT count(*) AS count FROM voice_calls').get() as any).count,0);
  assert.equal(f.calls.length,0);

  f.env.TELNYX_ACCOUNT_SID=TELNYX_TEST_ACCOUNT;
  const configured=await handleRequest(telnyxForm(path),f.env);
  assert.equal(configured.status,200);assert.match(await configured.text(),/<Stream/);
  assert.equal(f.calls.filter(call=>new URL(call.request.url).pathname==='/initialize').length,1);
});

test('Telnyx availability is priced per destination, isolated by agent and independent of Twilio',async t=>{
  const f=await fixture(t);const agent=await saveAgent(f);
  Object.assign(f.env,TELNYX_TEST_BINDINGS,{TELNYX_AGENT_ID:agent.id,TELNYX_SIP_URI:TELNYX_TEST_SIP});
  delete f.env.TWILIO_AUTH_TOKEN;
  const config=async(session=SESSION_ONE)=>(await (await handleRequest(request('/voice/config','GET',undefined,{session}),f.env)).json() as any).telephony;
  let result=await config();
  assert.equal(result.configured,true);assert.equal(result.phoneNumber,null);
  assert.deepEqual(result.telnyx,{configured:true,webhookUrl:`${PUBLIC_ORIGIN}/voice/telnyx/incoming/${agent.id}`,phoneNumber:'+19362461010',sipUri:null});
  f.env.TELNYX_SIP_MICRO_USD_PER_MINUTE='3000';delete f.env.TELNYX_PHONE_NUMBER;
  result=await config();assert.equal(result.telnyx.sipUri,TELNYX_TEST_SIP);assert.equal(result.telnyx.phoneNumber,null);
  for(const rate of ['', '0', '-1', 'NaN', '1.5', '1000001']) {
    f.env.TELNYX_SIP_MICRO_USD_PER_MINUTE=rate;assert.equal((await config()).configured,false);
  }
  f.env.TELNYX_SIP_MICRO_USD_PER_MINUTE='3000';
  await saveAgent(f,SESSION_TWO);assert.deepEqual((await config(SESSION_TWO)).telnyx,{configured:false,webhookUrl:null,phoneNumber:null,sipUri:null});
  f.env.VOICE_ENABLED='false';assert.equal((await config()).configured,false);
});

test('Telnyx Ed25519 signatures cover exact bytes and reject missing, malformed, stale or future headers',async()=>{
  const key=TELNYX_TEST_BINDINGS.TELNYX_PUBLIC_KEY,payload='To=%2B19362461010&AccountSid=test';
  const headers=new Headers(telnyxTestSignature(payload));
  assert.equal(await validTelnyxSignature(key,headers,payload),true);
  assert.equal(await validTelnyxSignature(key,headers,payload.replace('%2B','%2b')),false);
  assert.equal(await validTelnyxSignature(key,new Headers(),payload),false);
  for(const timestamp of ['NaN','123abc',String(Math.floor(Date.now()/1000)-301),String(Math.floor(Date.now()/1000)+301)])
    assert.equal(await validTelnyxSignature(key,new Headers(telnyxTestSignature(payload,timestamp)),payload),false);
  assert.equal(await validTelnyxSignature('bad-key',headers,payload),false);
});

for(const transport of ['pstn','sip'] as const) {
  test(`Telnyx ${transport} webhooks require signature, mapped account/application/destination and replay-safe allocation`,async t=>{
    const f=await fixture(t);const agent=await saveAgent(f);
    Object.assign(f.env,TELNYX_TEST_BINDINGS,{TELNYX_AGENT_ID:agent.id,TELNYX_SIP_URI:TELNYX_TEST_SIP,TELNYX_SIP_MICRO_USD_PER_MINUTE:'3000'});
    const path=`/voice/telnyx/incoming/${agent.id}`;
    const fields=telnyxFields(transport==='sip'?{To:'receptionist',ToSipUri:'receptionist@MAINBRELLA.SIP.TELNYX.COM:5060;transport=tcp'}:{});
    const unsigned=telnyxForm(path,fields);unsigned.headers.delete('telnyx-signature-ed25519');
    assert.equal((await handleRequest(unsigned,f.env)).status,403);
    assert.equal((await handleRequest(telnyxForm(path,fields,String(Math.floor(Date.now()/1000)-400)),f.env)).status,403);
    for(const changes of [{AccountSid:crypto.randomUUID()},{ConnectionId:'123'}, {CallSid:'../../other'},
      transport==='sip'?{ToSipUri:'someone-else@mainbrella.sip.telnyx.com'}:{To:'+15550000000'}]) {
      assert.equal((await handleRequest(telnyxForm(path,{...fields,...changes}),f.env)).status,403);
    }
    assert.equal((await handleRequest(telnyxForm(`/voice/telnyx/incoming/${crypto.randomUUID()}`,fields),f.env)).status,403);
    if(transport==='sip')delete f.env.TELNYX_SIP_MICRO_USD_PER_MINUTE;else delete f.env.TELNYX_PHONE_MICRO_USD_PER_MINUTE;
    assert.equal((await handleRequest(telnyxForm(path,fields),f.env)).status,503);
    f.env.TELNYX_SIP_MICRO_USD_PER_MINUTE='3000';f.env.TELNYX_PHONE_MICRO_USD_PER_MINUTE='10000';
    const first=await handleRequest(telnyxForm(path,fields),f.env);assert.equal(first.status,200);
    const xml=await first.text();assert.match(xml,/bidirectionalMode="rtp"/);assert.match(xml,/codec="PCMU"/);assert.match(xml,/enableReconnect="false"/);
    const row=f.sqlite.prepare('SELECT * FROM voice_calls WHERE provider_call_id=?').get(TELNYX_TEST_CALL) as unknown as VoiceCallRow;
    assert.equal(row.phone_provider,'telnyx');assert.equal(row.phone_transport,transport);assert.equal(publicCall(row).phoneProvider,'telnyx');
    assert.match(await (await handleRequest(telnyxForm(path,fields),f.env)).text(),/<Hangup/);
    assert.equal(f.calls.filter(call=>new URL(call.request.url).pathname==='/initialize').length,1);
    assert.equal((await handleRequest(new Request(`${API}/voice/telnyx/media/${row.id}`,{headers:{Upgrade:'websocket'}}),f.env)).status,403);
    const mediaUrl=`${PUBLIC_ORIGIN}/voice/telnyx/media/${row.id}`;
    assert.equal((await handleRequest(new Request(mediaUrl,{headers:{Upgrade:'websocket',...telnyxTestSignature(mediaUrl)}}),f.env)).status,403);
    f.env.TWILIO_AGENT_ID=agent.id;
    const wrongProvider=`${PUBLIC_ORIGIN}/voice/twilio/media/${row.id}`;
    assert.equal((await handleRequest(new Request(wrongProvider,{headers:{Upgrade:'websocket','X-Twilio-Signature':getExpectedTwilioSignature(AUTH_TOKEN,wrongProvider,{})}}),f.env)).status,404);
  });
}

test('unfunded Telnyx calls hang up without allocating a paid session',async t=>{
  const f=await fixture(t);const agent=await saveAgent(f);
  Object.assign(f.env,TELNYX_TEST_BINDINGS,{TELNYX_AGENT_ID:agent.id});
  const state=f.billing.stored.get('containerAccount') as any;
  state.wallet.fundings.pi_voice.refundedCents=500;f.billing.stored.set('containerAccount',state);
  assert.match(await (await handleRequest(telnyxForm(`/voice/telnyx/incoming/${agent.id}`),f.env)).text(),/<Hangup/);
  assert.equal((f.sqlite.prepare('SELECT count(*) AS count FROM voice_calls').get() as any).count,0);
});

test('Telnyx SIP destinations preserve users, normalize hosts and reject foreign or ambiguous URIs',()=>{
  assert.equal(telnyxSipUri('receptionist@MAINBRELLA.SIP.TELNYX.COM:5060;transport=tcp'),TELNYX_TEST_SIP);
  for(const value of [`${TELNYX_TEST_SIP}.evil.example`,`${TELNYX_TEST_SIP}?x=1`,`${TELNYX_TEST_SIP};transport=tls`,`${TELNYX_TEST_SIP}\n`,'sip:receptionist@sip.telnyx.com','sip:user:pass@mainbrella.sip.telnyx.com'])
    assert.equal(telnyxSipUri(value),null,value);
});

test('Telnyx RTP pads partial output to the minimum 20 ms PCMU chunk',()=>{
  assert.deepEqual(pcmToTelnyx(new ArrayBuffer(0)),[]);
  const frames=pcmToTelnyx(new ArrayBuffer(644));
  assert.equal(frames.length,2);
  assert.ok(frames.every(frame=>Buffer.from(frame,'base64').length===160));
  assert.ok(Buffer.from(frames[1],'base64').every(byte=>byte===255));
});

test('Telnyx legacy UUID calls accept native media IDs while native calls require exact identity',()=>{
  assert.equal(telnyxCallIdMatches(TELNYX_TEST_ACCOUNT,TELNYX_TEST_CALL),true);
  assert.equal(telnyxCallIdMatches(TELNYX_TEST_CALL,TELNYX_TEST_CALL),true);
  assert.equal(telnyxCallIdMatches(TELNYX_TEST_CALL,'v3:other'),false);
  assert.equal(telnyxCallIdMatches('V3:original','v3:other'),false);
  assert.equal(telnyxCallIdMatches(TELNYX_TEST_ACCOUNT,'../../other'),false);
});

test('Telnyx hangup authenticates TeXML API, confirms terminal duration and retries pending/failed outcomes',async()=>{
  const env=TELNYX_TEST_BINDINGS as unknown as Env;
  let requests=0;
  const usage=await hangupTelnyxCall(env,TELNYX_TEST_CALL,(async(url,init)=>{
    requests++;assert.equal(url,`https://api.telnyx.com/v2/texml/Accounts/${TELNYX_TEST_ACCOUNT}/Calls/${encodeURIComponent(TELNYX_TEST_CALL)}`);
    assert.equal((init!.headers as any).authorization,`Bearer ${env.TELNYX_API_KEY}`);
    if(init!.method==='POST'){assert.equal(String(init!.body),'Status=completed');return Response.json({status:'completed',duration:null});}
    return Response.json({sid:TELNYX_TEST_CALL,account_sid:TELNYX_TEST_ACCOUNT,status:'completed',duration:'61',end_time:new Date().toISOString()});
  }) as typeof fetch);
  assert.equal(requests,2);assert.deepEqual(usage,{durationSeconds:61,billableMinutes:2});
  await assert.rejects(hangupTelnyxCall(env,TELNYX_TEST_CALL,(async()=>new Response(null,{status:503})) as typeof fetch),/voice_telephony_stop_failed/);
  for(const result of [{status:'completed',duration:null},{status:'in-progress',duration:'61'},{status:'completed',duration:'-1'}, {status:'completed',duration:'61',account_sid:crypto.randomUUID()}]) {
    await assert.rejects(hangupTelnyxCall(env,TELNYX_TEST_CALL,(async()=>Response.json({sid:TELNYX_TEST_CALL,account_sid:TELNYX_TEST_ACCOUNT,end_time:new Date().toISOString(),...result})) as typeof fetch),/voice_telephony_usage_pending/);
  }
  let requestCount=0;
  assert.deepEqual(await hangupTelnyxCall(env,TELNYX_TEST_CALL,(async()=>{
    if(++requestCount===1)return new Response(null,{status:422});
    return Response.json({sid:TELNYX_TEST_CALL,account_sid:TELNYX_TEST_ACCOUNT,status:'busy'});
  }) as typeof fetch),{durationSeconds:0,billableMinutes:0});
});
