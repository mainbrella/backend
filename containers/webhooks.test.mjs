import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { UserContainerController } from './user-container-core.js';
import { WorkloadWebhooks } from './webhooks.js';
import { WEBHOOK_ATTEMPTS, WEBHOOK_RETRY_MS, MAX_WEBHOOK_CONFIGS, webhookUrl, readWebhookBody } from './webhook-contract.js';
const generation = '2026-10-05T12:00:00.000Z', start = Date.parse(generation);
const env = { WORKLOAD_WEBHOOKS_ENABLED: 'true', WEBHOOK_ALLOWED_HOSTS: 'relay.example.com', WEBHOOK_ENCRYPTION_KEY: 'a'.repeat(64) };
function request(method = 'GET', body, suffix = '', createdAt = generation) {
  return new Request('https://internal/observations/webhook' + suffix, { method, ...(body ? { body: JSON.stringify(body) } : {}),
    headers: { 'x-exec-container-id': 'small', 'x-exec-created-at': createdAt, 'x-exec-expires-at': String(start + 120_000) } });
}
async function fixture(fetcher = async () => new Response(null, { status: 204 })) {
  let now = start; const values = new Map([['builderMachine', { createdAt: start, expiresAt: start + 120_000, idleExpiresAt: start + 120_000 }],
    ['machineEntitlement', { plan: 'builder', active: true, checkedAt: start, validUntil: start + 120_000 }]]);
  const ctx = { storage: { async get(key) { return structuredClone(values.get(key)); }, async put(key, value) { values.set(key, structuredClone(value)); }, async setAlarm() {}, async deleteAlarm() {} },
    container: { running: true, async setInactivityTimeout() {} } };
  const controller = new UserContainerController(ctx, () => now);
  await controller.observations.append(values.get('builderMachine'), 'starting'); await controller.observations.append(values.get('builderMachine'), 'started');
  const hooks = new WorkloadWebhooks(controller, { ...env }, fetcher); controller.observations.onAppend = event => hooks.enqueue(event);
  const configure = body => hooks.fetch(request('PUT', { url: 'https://relay.example.com/customer', ...body }));
  const deliveries = async () => (await (await hooks.fetch(request('GET', undefined, '/deliveries'))).json()).deliveries;
  return { controller, hooks, ctx, values, configure, deliveries, setTime(value) { now = value; } };
}

test('webhook targets are restricted to trusted HTTPS relay hosts, without redirects or credential URLs', async () => {
  assert.equal(webhookUrl('https://relay.example.com/path', env.WEBHOOK_ALLOWED_HOSTS), 'https://relay.example.com/path');
  for (const value of ['http://relay.example.com/', 'https://127.0.0.1/', 'https://[::1]/', 'https://localhost/', 'https://evil.example.com/',
    'https://relay.example.com.evil.test/', 'https://user:pass@relay.example.com/', 'https://relay.example.com:8443/', 'https://relay.example.com/#fragment']) assert.equal(webhookUrl(value, env.WEBHOOK_ALLOWED_HOSTS), null);
  await assert.rejects(readWebhookBody(new Request('https://internal', { method: 'PUT', body: 'x'.repeat(4097) })));
  const f = await fixture();
  f.values.get('builderMachine').createdAt++;
  assert.equal((await f.configure()).status, 409);
  f.values.get('builderMachine').createdAt--;
  f.hooks.env.WORKLOAD_WEBHOOKS_ENABLED = 'false'; assert.equal((await f.configure()).status, 503);
  assert.equal((await f.hooks.fetch(request('DELETE'))).status, 200);
});

test('one-time secrets are encrypted at rest and signed replay delivery excludes all private values', async () => {
  const calls = [], f = await fixture(async (url, options) => { calls.push({ url, options }); return new Response('private receiver body', { status: 200 }); });
  const response = await f.configure({ replayFromCursor: 0 }); assert.equal(response.status, 201);
  const configured = await response.json(), secret = configured.signingSecret;
  assert.match(secret, /^mbwh_[a-f0-9]{64}$/); assert.ok(!JSON.stringify(f.values.get('workloadWebhooks')).includes(secret));
  const read = await (await f.hooks.fetch(request())).json(); assert.ok(!('signingSecret' in read)); assert.ok(!JSON.stringify(read).includes('iv'));
  await f.hooks.tick(); assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.url, 'https://relay.example.com/customer'); assert.equal(call.options.redirect, 'manual'); assert.equal(call.options.credentials, 'omit');
    const signature = call.options.headers['Mainbrella-Signature'], match = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(signature);
    assert.equal(match[2], createHmac('sha256', secret).update(`${match[1]}.${call.options.body}`).digest('hex'));
    const payload = JSON.parse(call.options.body); assert.equal(payload.container.createdAt, generation);
    assert.equal(payload.id, call.options.headers['Mainbrella-Event-Id']); assert.ok(!call.options.body.includes(secret)); assert.ok(!('telemetryId' in payload));
  }
  const deliveries = await f.deliveries(); assert.ok(deliveries.every(item => item.status === 'delivered' && item.attempts === 1));
  assert.ok(!JSON.stringify(deliveries).includes('private')); assert.ok(!JSON.stringify(deliveries).includes('event":'));
  await f.hooks.tick(); assert.equal(calls.length, 2);
});

test('delivery backoff is bounded, recovered attempts preserve IDs, and exhausted work supports limited manual retry', async () => {
  const ids = [], f = await fixture(async (_, options) => { ids.push(options.headers['Mainbrella-Event-Id']); return new Response(null, { status: 500 }); });
  await f.configure({ replayFromCursor: 1 });
  for (let attempt = 1; attempt <= WEBHOOK_ATTEMPTS; attempt++) {
    await f.hooks.tick(); const delivery = (await f.deliveries())[0]; assert.equal(delivery.attempts, attempt);
    if (attempt < WEBHOOK_ATTEMPTS) { assert.equal(delivery.status, 'pending'); assert.equal(delivery.nextAt - delivery.lastAttemptAt, WEBHOOK_RETRY_MS[attempt - 1]); f.setTime(delivery.nextAt); }
    else assert.equal(delivery.status, 'exhausted');
  }
  assert.equal(new Set(ids).size, 1); assert.equal(ids.length, WEBHOOK_ATTEMPTS);
  const id = ids[0];
  assert.equal((await f.hooks.fetch(request('POST', { eventId: id }, '/retry', '2099-01-01T00:00:00.000Z'))).status, 404);
  for (let cycle = 1; cycle <= 3; cycle++) {
    const retry = await f.hooks.fetch(request('POST', { eventId: id }, '/retry')); assert.equal(retry.status, 202); assert.equal((await retry.json()).manualRetries, cycle);
    assert.equal((await f.hooks.fetch(request('POST', { eventId: id }, '/retry'))).status, 409);
    const state = f.values.get('workloadWebhooks'); state.deliveries[0].status = 'exhausted'; f.values.set('workloadWebhooks', state);
  }
  assert.equal((await f.hooks.fetch(request('POST', { eventId: id }, '/retry'))).status, 429);
});

test('durable enqueue watermark prevents replay after delivery records are evicted', async () => {
  let calls = 0; const f = await fixture(async () => { calls++; return new Response(null, { status: 204 }); });
  await f.configure({ replayFromCursor: 0 }); await f.hooks.tick(); assert.equal(calls, 2);
  const state = f.values.get('workloadWebhooks'); state.deliveries = []; f.values.set('workloadWebhooks', state);
  await new WorkloadWebhooks(f.controller, env, async () => { calls++; return new Response(null, { status: 204 }); }).tick();
  assert.equal(calls, 2); assert.deepEqual(await f.deliveries(), []);
  await f.controller.observations.append(f.values.get('builderMachine'), 'stopped', 'requested');
  await f.hooks.tick(); assert.equal(calls, 3); assert.equal((await f.deliveries())[0].sequence, 3);
});

test('lost final attempt cannot exceed the retry budget and a changed encryption key fails closed', async () => {
  let calls = 0; const f = await fixture(async () => { calls++; return new Response(null, { status: 204 }); });
  await f.configure({ replayFromCursor: 1 });
  const state = f.values.get('workloadWebhooks'); Object.assign(state.deliveries[0], { status: 'sending', attempts: WEBHOOK_ATTEMPTS, nextAt: start });
  f.values.set('workloadWebhooks', state); await f.hooks.tick();
  assert.equal(calls, 0); assert.equal((await f.deliveries())[0].status, 'exhausted');
  await f.hooks.fetch(request('POST', { eventId: state.deliveries[0].id }, '/retry'));
  f.hooks.env.WEBHOOK_ENCRYPTION_KEY = 'b'.repeat(64); await f.hooks.tick();
  assert.equal(calls, 0); assert.equal((await f.deliveries())[0].status, 'pending');
  assert.equal((await f.deliveries())[0].httpStatus, null);
});

test('restart recovers journal enqueue and ambiguous sending without command replay or early duplicate attempts', async () => {
  const calls = [], f = await fixture(async (_, options) => { calls.push(options); return new Response(null, { status: 204 }); });
  await f.configure();
  f.controller.observations.onAppend = undefined;
  await f.controller.observations.append(f.values.get('builderMachine'), 'stopped', 'requested');
  assert.equal((await f.deliveries()).length, 0);
  const recovered = new WorkloadWebhooks(f.controller, env, async (_, options) => { calls.push(options); return new Response(null, { status: 204 }); });
  await recovered.tick(); assert.equal(calls.length, 1);
  const state = f.values.get('workloadWebhooks'); state.deliveries[0].status = 'sending'; state.deliveries[0].nextAt = start + 30_000;
  f.values.set('workloadWebhooks', state); await recovered.tick(); assert.equal(calls.length, 1);
  f.setTime(start + 30_000); await recovered.tick(); assert.equal(calls.length, 2);
  assert.equal(calls[0].headers['Mainbrella-Event-Id'], calls[1].headers['Mainbrella-Event-Id']);
});

test('removal aborts in-flight delivery, fences late results and stays available during entitlement loss', async () => {
  let began, aborted = false;
  const ready = new Promise(resolve => { began = resolve; });
  const f = await fixture(async (_, options) => new Promise((resolve, reject) => { began(); options.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true }); }));
  await f.configure({ replayFromCursor: 1 }); const running = f.hooks.tick(); await ready;
  f.values.set('machineEntitlement', { active: false });
  assert.equal((await f.hooks.fetch(request('DELETE'))).status, 200); await running;
  assert.equal(aborted, true); assert.deepEqual(await f.deliveries(), []); assert.equal(await f.hooks.nextAlarm(), null);
  assert.equal((await (await f.hooks.fetch(request())).json()).webhook, null);
});

test('rotation clears old delivery identity and retention erases keys without touching a replacement generation', async () => {
  const f = await fixture(); const first = await (await f.configure({ replayFromCursor: 0 })).json();
  const second = await (await f.configure()).json(); assert.notEqual(first.signingSecret, second.signingSecret); assert.notEqual(first.webhook.id, second.webhook.id);
  assert.deepEqual(await f.deliveries(), []);
  f.setTime(second.webhook.retainUntil); await f.hooks.tick();
  assert.equal(await f.hooks.nextAlarm(), null); assert.deepEqual(f.values.get('workloadWebhooks'), { configs: [], deliveries: [] });
});

test('concurrent stop and webhook rotation use lifecycle-first locks and reject stopped generations', { timeout: 1000 }, async () => {
  const f = await fixture(); await f.configure();
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { entered = resolve; });
  f.ctx.container.destroy = async () => { entered(); await gate; f.ctx.container.running = false; };
  const stopping = f.controller.fetch(new Request('https://internal/container', { method: 'DELETE', headers: {
    'x-mainbrella-plan': 'builder', 'x-mainbrella-paid-until': String(start + 120_000), 'x-mainbrella-checked-at': String(start) } }));
  await ready;
  const rotating = f.configure(); await new Promise(resolve => setImmediate(resolve)); release();
  const [stopped, rotated] = await Promise.all([stopping, rotating]);
  assert.equal(stopped.status, 200); assert.equal(rotated.status, 409);
  assert.equal((await f.deliveries()).length, 1);
  assert.equal(f.values.get('workloadWebhooks').deliveries[0].event.type, 'stopped');
});

test('the default transport calls global fetch with its platform receiver instead of the outbox instance', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async function () {
    assert.ok(this === undefined || this === globalThis, 'Cloudflare rejects an arbitrary fetch receiver');
    calls++; return new Response(null, { status: 204 });
  });
  const f = await fixture();
  const hooks = new WorkloadWebhooks(f.controller, { ...env });
  assert.equal((await hooks.fetch(request('PUT', { url: 'https://relay.example.com/customer', replayFromCursor: 0 }))).status, 201);
  await hooks.tick(); assert.equal(calls, 2);
  const result = await (await hooks.fetch(request('GET', undefined, '/deliveries'))).json();
  assert.ok(result.deliveries.every(delivery => delivery.status === 'delivered'));
});

test('redirect responses remain failed deliveries and never follow the destination', async () => {
  const calls = [];
  const f = await fixture(async (url, options) => {
    calls.push(url); assert.equal(options.redirect, 'manual');
    return new Response(null, { status: 302, headers: { Location: 'https://foreign.example/collect' } });
  });
  await f.configure({ replayFromCursor: 1 }); await f.hooks.tick();
  assert.deepEqual(calls, ['https://relay.example.com/customer']);
  const [delivery] = await f.deliveries(); assert.equal(delivery.status, 'pending'); assert.equal(delivery.httpStatus, 302);
});
