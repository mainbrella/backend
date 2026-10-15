import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getExpectedTwilioSignature } from 'twilio/lib/webhooks/webhooks.js';
import { handleRequest } from './router';
import { paidContainerFixture, SESSION_ONE, SESSION_TWO, USER_ONE, USER_TWO } from './paid-container-test-helpers';
import { voiceBillingFixture } from './voice-billing-test-helpers';
import { hangupTwilioCall, pcmToTwilio, twilioToPCM } from '../lib/voice-telephony';

const API = 'https://api.mainbrella.com';
const ORIGIN = 'https://mainbrella.com';
const PUBLIC_ORIGIN = 'https://api.mainbrella.com';
const AUTH_TOKEN = 'twilio-auth-token-for-tests';
const ACCOUNT_SID = `AC${'a'.repeat(32)}`;
const PHONE_NUMBER = '+15551234567';
const CALL_SID = `CA${'b'.repeat(32)}`;

type VoiceMockCall = { name: string; request: Request };
function upgradeResponse(): Response {
  return Object.defineProperties(new Response(null), { status: { value: 101 }, webSocket: { value: {} } });
}

async function fixture(t: TestContext) {
  const f = await paidContainerFixture(t);
  t.after(() => f.close());
  f.sqlite.exec(readFileSync(fileURLToPath(new URL('../../migrations/043_voice_receptionist.sql', import.meta.url)), 'utf8'));
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
  return (await response.json() as { agent: { id: string; name: string } }).agent;
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
  const other = await handleRequest(request('/voice/agent', 'GET', undefined, { session: SESSION_TWO }), f.env);
  assert.deepEqual(await other.json(), { agent: null });
  const updated = await saveAgent(f, SESSION_ONE, { name: 'Luna', voice: 'luna' });
  assert.equal(updated.id, created.id);
  assert.equal((await saveAgent(f, SESSION_TWO)).id === created.id, false);
  const saved = f.sqlite.prepare('SELECT id,voice FROM voice_agents WHERE user_id=?').get(USER_ONE) as { id: string; voice: string };
  assert.equal(saved.id, created.id);
  assert.equal(saved.voice, 'luna');
  for (const bad of [
    input({ transferNumber: '+15550001111' }), input({ voice: 'unsupported' }), input({ name: 'x'.repeat(81) }),
    input({ businessName: 'x'.repeat(121) }), input({ greeting: 'x'.repeat(501) }), input({ instructions: 'x'.repeat(8001) }),
    { ...input(), extra: true }, input({ name: '' }),
  ]) {
    assert.equal((await handleRequest(request('/voice/agent', 'PUT', bad), f.env)).status, 400);
  }
});

test('config reflects enablement and telephony is mapped only to its configured agent', async t => {
  const f = await fixture(t);
  const before = await (await handleRequest(request('/voice/config'), f.env)).json() as any;
  assert.equal(before.enabled, true);
  assert.equal(before.browserCalling, true);
  assert.equal(before.telephony.configured, false);
  assert.equal(before.telephony.phoneNumber, null);
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

test('text and browser calls initialize with frozen config, then list, detail and end remain account-scoped', async t => {
  const f = await fixture(t);
  const agent = await saveAgent(f);
  const browserResponse = await handleRequest(request('/voice/calls', 'POST', { channel: 'browser' }), f.env);
  assert.equal(browserResponse.status, 201);
  const browserBody = await browserResponse.json() as any;
  const browser = browserBody.call;
  assert.equal(browser.channel, 'browser');
  assert.equal(browser.status, 'active');
  assert.match(browserBody.websocketUrl, /^wss:/);
  const snapshot = f.sqlite.prepare('SELECT config_json FROM voice_calls WHERE id=?').get(browser.id) as { config_json: string };
  assert.equal(JSON.parse(snapshot.config_json).name, 'Aster');
  await saveAgent(f, SESSION_ONE, { name: 'Updated later' });
  assert.equal(JSON.parse(snapshot.config_json).name, 'Aster');
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
