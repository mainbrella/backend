import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { OutboxProbe, outboxProbeRoute } from './webhook-outbox-probe.mjs';
import { QualificationReceiver } from './webhook-receiver-core.mjs';
const adminToken = 'a'.repeat(64), runId = randomUUID();
function storage() {
  const values = new Map(); let alarm;
  return { values, get: async key => structuredClone(values.get(key)), put: async (key, value) => { values.set(key, structuredClone(value)); },
    list: async ({ prefix }) => new Map([...values].filter(([key]) => key.startsWith(prefix))), delete: async keys => { for (const key of keys) values.delete(key); },
    setAlarm: async value => { alarm = value; }, getAlarm: async () => alarm ?? null, deleteAlarm: async () => { alarm = undefined; }, deleteAll: async () => values.clear() };
}
test('routing authenticates before allocation and replaces caller-supplied probe identities', async () => {
  let allocated = false, internal;
  const env = { QUALIFICATION_RECEIVER_TOKEN: adminToken, OUTBOX: { idFromName: name => { allocated = true; return name; }, get: () => ({ fetch: request => { internal = request; return Response.json({}); } }) } };
  assert.equal(outboxProbeRoute(new Request(`https://probe.example/${runId}/setup`, { method: 'POST' }), env).status, 401);
  assert.equal(allocated, false);
  await outboxProbeRoute(new Request(`https://probe.example/${runId}/setup`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}`, 'x-probe-run-id': 'foreign' } }), env);
  assert.equal(internal.headers.get('x-probe-run-id'), runId);
});
test('actual outbox/controller/scheduler code retries signed delivery and delivers stop without a native container', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const store = storage(), receiverStore = storage(), pending = [];
  const receiver = new QualificationReceiver(receiverStore, { QUALIFICATION_RECEIVER_TOKEN: adminToken }, () => now);
  let receiverTail = Promise.resolve();
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const req = new Request(url, options); const target = new URL(req.url); target.pathname = '/receive';
    const result = receiverTail.then(() => receiver.fetch(new Request(target, req)));
    receiverTail = result.catch(() => {}); return result;
  });
  const ctx = { storage: store, waitUntil: promise => { pending.push(promise); }, blockConcurrencyWhile: operation => operation() };
  const env = { WORKLOAD_WEBHOOKS_ENABLED: 'true', WEBHOOK_ALLOWED_HOSTS: 'mainbrella-webhook-qualification.crimson-dust-553b.workers.dev', WEBHOOK_ENCRYPTION_KEY: 'b'.repeat(64) };
  const probe = new OutboxProbe(ctx, env);
  const call = (path, method = 'GET') => probe.fetch(new Request('https://probe.example/' + path, { method }), runId);
  const setup = await (await call('setup', 'POST')).json(); assert.match(setup.signingSecret, /^mbwh_[a-f0-9]{64}$/);
  await receiver.fetch(new Request('https://receiver.example/admin', { method: 'PUT', headers: { Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ signingSecret: setup.signingSecret, container: setup.container, failFirst: true }) }));
  let summary = await (await call('tick', 'POST')).json();
  assert.equal(summary.deliveries.filter(delivery => delivery.status === 'pending').length, 1, JSON.stringify(summary));
  assert.equal(summary.deliveries.filter(delivery => delivery.status === 'delivered').length, 1);
  await Promise.all(pending); assert.ok(await store.getAlarm() <= now + 5000);
  now += 5000; await probe.alarm(); summary = await (await call('status')).json();
  assert.equal(summary.alarmsObserved, 1); assert.ok(summary.deliveries.every(delivery => delivery.status === 'delivered'));
  assert.equal(JSON.stringify(summary).includes(setup.signingSecret), false);
  await call('stop', 'POST'); await probe.alarm();
  summary = await (await call('status')).json(); assert.equal(summary.deliveries.length, 3);
  assert.ok(summary.deliveries.every(delivery => delivery.status === 'delivered'));
  await call('delete', 'DELETE'); assert.equal(store.values.size, 0);
});
