import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from './router';
import { paidContainerFixture, GENERATION_ONE, GENERATION_TWO, SESSION_ONE, SESSION_TWO } from './paid-container-test-helpers';
import { PrivateServicesController } from '../../containers/private-services.js';

const member = { id: 'small', createdAt: GENERATION_ONE, name: 'api', port: 8080 };
function request(path = 'networks', method = 'GET', body?: unknown, query = '', session = SESSION_ONE, extra: Record<string, string> = {}) {
  return new Request(`https://api.mainbrella.com/private-services/${path}${query}`, { method,
    headers: { Origin: 'https://mainbrella.com', Cookie: `mainbrella_session=${session}`, ...extra },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
}
async function fixture(t: TestContext) {
  const f = await paidContainerFixture(t);
  t.after(() => f.close());
  f.env.PRIVATE_SERVICES_ENABLED = 'true';
  const calls: { user: string; id: string; request: Request }[] = [];
  const accounts = new Map<string, PrivateServicesController>();
  const original = f.env.CONTAINER_ACCOUNT;
  f.env.CONTAINER_ACCOUNT = { idFromName: (name: string) => name, get: (name: string) => ({ fetch: (req: Request) => {
    if (!new URL(req.url).pathname.startsWith('/private-services/')) return (original.get as any)(name).fetch(req);
    let account = accounts.get(name);
    if (!account) {
      const values = new Map<string, unknown>();
      account = new PrivateServicesController({ storage: { async get(key: string) { return structuredClone(values.get(key)); },
        async put(key: string, value: unknown) { values.set(key, structuredClone(value)); } } as DurableObjectStorage },
      (user: string, id: string) => ({ async fetch(internal: Request) {
        calls.push({ user, id, request: internal });
        if (internal.method === 'PUT') return Response.json({ configured: true });
        return Response.json({ running: true, createdAt: user === 'account-one' ? GENERATION_ONE : GENERATION_TWO });
      } }));
      accounts.set(name, account);
    }
    return account.fetch(req);
  } }) } as unknown as DurableObjectNamespace<import('../index').ContainerAccount>;
  return { ...f, calls };
}

test('Private Services API authenticates owners, preserves raw handler validation, and hides runtime headers', async t => {
  const f = await fixture(t);
  assert.equal((await handleRequest(request('networks', 'POST', { name: 'demo' }), f.env)).status, 201);
  const response = await handleRequest(request('members', 'PUT', member, '?network=demo', SESSION_ONE,
    { 'x-mainbrella-user': 'account-two', 'x-private-generation': GENERATION_TWO, 'x-private-source-id': 'c2' }), f.env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { network: 'demo', ...member });
  const configured = f.calls.find(call => call.request.method === 'PUT')!;
  assert.equal(configured.user, 'account-one');
  assert.equal(configured.request.headers.get('x-mainbrella-user'), 'account-one');
  assert.equal(configured.request.headers.get('x-private-generation'), GENERATION_ONE);
  assert.equal(configured.request.headers.get('x-private-source-id'), null);
  assert.equal(configured.request.headers.get('Cookie'), null);
  assert.equal((await handleRequest(request('networks', 'GET', undefined, '', SESSION_TWO), f.env)).status, 200);
  const other = await handleRequest(request('members', 'PUT', { ...member, createdAt: GENERATION_TWO }, '?network=demo', SESSION_TWO), f.env);
  assert.equal(other.status, 404);
  assert.deepEqual(await (await handleRequest(request(), f.env)).json(), { networks: [{ name: 'demo', members: [member] }] });
});

test('Private Services validation rejects invalid queries, bodies, stale generations and unauthenticated requests', async t => {
  const f = await fixture(t);
  assert.equal((await handleRequest(request('networks', 'GET', undefined, '', 'invalid'), f.env)).status, 401);
  assert.equal((await handleRequest(request('networks', 'POST', { name: 'demo' }, '', SESSION_ONE, { Origin: 'https://attacker.test' }), f.env)).status, 403);
  assert.equal((await handleRequest(request('networks', 'OPTIONS'), f.env)).status, 204);
  for (const body of ['{', null, {}, { name: 'Bad' }, { name: 'good', extra: true }, ' '.repeat(1025)]) {
    const response = await handleRequest(request('networks', 'POST', body), f.env);
    assert.equal(response.status, typeof body === 'string' && body.length > 1024 ? 413 : 400);
  }
  for (const query of ['', '?network=bad.name', '?network=demo&network=other', '?network=demo&extra=1']) {
    assert.equal((await handleRequest(request('members', 'PUT', member, query), f.env)).status, 400);
  }
  for (const body of [{ ...member, port: 22 }, { ...member, id: 'attacker' }, { ...member, extra: true }]) {
    assert.equal((await handleRequest(request('members', 'PUT', body, '?network=demo'), f.env)).status, 400);
  }
  assert.equal((await handleRequest(request('members', 'PUT', { ...member, createdAt: GENERATION_TWO }, '?network=demo'), f.env)).status, 409);
  assert.equal((await handleRequest(request('route'), f.env)).status, 404);
  assert.equal((await handleRequest(request('networks', 'PATCH'), f.env)).status, 405);
});

test('issuance gating and paid access preserve list/detach/delete cleanup without stopping machines', async t => {
  const f = await fixture(t);
  await handleRequest(request('networks', 'POST', { name: 'demo' }), f.env);
  await handleRequest(request('members', 'PUT', member, '?network=demo'), f.env);
  f.env.PRIVATE_SERVICES_ENABLED = 'false';
  const capabilities = await (await handleRequest(new Request('https://api.mainbrella.com/capabilities'), f.env)).json() as any;
  assert.equal(capabilities.networking.privateServices, false);
  assert.equal((await handleRequest(request('members', 'PUT', member, '?network=demo'), f.env)).status, 503);
  assert.equal((await handleRequest(request('networks', 'POST', { name: 'other' }), f.env)).status, 503);
  assert.equal((await handleRequest(request(), f.env)).status, 200);
  assert.equal((await handleRequest(request('networks', 'DELETE', undefined, '?network=demo'), f.env)).status, 409);
  assert.equal((await handleRequest(request('members', 'DELETE', member, '?network=demo'), f.env)).status, 200);
  assert.equal((await handleRequest(request('networks', 'DELETE', undefined, '?network=demo'), f.env)).status, 200);
  assert.equal(f.containers.get('account-one')?.length, 1);
  f.env.PRIVATE_SERVICES_ENABLED = 'true';
  f.setBillingMode('past_due');
  assert.equal((await handleRequest(request('networks', 'POST', { name: 'unpaid' }), f.env)).status, 402);
});
