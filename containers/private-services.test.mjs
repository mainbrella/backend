import test from 'node:test';
import assert from 'node:assert/strict';
import { PrivateServicesController } from './private-services.js';
import { ContainerPrivateServices, relayPrivateService } from './private-services-runtime.js';
import { UserContainerController } from './user-container-core.js';
import { privateTarget, boundedPrivateBody } from './private-services-contract.js';

const now = Date.now(), generation = new Date(now).toISOString();
class Storage {
  values = new Map();
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async setAlarm() {}
}
function fixture() {
  const machines = new Map(), accountStorage = new Storage(), intercepts = [];
  const account = new PrivateServicesController({ storage: accountStorage }, (user, id) => {
    assert.equal(user, 'alice');
    return machines.get(id).stub;
  });
  const env = { CONTAINER_ACCOUNT: { idFromName: name => { assert.equal(name, 'account:alice'); return name; },
    get: () => ({ fetch: request => request.headers.has('x-private-source-id') ? account.route(request, request.headers.get('x-mainbrella-user')) : account.fetch(request) }) } };
  for (const id of ['small', 'c1', 'c2']) {
    const ctx = { storage: new Storage(), container: { running: true,
      async interceptOutboundHttp(host, handler) { intercepts.push({ id, host, handler }); },
      getTcpPort(port) { return { fetch: request => { item.calls.push({ port, request }); return item.application(request); } }; },
      async setInactivityTimeout() {} } };
    ctx.storage.values.set('builderMachine', { createdAt: now, expiresAt: now + 3600_000, idleExpiresAt: now + 600_000, idleTimeoutMs: 600_000 });
    ctx.storage.values.set('machineEntitlement', { active: true, plan: 'builder', validUntil: now + 3600_000, checkedAt: now });
    ctx.storage.values.set('activityOwner', { userId: 'alice', containerId: id });
    const controller = new UserContainerController(ctx);
    const runtime = new ContainerPrivateServices(controller, props => ({ fetch: req => relayPrivateService(req, env, props) }));
    const item = { ctx, controller, runtime, calls: [], application: async () => Response.json({ users: ['Ada', 'Grace', 'Linus'] }),
      stub: { fetch: req => req.headers.has('x-private-network') ? runtime.forward(req) : runtime.manage(req) } };
    machines.set(id, item);
  }
  const manage = (path, method, body, network) => account.fetch(new Request(`https://internal/private-services/${path}${network ? `?network=${network}` : ''}`,
    { method, headers: { 'x-mainbrella-user': 'alice' }, body: body && JSON.stringify(body) }));
  const attach = (id, name, port, network = 'app', createdAt = generation) => manage('members', 'PUT', { id, createdAt, name, ...(port ? { port } : {}) }, network);
  const call = (id = 'small', url = 'http://api.internal/users', headers) => intercepts.findLast(value => value.id === id).handler.fetch(new Request(url, { headers }));
  return { account, accountStorage, machines, env, intercepts, manage, attach, call };
}
async function connected() {
  const f = fixture();
  assert.equal((await f.manage('networks', 'POST', { name: 'app' })).status, 201);
  assert.equal((await f.attach('small', 'web')).status, 200);
  assert.equal((await f.attach('c1', 'api', 8080)).status, 200);
  return f;
}

test('private routing uses platform source identity, exact application port, and no preview or API key', async () => {
  const f = await connected();
  const response = await f.call('small', 'http://api.internal/users?q=1', {
    'x-private-source-id': 'c2', 'x-private-source-generation': 'attacker', 'x-mainbrella-user': 'mallory', 'x-mainbrella-api-key': 'secret',
    'x-preview-token': 'secret', 'x-forwarded-for': 'attacker', connection: 'x-spoofed', 'x-spoofed': 'attacker', 'x-app-header': 'preserved',
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { users: ['Ada', 'Grace', 'Linus'] });
  const call = f.machines.get('c1').calls[0];
  assert.equal(call.port, 8080);
  assert.equal(call.request.url, 'http://container:8080/users?q=1');
  for (const key of ['x-private-source-id', 'x-mainbrella-user', 'x-preview-token', 'x-mainbrella-api-key', 'x-forwarded-for', 'x-spoofed']) assert.equal(call.request.headers.get(key), null);
  assert.equal(call.request.headers.get('x-app-header'), 'preserved');
  assert.ok(f.intercepts.every(value => value.host === '*.internal'));
  assert.equal(f.machines.get('c1').ctx.storage.values.has('previewGrants'), false);
});

test('network and account isolation deny unauthorized callers without opening destination ports', async () => {
  const f = await connected();
  await f.manage('networks', 'POST', { name: 'other' });
  await f.attach('c2', 'intruder', undefined, 'other');
  assert.equal((await f.call('c2')).status, 403);
  assert.equal(f.machines.get('c1').calls.length, 0);
  assert.equal((await f.account.fetch(new Request('https://internal/private-services/networks', { headers: { 'x-mainbrella-user': 'mallory' } }))).status, 403);
  assert.equal((await relayPrivateService(new Request('http://api.internal'), f.env, null)).status, 403);
  assert.equal((await f.attach('small', 'another', undefined, 'other')).status, 409);
});

test('stopped, expired, revoked, and replaced source/destination generations cannot reuse stale routes', async () => {
  const f = await connected();
  const destination = f.machines.get('c1'), source = f.machines.get('small');
  destination.ctx.container.running = false;
  assert.equal((await f.call()).status, 403);
  destination.ctx.container.running = true;
  const replacement = new Date(now + 1).toISOString();
  destination.ctx.storage.values.get('builderMachine').createdAt = now + 1;
  assert.equal((await f.call()).status, 403);
  assert.equal((await f.attach('c1', 'api', 8080)).status, 409);
  assert.equal((await f.attach('c1', 'api', 8080, 'app', replacement)).status, 200);
  assert.equal((await f.call()).status, 200);
  await f.manage('members', 'DELETE', { id: 'c1', createdAt: generation, name: 'api' }, 'app');
  assert.equal((await f.call()).status, 200);
  source.ctx.container.running = false;
  assert.equal((await f.call()).status, 403);
  source.ctx.container.running = true;
  source.ctx.storage.values.get('builderMachine').createdAt = now + 2;
  assert.equal((await f.call()).status, 403);
  source.ctx.storage.values.get('builderMachine').createdAt = now;
  source.ctx.storage.values.get('builderMachine').expiresAt = now - 1;
  assert.equal((await f.call()).status, 403);
  assert.equal(destination.calls.length, 2);
});

test('registry conflicts, detach, independent lifecycles and empty network deletion', async () => {
  const f = await connected();
  assert.equal((await f.manage('networks', 'POST', { name: 'app' })).status, 409);
  assert.equal((await f.attach('c2', 'api', 9090)).status, 409);
  assert.equal((await f.manage('networks', 'DELETE', undefined, 'app')).status, 409);
  for (const [id, name] of [['small', 'web'], ['c1', 'api']]) await f.manage('members', 'DELETE', { id, createdAt: generation, name }, 'app');
  assert.equal((await f.call()).status, 403);
  assert.ok([...f.machines.values()].every(value => value.ctx.container.running));
  assert.equal((await f.manage('networks', 'DELETE', undefined, 'app')).status, 200);
});

test('response held across a generation replacement is denied; lifecycle lock remains responsive', async () => {
  const f = await connected(), destination = f.machines.get('c1');
  let resolve;
  destination.application = () => new Promise(done => { resolve = done; });
  const pending = f.call();
  while (!resolve) await new Promise(done => setImmediate(done));
  await destination.controller.serialized(() => { destination.ctx.storage.values.get('builderMachine').createdAt = now + 1; });
  resolve(Response.json({ users: ['private'] }));
  assert.equal((await pending).status, 403);
});

test('HTTP target validation, payload limits and redirect behavior', async () => {
  const f = await connected();
  assert.equal(privateTarget({ url: 'http://user@api.internal', headers: new Headers(), method: 'GET' }), null);
  for (const url of ['http://api.internal:8080', 'https://api.internal', 'http://api.other', 'http://api.nested.internal']) {
    assert.equal(privateTarget(new Request(url)), null, url);
    assert.equal((await f.call('small', url)).status, 403);
  }
  assert.equal((await f.call('small', 'http://api.internal', { upgrade: 'websocket' })).status, 403);
  await assert.rejects(boundedPrivateBody(new Response('a'.repeat(1025)).body, 1024), /request_too_large/);
  const destination = f.machines.get('c1');
  destination.application = async () => new Response(null, { status: 302, headers: { location: 'http://other.internal' } });
  const response = await f.call();
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), 'http://other.internal');
  destination.application = async () => new Response('a'.repeat(1024 * 1024 + 1));
  assert.equal((await f.call()).status, 413);
});
