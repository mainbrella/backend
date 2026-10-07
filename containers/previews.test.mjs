import test from 'node:test';
import assert from 'node:assert/strict';
import { ContainerPreviews } from './previews.js';
import { UserContainerController } from './user-container-core.js';
import { MAX_PREVIEW_CONNECTIONS, MAX_PREVIEW_FRAME_BYTES, MAX_PREVIEW_GRANTS, validPreviewOptions } from './preview-contract.js';

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
  const previews = new ContainerPreviews(controller, {
    timers: { setTimeout(fn, ms) { const id = {}; timers.set(id, { fn, at: now + ms }); return id; }, clearTimeout(id) { timers.delete(id); } },
    pairFactory() { server = new Socket(); return { 0: new Socket(), 1: server }; },
    responseFactory(webSocket, headers) { return { status: 101, webSocket, headers }; },
  });
  controller.onStopped = () => previews.close();
  const manage = (method = 'GET', body, query = '', generation = GENERATION) => previews.manage(new Request(`https://internal/previews${query}`, {
    method, headers: { 'x-preview-created-at': generation }, body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const issue = async (body = { port: 3000 }) => {
    const response = await manage('POST', body);
    assert.equal(response.status, 201);
    return response.json();
  };
  const forward = (grant, options = {}) => previews.forward(new Request(`https://internal/preview${options.path ?? '/hello?name=test'}`, {
    method: options.method ?? 'GET', body: options.body, signal: options.signal,
    headers: { 'x-preview-token': grant.token, 'x-preview-created-at': grant.createdAt, ...options.headers },
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

test('preview grants reject control ports, unbounded lifetimes and unknown options', async () => {
  const f = fixture();
  for (const body of [{ port: 22 }, { port: 80 }, { port: 443 }, { port: 1023 }, { port: 65536 },
    { port: '3000' }, { port: 3000.5 }, { port: 3000, ttlSeconds: 59 }, { port: 3000, ttlSeconds: 3601 },
    { port: 3000, createdAt: GENERATION }, [], null]) {
    assert.equal(validPreviewOptions(body), false);
    assert.equal((await f.manage('POST', body)).status, 400);
  }
  assert.equal(validPreviewOptions({ port: 1024, ttlSeconds: 60 }), true);
  assert.equal(validPreviewOptions({ port: 65535, ttlSeconds: 3600 }), true);
  assert.equal((await f.manage('POST', { port: 3000 }, '', 'wrong-generation')).status, 409);
  assert.equal((await f.manage('DELETE', undefined, '?previewId=invalid')).status, 400);
  assert.equal((await f.manage('GET', undefined, '?previewId=bad')).status, 400);
  const oversized = await f.previews.manage(new Request('https://internal/previews', { method: 'POST', body: ' '.repeat(1025) }));
  assert.equal(oversized.status, 400);
  assert.equal(f.calls.length, 0);
});

test('grants bind generation and port, retain only hashes, survive restart and remain bounded', async () => {
  const f = fixture();
  const grant = await f.issue();
  assert.match(grant.token, /^[a-f0-9]{48}$/);
  assert.equal(grant.createdAt, GENERATION);
  assert.equal(grant.expiresAt, BASE + 900_000);
  assert.ok(!JSON.stringify([...f.values]).includes(grant.token));
  const listed = await (await f.manage()).json();
  assert.deepEqual(listed.previews, [{ id: grant.id, createdAt: GENERATION, port: 3000, expiresAt: grant.expiresAt }]);
  for (let i = 1; i < MAX_PREVIEW_GRANTS; i++) await f.issue({ port: 3001 });
  assert.equal((await f.manage('POST', { port: 3000 })).status, 429);
  const restarted = new ContainerPreviews(f.controller);
  assert.deepEqual(await (await restarted.manage(new Request('https://internal/previews', { headers: { 'x-preview-created-at': GENERATION } }))).json(),
    await (await f.manage()).json());
  f.values.get('builderMachine').expiresAt = BASE + 60_000;
  assert.ok((await (await f.manage()).json()).previews.every(item => item.expiresAt === BASE + 60_000));
  f.values.get('builderMachine').createdAt++;
  assert.equal((await f.forward(grant)).status, 403);
  assert.deepEqual(await (await f.manage('GET', undefined, '', new Date(BASE + 1).toISOString())).json(), { previews: [] });
});

test('HTTP preserves application path, body and redirect, strips platform credentials and never starts a machine', async () => {
  const f = fixture();
  const grant = await f.issue();
  const response = await f.forward(grant, { method: 'POST', body: new Uint8Array([0, 255]),
    path: '/api/data?q=1', headers: { Authorization: 'Bearer mb_secret', Cookie: 'mainbrella_session=secret',
      'x-mainbrella-user': 'victim', 'x-exec-created-at': 'victim', 'x-terminal-cols': '99', 'x-ssh-created-at': 'victim',
      'x-preview-port': '22', 'x-forwarded-host': 'api.mainbrella.com', 'content-type': 'application/octet-stream' } });
  assert.equal(await response.text(), 'app');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('cache-control'), 'no-store, no-transform');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  const { port, request } = f.calls[0];
  assert.equal(port, 3000);
  assert.equal(request.url, 'http://container/api/data?q=1');
  assert.equal(request.redirect, 'manual');
  assert.deepEqual(new Uint8Array(await request.arrayBuffer()), new Uint8Array([0, 255]));
  assert.deepEqual([...request.headers.keys()], ['content-type']);
  assert.equal(f.previews.active.size, 0);
  assert.equal(f.timers.size, 0);
  f.setFetch(async () => new Response(null, { status: 302, headers: { location: '/next' } }));
  assert.equal((await f.forward(grant)).headers.get('location'), '/next');
  assert.equal((await f.forward({ ...grant, token: 'a'.repeat(48) })).status, 403);
  f.container.running = false;
  assert.equal((await f.forward(grant)).status, 403);
});

test('local runtime forwards localhost host and HTTP protocol only when enabled', async () => {
  const f = fixture();
  const grant = await f.issue();
  const host = `${grant.token}.localhost:8787`;
  const options = { headers: { 'x-preview-origin': `http://${host}` } };
  assert.equal((await f.forward(grant, options)).status, 403);
  f.previews.allowLocal = true;
  const response = await f.forward(grant, options);
  assert.equal(await response.text(), 'app');
  assert.equal(f.calls[0].request.headers.get('host'), host);
  assert.equal(f.calls[0].request.headers.get('x-forwarded-proto'), 'http');
});

test('gateway-attested origin restores app host semantics without trusting client forwarding headers or rewriting Origin', async () => {
  const f = fixture();
  const grant = await f.issue();
  const host = `${grant.token}.preview.example`;
  const origin = `https://${host}`;
  const response = await f.forward(grant, { method: 'POST', body: 'action', headers: {
    'x-preview-origin': origin, host: 'api.mainbrella.com', 'x-forwarded-host': 'attacker.example',
    'x-forwarded-proto': 'http', origin: 'https://other.example', authorization: 'account-secret', cookie: 'account-secret',
  } });
  assert.equal(response.status, 200);
  await response.text();
  const request = f.calls[0].request;
  assert.equal(request.headers.get('host'), host);
  assert.equal(request.headers.get('x-forwarded-host'), host);
  assert.equal(request.headers.get('x-forwarded-proto'), 'https');
  assert.equal(request.headers.get('origin'), 'https://other.example');
  for (const name of ['x-preview-origin', 'x-preview-token', 'x-preview-created-at', 'authorization', 'cookie']) {
    assert.equal(request.headers.get(name), null, name);
  }
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(f.previews.active.size, 0);
});

test('malformed or token-mismatched app origins fail before contacting the guest', async () => {
  const f = fixture();
  const grant = await f.issue();
  const host = `${grant.token}.preview.example`;
  for (const origin of ['', 'https://api.mainbrella.com', `http://${host}`, `https://${host}/`,
    `https://${host}:8443`, `https://${host}?secret=x`, `https://user@${host}`,
    `https://${'a'.repeat(48)}.preview.example`, `https://${grant.token}.mainbrella.com`,
    `https://${grant.token}.apps.mainbrella.com`, `https://${grant.token}.localhost`,
    `https://${grant.token}.-preview.example`, `https://${grant.token}.preview.example.`]) {
    assert.equal((await f.forward(grant, { headers: { 'x-preview-origin': origin } })).status, 403, origin);
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.previews.active.size, 0);
  // Legacy private requests remain compatible during runtime-first rollout.
  assert.equal((await f.forward(grant)).status, 200);
});

test('expiry, revocation and loss of paid access fail closed; revoked grants release capacity', async () => {
  const f = fixture();
  const grant = await f.issue({ port: 3000, ttlSeconds: 60 });
  await f.advance(60_000);
  assert.equal((await f.forward(grant)).status, 403);
  assert.equal((await f.manage('POST', { port: 3000 })).status, 201);
  const next = await f.issue();
  assert.equal((await f.manage('DELETE', undefined, `?previewId=${next.id}`)).status, 200);
  assert.equal((await f.manage('DELETE', undefined, `?previewId=${next.id}`)).status, 200);
  assert.equal((await f.forward(next)).status, 403);
  const paid = await f.issue();
  f.values.get('machineEntitlement').active = false;
  assert.equal((await f.forward(paid)).status, 403);
  assert.equal((await f.manage()).status, 409);
});

test('slow applications cannot block revocation, stop, client abort or connection limits', async () => {
  const f = fixture();
  const grant = await f.issue();
  f.setFetch(() => new Promise(() => {}));
  const pending = Array.from({ length: MAX_PREVIEW_CONNECTIONS }, () => f.forward(grant));
  await until(() => f.previews.active.size === MAX_PREVIEW_CONNECTIONS);
  assert.equal(f.previews.active.size, MAX_PREVIEW_CONNECTIONS);
  assert.equal((await f.forward(grant)).status, 429);
  await f.manage('DELETE', undefined, `?previewId=${grant.id}`);
  assert.ok((await Promise.all(pending)).every(response => response.status === 502));
  assert.equal(f.previews.active.size, 0);
  assert.equal(f.timers.size, 0);
  const next = await f.issue();
  const timeout = f.forward(next);
  await until(() => f.previews.active.size === 1);
  await tick();
  await f.advance(15_000);
  assert.equal((await timeout).status, 502);
  const abort = new AbortController();
  const aborted = f.forward(next, { signal: abort.signal });
  await until(() => f.previews.active.size === 1);
  abort.abort();
  assert.equal((await aborted).status, 502);
  const stopped = f.forward(next);
  await until(() => f.previews.active.size === 1);
  await f.controller.destroy();
  assert.equal((await stopped).status, 502);
  assert.equal(f.previews.active.size, 0);
});

test('revocation aborts an HTTP response that is still streaming', async () => {
  const f = fixture();
  const grant = await f.issue();
  f.setFetch(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); } })));
  const response = await f.forward(grant);
  const reader = response.body.getReader();
  assert.deepEqual((await reader.read()).value, new Uint8Array([1]));
  const pending = reader.read();
  await f.manage('DELETE', undefined, `?previewId=${grant.id}`);
  await assert.rejects(pending, /Preview closed/);
  assert.equal(f.previews.active.size, 0);
});

test('WebSockets relay text/binary and close both ends on revocation, expiry and generation replacement', async () => {
  for (const reason of ['revoke', 'expire', 'replace', 'stop', 'unpaid', 'disconnect']) {
    const f = fixture();
    const grant = await f.issue({ port: 3000, ttlSeconds: 60 });
    const upstream = new Socket();
    f.setFetch(async () => ({ status: 101, webSocket: upstream, headers: new Headers() }));
    const response = await f.forward(grant, { headers: { Upgrade: 'websocket' } });
    assert.equal(response.status, 101);
    f.server().emit('message', 'hello');
    const binary = new Uint8Array([0, 255]).buffer;
    upstream.emit('message', binary);
    assert.deepEqual(upstream.sent, ['hello']);
    assert.deepEqual(f.server().sent, [binary]);
    assert.equal(upstream.binaryType, 'arraybuffer');
    if (reason === 'revoke') await f.manage('DELETE', undefined, `?previewId=${grant.id}`);
    if (reason === 'expire') await f.advance(60_000);
    if (reason === 'replace') { f.values.get('builderMachine').createdAt++; await f.advance(1000); }
    if (reason === 'stop') await f.controller.destroy();
    if (reason === 'unpaid') { f.values.get('machineEntitlement').active = false; await f.advance(1000); }
    if (reason === 'disconnect') f.server().emit('close');
    assert.equal(upstream.closed, true, reason);
    assert.equal(f.server().closed, true, reason);
    assert.equal(f.previews.active.size, 0);
    assert.equal(f.timers.size, 0);
  }
});

test('WebSocket traffic renews idle activity, while quiet sockets do not', async () => {
  const f = fixture();
  const grant = await f.issue();
  f.setFetch(async () => ({ status: 101, webSocket: new Socket(), headers: new Headers() }));
  await f.forward(grant, { headers: { Upgrade: 'websocket' } });
  const originalIdle = f.values.get('builderMachine').idleExpiresAt;
  await f.advance(1000);
  assert.equal(f.values.get('builderMachine').idleExpiresAt, originalIdle);
  f.server().emit('message', 'active');
  await tick();
  assert.equal(f.values.get('builderMachine').idleExpiresAt, originalIdle + 1000);
  f.previews.close();
});

test('concurrent grant issuance respects the cap and clips expiry to the hard lease', async () => {
  const f = fixture();
  f.values.get('builderMachine').expiresAt = BASE + 30_000;
  const responses = await Promise.all(Array.from({ length: MAX_PREVIEW_GRANTS + 2 }, () => f.manage('POST', { port: 3000 })));
  assert.equal(responses.filter(response => response.status === 201).length, MAX_PREVIEW_GRANTS);
  assert.equal(responses.filter(response => response.status === 429).length, 2);
  const grant = await responses[0].json();
  assert.equal(grant.expiresAt, BASE + 30_000);
  await f.advance(30_000);
  assert.equal((await f.forward(grant)).status, 403);
});

test('active HTTP streams close when their lease shortens, idle time elapses or generation changes', async () => {
  for (const reason of ['lease', 'idle', 'replace', 'expire', 'unpaid']) {
    const f = fixture();
    const grant = await f.issue({ port: 3000, ttlSeconds: 60 });
    f.setFetch(async () => new Response(new ReadableStream({ start() {} })));
    const response = await f.forward(grant);
    const reader = response.body.getReader();
    const reading = reader.read();
    // Register the rejection before driving the simulated transport timer.
    const rejected = assert.rejects(reading, /Preview closed/);
    if (reason === 'lease') f.values.get('builderMachine').expiresAt = BASE + 500;
    if (reason === 'idle') f.values.get('builderMachine').idleExpiresAt = BASE + 500;
    if (reason === 'replace') f.values.get('builderMachine').createdAt++;
    if (reason === 'unpaid') f.values.get('machineEntitlement').active = false;
    await f.advance(reason === 'expire' ? 60_000 : 1000);
    await rejected;
    assert.equal(f.previews.active.size, 0);
    assert.equal(f.timers.size, 0);
  }
});

test('late upstream responses after revocation are released and do not renew idle time', async () => {
  for (const websocket of [true, false]) {
    const f = fixture();
    const grant = await f.issue();
    let resolve;
    f.setFetch(() => new Promise(done => { resolve = done; }));
    const forwarding = f.forward(grant);
    await until(() => !!resolve);
    await f.manage('DELETE', undefined, `?previewId=${grant.id}`);
    assert.equal((await forwarding).status, 502);
    let canceled = false;
    const socket = new Socket();
    resolve(websocket ? { status: 101, webSocket: socket } : new Response(new ReadableStream({ cancel() { canceled = true; } })));
    await tick();
    assert.equal(websocket ? socket.closed : canceled, true);
    assert.equal(f.previews.active.size, 0);
  }
});

test('oversized WebSocket frames close the bridge without forwarding data', async () => {
  const f = fixture();
  const grant = await f.issue();
  const socket = new Socket();
  f.setFetch(async () => ({ status: 101, webSocket: socket, headers: new Headers() }));
  await f.forward(grant, { headers: { Upgrade: 'websocket' } });
  f.server().emit('message', new Uint8Array(MAX_PREVIEW_FRAME_BYTES + 1).buffer);
  assert.equal(socket.closed, true);
  assert.deepEqual(socket.sent, []);
  assert.equal(f.previews.active.size, 0);
});

test('upstream failures and malformed upgrades return a generic error and release capacity', async () => {
  for (const fetch of [() => { throw new Error('private details'); }, async () => { throw new Error('private details'); },
    async () => ({ status: 101, headers: new Headers() })]) {
    const f = fixture();
    const grant = await f.issue();
    f.setFetch(fetch);
    const response = await f.forward(grant, { headers: { Upgrade: 'websocket' } });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: 'preview_unavailable' });
    assert.equal(f.previews.active.size, 0);
    assert.equal(f.timers.size, 0);
  }
});
