import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountActivityController, ACTIVITY_CONNECTION_MS, MAX_ACTIVITY_CONNECTIONS, publishActivity } from './activity.js';

const change = { resource: 'executions', containerId: 'small', createdAt: '2026-10-05T12:00:00.000Z', executionId: '00000000-0000-0000-0000-000000000001' };
class Socket {
  readyState = 1; frames = []; closes = [];
  serializeAttachment(value) { this.attachment = structuredClone(value); }
  deserializeAttachment() { return this.attachment; }
  send(data) { this.frames.push(JSON.parse(data)); }
  close(code, reason) { this.closes.push({ code, reason }); this.readyState = 2; }
}
function fixture() {
  const sockets = [], storage = new Map(); let now = 1000, alarm;
  const ctx = {
    storage: { async get(key) { return storage.get(key); }, async put(key, value) { storage.set(key, value); },
      async setAlarm(at) { alarm = at; }, async deleteAlarm() { alarm = undefined; } },
    getWebSockets() { return sockets; }, acceptWebSocket(socket) { sockets.push(socket); },
  };
  const options = { now: () => now, pairFactory: () => ({ 0: new Socket(), 1: new Socket() }), responseFactory: socket => ({ status: 101, webSocket: socket }) };
  const controller = new AccountActivityController(ctx, options);
  const request = (path = '', user = 'owner', body) => new Request('https://internal/activity' + path, {
    method: body ? 'POST' : 'GET', headers: { Upgrade: 'websocket', 'x-mainbrella-user': user }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { ctx, options, controller, sockets, storage, request, setTime(value) { now = value; }, get alarm() { return alarm; } };
}

test('account stream sends ready before notifications, rejects cross-account publication and excludes extra data', async () => {
  const f = fixture();
  assert.equal((await f.controller.fetch(f.request())).status, 101);
  assert.deepEqual(f.sockets[0].frames, [{ type: 'ready' }]);
  assert.equal((await f.controller.fetch(f.request('/change', 'other', change))).status, 403);
  assert.equal((await f.controller.fetch(f.request('/change', 'owner', { ...change, token: 'private' }))).status, 400);
  assert.equal((await f.controller.fetch(f.request('/change', 'owner', change))).status, 200);
  const event = f.sockets[0].frames[1];
  assert.equal(event.type, 'changed'); assert.equal(event.createdAt, change.createdAt); assert.equal(event.containerId, 'small');
  assert.deepEqual(Object.keys(event).sort(), ['type', 'id', ...Object.keys(change)].sort());
});

test('hibernation preserves sockets and authentication deadlines, and expiry releases connection capacity', async () => {
  const f = fixture();
  for (let n = 0; n < MAX_ACTIVITY_CONNECTIONS; n++) assert.equal((await f.controller.fetch(f.request())).status, 101);
  assert.equal((await f.controller.fetch(f.request())).status, 429);
  assert.equal(f.alarm, 1000 + ACTIVITY_CONNECTION_MS);
  const restored = new AccountActivityController(f.ctx, f.options);
  await restored.fetch(f.request('/change', 'owner', change));
  assert.equal(f.sockets[0].frames.at(-1).type, 'changed');
  f.setTime(1000 + ACTIVITY_CONNECTION_MS); await restored.alarm();
  assert.equal(f.sockets[0].closes[0].code, 1000); assert.equal(f.alarm, undefined);
  assert.equal((await restored.fetch(f.request())).status, 101);
});

test('client commands close read-only stream, invalid generations and oversized messages are rejected', async () => {
  const f = fixture(); await f.controller.fetch(f.request());
  await f.controller.webSocketMessage(f.sockets[0], 'delete this workspace');
  assert.equal(f.sockets[0].closes[0].code, 1008);
  for (const value of [{ ...change, createdAt: '2026-10-05T12:00:00Z' }, { ...change, containerId: 'victim' }, { ...change, resource: 'secret' }, { ...change, executionId: 'bad' }]) {
    assert.equal((await f.controller.fetch(f.request('/change', 'owner', value))).status, 400);
  }
  const oversized = new Request('https://internal/activity/change', { method: 'POST', headers: { 'x-mainbrella-user': 'owner' }, body: 'x'.repeat(513) });
  assert.equal((await f.controller.fetch(oversized)).status, 400);
});

test('publisher targets only the authenticated account namespace and does not expose credentials', async () => {
  const names = [], calls = [];
  const env = { ACCOUNT_ACTIVITY: { idFromName(name) { names.push(name); return name; }, get() { return { async fetch(request) { calls.push(request); return Response.json({ ok: true }); } }; } } };
  await publishActivity(env, 'owner', change);
  assert.deepEqual(names, ['activity:owner']);
  assert.deepEqual([...calls[0].headers.keys()].sort(), ['content-type', 'x-mainbrella-user']);
  assert.deepEqual(await calls[0].json(), change);
  await publishActivity(env, 'owner', { ...change, command: 'private' });
  assert.equal(calls.length, 1);
});
