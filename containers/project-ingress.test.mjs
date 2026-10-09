import test from 'node:test';
import assert from 'node:assert/strict';
import { ContainerProjectIngress } from './project-ingress.js';
import { MAX_PROJECT_BINDINGS, validProjectOrigin } from './project-contract.js';
import { UserContainerController } from './user-container-core.js';
import { MAX_PREVIEW_CONNECTIONS, MAX_PREVIEW_FRAME_BYTES } from './preview-contract.js';

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REVISION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ORIGIN = 'https://p-' + ID.replaceAll('-', '') + '.mainbrella.dev';
const BASE = Date.UTC(2026, 9, 5, 12);
const GENERATION = new Date(BASE).toISOString();
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.ok(predicate(), 'Operation did not reach expected state');
}
class Socket {
  listeners = new Map();
  sent = [];
  closed = false;
  accept() { this.accepted = true; }
  addEventListener(type, handler) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]); }
  send(data) { this.sent.push(data); }
  close(code, reason) { this.closed = true; this.reason = reason; }
  emit(type, data) { for (const handler of this.listeners.get(type) ?? []) handler({ data }); }
}
function fixture() {
  let now = BASE;
  const values = new Map([
    ['machineEntitlement', { active: true, plan: 'builder', validUntil: BASE + 3_600_000, checkedAt: BASE }],
    ['builderMachine', { createdAt: BASE, expiresAt: BASE + 3_600_000, idleExpiresAt: BASE + 600_000 }],
  ]);
  const storage = {
    async get(key) { return structuredClone(values.get(key)); },
    async put(key, value) { values.set(key, structuredClone(value)); },
    async setAlarm() {}, async deleteAlarm() {},
  };
  const calls = [];
  let fetch = async () => new Response('app', { headers: { 'set-cookie': 'mainbrella_session=unsafe', 'cache-control': 'public' } });
  const container = { running: true, async setInactivityTimeout() {}, async destroy() { this.running = false; },
    getTcpPort(port) { return { fetch(request) { calls.push({ port, request }); return fetch(request); } }; } };
  const controller = new UserContainerController({ container, storage }, () => now);
  const timers = new Map();
  let server;
  const previews = new ContainerProjectIngress(controller, {
    timers: { setTimeout(fn, ms) { const id = {}; timers.set(id, { fn, at: now + ms }); return id; }, clearTimeout(id) { timers.delete(id); } },
    pairFactory() { server = new Socket(); return { 0: new Socket(), 1: server }; },
    responseFactory(webSocket, headers) { return { status: 101, webSocket, headers }; },
  });
  controller.onStopped = () => previews.close();
  const manage = (method = 'GET', body, query = '', generation = GENERATION) => previews.manage(new Request(`https://internal/project-bindings${query}`, {
    method, headers: { 'x-project-created-at': generation }, body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const issue = async (body = { id: ID, revision: REVISION, port: 3000 }) => {
    const response = await manage('PUT', body);
    assert.equal(response.status, 201);
    return response.json();
  };
  const forward = (grant, options = {}) => previews.forward(new Request(`https://internal/project${options.path ?? '/hello?name=test'}`, {
    method: options.method ?? 'GET', body: options.body, signal: options.signal,
    headers: { 'x-project-id': grant.id, 'x-project-revision': grant.revision, 'x-project-created-at': grant.createdAt,
      'x-project-origin': ORIGIN, ...options.headers },
  }));
  return { previews, values, container, controller, timers, calls, manage, issue, forward, server: () => server,
    setFetch(value) { fetch = value; },
    async advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now && timers.has(id)) { timers.delete(id); await timer.fn(); }
      await tick();
    },
  };
}

const revoke = (f, grant, origin) => f.manage('DELETE', undefined,
  `?id=${grant.id}&revision=${grant.revision}${origin ? `&origin=${encodeURIComponent(origin)}` : ''}`);

test('generation-bound bindings persist without preview TTL, are idempotent and bounded', async () => {
  const f = fixture();
  const grant = await f.issue();
  assert.deepEqual(grant, { id: ID, revision: REVISION, port: 3000, createdAt: GENERATION });
  assert.equal((await f.manage('PUT', { id: ID, revision: REVISION, port: 3000 })).status, 200);
  assert.equal((await f.manage('PUT', { id: ID, revision: REVISION, port: 3001 })).status, 409);
  const restarted = new ContainerProjectIngress(f.controller);
  assert.deepEqual(await (await restarted.manage(new Request('https://internal/project-bindings', {
    headers: { 'x-project-created-at': GENERATION },
  }))).json(), { bindings: [grant] });
  for (let i = 1; i < MAX_PROJECT_BINDINGS; i++) await f.issue({ id: ID, port: 3000,
    revision: `bbbbbbbb-bbbb-4bbb-8bbb-${i.toString(16).padStart(12, '0')}` });
  assert.equal((await f.manage('PUT', { id: ID, port: 3000, revision: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' })).status, 429);
  f.values.get('builderMachine').createdAt++;
  assert.equal((await f.forward(grant)).status, 403);
  assert.deepEqual(await (await f.manage('GET', undefined, '', new Date(BASE + 1).toISOString())).json(), { bindings: [] });
});

test('bindings reject invalid ports, unknown keys, unbounded bodies and mismatched leases', async () => {
  const f = fixture();
  for (const body of [{ id: ID, revision: REVISION, port: 22 }, { id: ID, revision: 'bad', port: 3000 },
    { id: ID, revision: REVISION, port: 3000, ttlSeconds: 900 }, [], null]) {
    assert.equal((await f.manage('PUT', body)).status, 400);
  }
  assert.equal((await f.previews.manage(new Request('https://internal/project-bindings', { method: 'PUT', body: ' '.repeat(1025) }))).status, 400);
  assert.equal((await f.manage('PUT', { id: ID, revision: REVISION, port: 3000 }, '', 'wrong')).status, 409);
  for (const query of ['?id=bad&revision=bad', `?id=${ID}&revision=${REVISION}&revision=${REVISION}`, `?id=${ID}&revision=${REVISION}&origin=https://mainbrella.com`]) {
    assert.equal((await f.manage('DELETE', undefined, query)).status, 400);
  }
});

test('HTTP preserves app sessions, binary bodies and Origin while isolating platform credentials and cookies', async () => {
  const f = fixture();
  const grant = await f.issue();
  f.setFetch(async () => {
    const headers = new Headers({ location: 'https://app.example/login' });
    headers.append('set-cookie', 'app_session=ok; Domain=.mainbrella.dev; HttpOnly; Secure');
    headers.append('set-cookie', 'other=ok; Domain=app.example; Path=/');
    headers.append('set-cookie', 'mainbrella_session=unsafe; Path=/');
    return new Response('app', { status: 302, headers });
  });
  const response = await f.forward(grant, { method: 'POST', body: new Uint8Array([0, 255]), path: '/login?q=1', headers: {
    authorization: 'Bearer app_secret', cookie: 'mainbrella_session=account; app_session=app', origin: 'https://browser.example',
    'x-private-network': 'attack', 'x-mainbrella-user': 'victim', 'cf-connecting-ip': 'attack',
    'x-forwarded-host': 'attack', 'x-project-port': '22', forwarded: 'attack',
  } });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), 'https://app.example/login');
  assert.equal(await response.text(), 'app');
  assert.deepEqual(response.headers.getSetCookie(), ['app_session=ok; HttpOnly; Secure', 'other=ok; Path=/']);
  const app = f.calls[0].request;
  assert.equal(app.url, 'http://container/login?q=1');
  assert.equal(app.headers.get('authorization'), 'Bearer app_secret');
  assert.equal(app.headers.get('cookie'), 'app_session=app');
  assert.equal(app.headers.get('origin'), 'https://browser.example');
  assert.equal(app.headers.get('host'), new URL(ORIGIN).host);
  assert.equal(app.headers.get('x-forwarded-host'), new URL(ORIGIN).host);
  assert.equal(app.headers.get('x-forwarded-proto'), 'https');
  for (const name of ['x-private-network', 'x-mainbrella-user', 'cf-connecting-ip', 'x-project-id', 'x-project-port', 'forwarded']) assert.equal(app.headers.get(name), null);
  assert.deepEqual(new Uint8Array(await app.arrayBuffer()), new Uint8Array([0, 255]));
  await (await f.forward(grant, { headers: { authorization: 'Bearer mb_secret' } })).text();
  assert.equal(f.calls[1].request.headers.get('authorization'), null);
});

test('wrong revision, generation, unsafe origin or loss of paid access never reaches app', async () => {
  const f = fixture();
  const grant = await f.issue();
  for (const headers of [{ 'x-project-revision': 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
    { 'x-project-created-at': new Date(BASE + 1).toISOString() }, { 'x-project-origin': 'https://mainbrella.com' },
    { 'x-project-origin': `${ORIGIN}/` }, { 'x-project-origin': ORIGIN.replace('https:', 'http:') }]) {
    assert.equal((await f.forward(grant, { headers })).status, 403);
  }
  f.values.get('machineEntitlement').active = false;
  assert.equal((await f.forward(grant)).status, 403);
  assert.equal(f.calls.length, 0);
  assert.equal(validProjectOrigin(`http://p-${ID.replaceAll('-', '')}.localhost:8787`, true), true);
  assert.equal(validProjectOrigin(`http://p-${ID.replaceAll('-', '')}.localhost:8787`), false);
});

test('revision and origin revocation cancel only exact active streams and keep other bindings', async () => {
  const f = fixture();
  const grant = await f.issue();
  const replacement = await f.issue({ id: ID, revision: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', port: 3001 });
  f.setFetch(async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([42])); } })));
  const response = await f.forward(grant);
  const other = await f.forward(grant, { headers: { 'x-project-origin': 'https://custom.example' } });
  const next = await f.forward(replacement);
  const readers = [response, other, next].map(r => r.body.getReader());
  for (const reader of readers) await reader.read();
  await revoke(f, grant, ORIGIN);
  await assert.rejects(readers[0].read());
  assert.equal(f.previews.active.size, 2);
  assert.equal((await f.manage()).status, 200);
  assert.equal((await (await f.manage()).json()).bindings.length, 2);
  await revoke(f, grant);
  await assert.rejects(readers[1].read());
  assert.equal(f.previews.active.size, 1);
  assert.deepEqual((await (await f.manage()).json()).bindings, [replacement]);
  f.previews.close();
  await assert.rejects(readers[2].read());
});

test('slow transports obey shared connection limits, abort, timeout and stop', async () => {
  const f = fixture();
  const grant = await f.issue();
  f.setFetch(() => new Promise(() => {}));
  const pending = Array.from({ length: MAX_PREVIEW_CONNECTIONS }, () => f.forward(grant));
  await until(() => f.previews.active.size === MAX_PREVIEW_CONNECTIONS);
  assert.equal((await f.forward(grant)).status, 429);
  await revoke(f, grant);
  for (const response of await Promise.all(pending)) assert.equal(response.status, 502);
  const second = await f.issue();
  const abort = new AbortController();
  const aborted = f.forward(second, { signal: abort.signal });
  await until(() => f.previews.active.size === 1);
  abort.abort();
  assert.equal((await aborted).status, 502);
  const timeout = f.forward(second);
  await until(() => f.previews.active.size === 1);
  await f.advance(15_000);
  assert.equal((await timeout).status, 502);
  const stopped = f.forward(second);
  await until(() => f.previews.active.size === 1);
  f.previews.close();
  assert.equal((await stopped).status, 502);
});

test('WebSockets bridge frames, close on revocation and reject oversized frames', async () => {
  const f = fixture();
  const grant = await f.issue();
  let upstream = new Socket();
  f.setFetch(async () => ({ status: 101, headers: new Headers(), webSocket: upstream }));
  const response = await f.forward(grant, { headers: { upgrade: 'websocket' } });
  assert.equal(response.status, 101);
  f.server().emit('message', 'hello');
  assert.deepEqual(upstream.sent, ['hello']);
  upstream.emit('message', new Uint8Array([1, 2]));
  assert.deepEqual(f.server().sent, [new Uint8Array([1, 2])]);
  await revoke(f, grant);
  assert.equal(upstream.closed, true);
  assert.equal(f.server().closed, true);
  await f.issue();
  upstream = new Socket();
  await f.forward(grant, { headers: { upgrade: 'websocket' } });
  f.server().emit('message', 'x'.repeat(MAX_PREVIEW_FRAME_BYTES + 1));
  assert.equal(upstream.closed, true);
  assert.deepEqual(upstream.sent, []);
});

test('project streams follow hard lease and entitlement checks with no new preview TTL', async () => {
  const f = fixture();
  const grant = await f.issue();
  f.setFetch(async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([42])); } })));
  const response = await f.forward(grant);
  const reader = response.body.getReader();
  await reader.read();
  assert.ok([...f.timers.values()].some(timer => timer.at === BASE + 3_600_000));
  f.values.get('machineEntitlement').active = false;
  await f.advance(1000);
  await assert.rejects(reader.read());
  assert.equal(f.previews.active.size, 0);
});

test('private deletion remains idempotent after stop, expiry, lost entitlement and generation replacement', async () => {
  for (const state of ['stopped', 'expired', 'unpaid', 'replaced']) {
    const f = fixture();
    const grant = await f.issue();
    const nextGeneration = new Date(BASE + 1).toISOString();
    const newer = { ...grant, createdAt: nextGeneration };
    // Even a reused project+revision cannot let old cleanup delete a new grant.
    f.values.set('projectBindings', [grant, newer]);
    if (state === 'stopped') f.container.running = false;
    if (state === 'expired') f.values.get('builderMachine').expiresAt = BASE - 1;
    if (state === 'unpaid') f.values.get('machineEntitlement').active = false;
    if (state === 'replaced') f.values.get('builderMachine').createdAt++;
    assert.equal((await revoke(f, grant)).status, 200, state);
    assert.deepEqual(f.values.get('projectBindings'), [newer], state);
    assert.equal((await revoke(f, grant)).status, 200, state);
    assert.deepEqual(f.values.get('projectBindings'), [newer], state);
    assert.equal((await f.manage('DELETE', undefined, `?id=${ID}&revision=${REVISION}`, 'invalid')).status, 400);
  }
});

test('cleanup closes only transports in the exact saved generation, including origin-specific cleanup', async () => {
  const f = fixture();
  const grant = await f.issue();
  const nextGeneration = new Date(BASE + 1).toISOString();
  const sessions = [
    { ...grant, project: true, origin: ORIGIN },
    { ...grant, project: true, origin: 'https://other.example' },
    { ...grant, project: true, origin: ORIGIN, createdAt: nextGeneration },
  ].map(grant => ({ grant, closed: false, close() { this.closed = true; f.previews.active.delete(this); } }));
  for (const session of sessions) f.previews.active.add(session);
  f.container.running = false;
  assert.equal((await revoke(f, grant, ORIGIN)).status, 200);
  assert.deepEqual(sessions.map(session => session.closed), [true, false, false]);
  assert.deepEqual(f.values.get('projectBindings'), [grant]);
  assert.equal((await revoke(f, grant)).status, 200);
  assert.deepEqual(sessions.map(session => session.closed), [true, true, false]);
  assert.deepEqual(f.values.get('projectBindings'), []);
});

