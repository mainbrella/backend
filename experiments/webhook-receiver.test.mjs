import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { QualificationReceiver, receiverRoute, RECEIVER_LIFETIME_MS } from './webhook-receiver-core.mjs';

const adminToken = 'a'.repeat(64), signingSecret = 'mbwh_' + 'b'.repeat(64);
const container = { id: 'small', createdAt: '2026-10-05T12:00:00.000Z' };
function fixture() {
  let now = Date.parse(container.createdAt), state, alarm;
  const storage = { get: async () => structuredClone(state), put: async (_, value) => { state = structuredClone(value); },
    deleteAll: async () => { state = undefined; }, setAlarm: async value => { alarm = value; }, deleteAlarm: async () => { alarm = undefined; } };
  const receiver = new QualificationReceiver(storage, { QUALIFICATION_RECEIVER_TOKEN: adminToken }, () => now);
  const admin = (method = 'GET', body) => receiver.fetch(new Request('https://receiver.example/admin', {
    method, headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }));
  const event = (sequence = 1, patch = {}) => ({ id: randomUUID(), sequence, type: 'started', occurredAt: container.createdAt, container, ...patch });
  const receive = (value, patch = {}) => {
    const body = JSON.stringify(value), timestamp = Math.floor(now / 1000);
    const signature = createHmac('sha256', signingSecret).update(`${timestamp}.${body}`).digest('hex');
    return receiver.fetch(new Request('https://receiver.example/receive', { method: 'POST',
      headers: { 'Mainbrella-Signature': `t=${timestamp},v1=${signature}`, 'Mainbrella-Event-Id': value.id, ...patch.headers }, body: patch.body ?? body }));
  };
  return { receiver, admin, receive, event, advance: ms => { now += ms; }, state: () => state, alarm: () => alarm };
}

test('admin requires authentication before object allocation and never discloses signing credentials', async () => {
  const f = fixture();
  assert.equal((await f.receiver.fetch(new Request('https://receiver.example/admin'))).status, 401);
  const env = { QUALIFICATION_RECEIVER_TOKEN: adminToken, RECEIVER: { idFromName() { throw new Error('should not allocate'); } } };
  assert.equal(receiverRoute(new Request(`https://receiver.example/admin/${randomUUID()}`), env).status, 401);
  assert.equal((await f.admin('PUT', { signingSecret, container, failFirst: false })).status, 200);
  const response = await f.admin(); const text = await response.text();
  assert.equal(text.includes(signingSecret), false); assert.equal(text.includes(adminToken), false);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('raw-body authentication and exact generation/event identity reject tampering and foreign workloads', async () => {
  const f = fixture(); await f.admin('PUT', { signingSecret, container, failFirst: false });
  const event = f.event();
  assert.equal((await f.receive(event, { body: JSON.stringify(event) + ' ' })).status, 401);
  assert.equal((await f.receive(f.event(1, { container: { ...container, createdAt: '2026-10-05T13:00:00.000Z' } }))).status, 400);
  assert.equal((await f.receive(event, { headers: { 'Mainbrella-Event-Id': randomUUID() } })).status, 400);
  assert.equal((await f.receive(event)).status, 200);
  assert.equal((await f.admin()).status, 200);
  assert.equal(f.state().events.length, 1);
});

test('transient failures, duplicate IDs, conflicting bodies and out-of-order delivery have distinct evidence', async () => {
  const f = fixture(); await f.admin('PUT', { signingSecret, container, failFirst: true });
  const first = f.event(1), second = f.event(2);
  assert.equal((await f.receive(first)).status, 503);
  assert.equal((await f.receive(second)).status, 200);
  assert.equal((await f.receive(first)).status, 200);
  assert.equal((await f.receive(first)).status, 200);
  assert.equal((await f.receive({ ...first, type: 'stopped' })).status, 409);
  const view = await (await f.admin()).json();
  assert.equal(view.transientFailures, 1); assert.equal(view.duplicates, 1); assert.equal(view.outOfOrder, 1);
  assert.equal(view.events.length, 2);
  assert.equal(JSON.stringify(view).includes('signingSecret'), false);
});

test('rotation cannot extend retention, change generation or authenticate the old key; expiry and removal wipe data', async () => {
  const f = fixture(); await f.admin('PUT', { signingSecret, container, failFirst: false });
  const expiresAt = f.alarm(); f.advance(1000);
  assert.equal((await f.admin('PUT', { signingSecret, container: { ...container, id: 'c1' }, failFirst: false })).status, 400);
  assert.equal((await f.admin('PUT', { signingSecret: 'mbwh_' + 'c'.repeat(64), container, failFirst: false })).status, 200);
  assert.equal(f.alarm(), expiresAt);
  assert.equal((await f.receive(f.event())).status, 401);
  f.advance(RECEIVER_LIFETIME_MS);
  assert.equal((await f.admin()).status, 404); assert.equal(f.state(), undefined);
  await f.admin('PUT', { signingSecret, container, failFirst: false });
  await f.admin('DELETE'); assert.equal(f.state(), undefined); assert.equal(f.alarm(), undefined);
});
