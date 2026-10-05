import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from './router';

function request(method = 'GET', origin: string | null = 'https://mainbrella.com', cookie = true, path = '/containers') {
  return new Request(`https://api.mainbrella.com${path}`, {
    method,
    headers: { ...(origin ? { Origin: origin } : {}), ...(cookie ? { Cookie: 'mainbrella_session=test' } : {}) },
    ...(method === 'POST' ? { body: JSON.stringify({ userId: 'victim', instance: 'standard-2', keepAliveMs: 99999999 }) } : {}),
  });
}

function environment() {
  let userId = 'account-one';
  let machineStatus = 200;
  const names: string[] = [];
  const calls: Request[] = [];
  const env = {
    DB: { prepare() { return { bind() { return { async first() { return { id: userId }; } }; } }; } },
    BUILDER_MACHINE: {
      idFromName(name: string) { names.push(name); return name; },
      get() { return { async fetch(req: Request) {
        calls.push(req);
        return Response.json(machineStatus === 200 ? { containers: [], limits: {}, usage: {} } : { error: 'internal detail' }, { status: machineStatus });
      } }; },
    },
  } as unknown as Env;
  return { env, names, calls, setUser(id: string) { userId = id; }, setStatus(status: number) { machineStatus = status; } };
}

test('container routes require a session and trusted origins for mutations', async () => {
  const {env, calls} = environment();
  assert.equal((await handleRequest(request('OPTIONS', undefined, false), env)).status, 204);
  for (const method of ['GET', 'POST', 'DELETE']) {
    assert.equal((await handleRequest(request(method, undefined, false), env)).status, 401);
    assert.equal((await handleRequest(request(method, 'https://attacker.com'), env)).status, 403);
  }
  for (const method of ['POST', 'DELETE']) assert.equal((await handleRequest(request(method, null), env)).status, 403);
  assert.equal(calls.length, 0);
});

test('all tiers use their own single slot and browser overrides are not forwarded', async () => {
  const state = environment();
  for (const method of ['GET', 'POST', 'DELETE']) {
    const response = await handleRequest(request(method), state.env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://mainbrella.com');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(state.names.at(-1), 'user:account-one');
    const forwarded = state.calls.at(-1)!;
    assert.equal(forwarded.method, method);
    assert.equal(forwarded.url, 'https://internal/container');
    assert.equal(forwarded.headers.get('Cookie'), null);
    assert.equal(await forwarded.text(), '');
  }
  state.setUser('account-two');
  await handleRequest(request('POST'), state.env);
  assert.equal(state.names.at(-1), 'user:account-two');
});

test('arbitrary container IDs and unsupported methods are rejected', async () => {
  const {env, calls} = environment();
  assert.equal((await handleRequest(request('GET', undefined, true, '/containers/victim'), env)).status, 404);
  assert.equal((await handleRequest(request('PATCH'), env)).status, 405);
  assert.equal(calls.length, 0);
});

test('quota errors are preserved and service failures are sanitized', async (t) => {
  t.mock.method(console, 'error', () => {});
  const state = environment();
  state.setStatus(429);
  let response = await handleRequest(request('POST'), state.env);
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), {error:'container_quota_exceeded'});
  state.setStatus(500);
  response = await handleRequest(request('GET'), state.env);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {error:'containers_unavailable'});
  response = await handleRequest(request('GET'), {...state.env, BUILDER_MACHINE: undefined} as unknown as Env);
  assert.equal(response.status, 503);
});
