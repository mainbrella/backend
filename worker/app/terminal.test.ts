import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from './router';
import {
  EXPIRES_AT, GENERATION_ONE, GENERATION_TWO, paidContainerFixture,
  SESSION_ONE, SESSION_TWO, USER_ONE,
} from './paid-container-test-helpers';

function request(headers: Record<string, string | null> = {}, query = `createdAt=${GENERATION_ONE}&cols=80&rows=24`, method = 'GET', session = SESSION_ONE) {
  const values = new Headers({ Origin: 'https://mainbrella.com', Cookie: `mainbrella_session=${session}`, Upgrade: 'websocket' });
  for (const [key, value] of Object.entries(headers)) { if (value === null) values.delete(key); else values.set(key, value); }
  return new Request(`https://api.mainbrella.com/containers/terminal?${query}`, { headers: values, method });
}

test('terminal requires a session, explicit trusted Origin, GET and WebSocket upgrade', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  assert.equal((await handleRequest(request({ Cookie: null }), f.env)).status, 401);
  assert.equal((await handleRequest(request({ Cookie: 'mainbrella_session=bad' }), f.env)).status, 401);
  assert.equal((await handleRequest(request({ Origin: null }), f.env)).status, 403);
  assert.equal((await handleRequest(request({ Origin: 'https://attacker.com' }), f.env)).status, 403);
  assert.equal((await handleRequest(request({ Upgrade: null }), f.env)).status, 426);
  assert.equal((await handleRequest(request({}, undefined, 'POST'), f.env)).status, 405);
  assert.equal(f.accountCalls.length, 0);
});

test('terminal routes to the selected paid container and strips browser credentials and overrides', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  const response = await handleRequest(request({ Authorization: 'Bearer secret', 'x-terminal-created-at': 'victim', 'x-user-id': 'victim', 'x-terminal-cols': '999' }), f.env);
  assert.equal(response.status, 101);
  assert.deepEqual(f.accountNames, ['account:account-one']);
  assert.deepEqual(f.machineNames, [`user:${USER_ONE}`]);
  const forwarded = f.machineCalls[0].request;
  assert.deepEqual([...forwarded.headers.keys()].sort(), ['upgrade', 'x-terminal-cols', 'x-terminal-created-at', 'x-terminal-expires-at', 'x-terminal-rows']);
  assert.equal(forwarded.headers.get('x-terminal-created-at'), GENERATION_ONE);
  assert.equal(forwarded.headers.get('x-terminal-cols'), '80');
  assert.equal(forwarded.headers.get('x-terminal-expires-at'), String(Date.parse(EXPIRES_AT)));
  assert.equal(await forwarded.text(), '');
  await handleRequest(request({}, `id=small&createdAt=${GENERATION_ONE}`, 'GET', SESSION_TWO), f.env);
  assert.equal(f.machineNames.at(-1), 'user:account-two');
});

test('multiple containers require an ID, and the requested ID must be owned and running', async t => {
  const f = await paidContainerFixture(t, { [USER_ONE]: [
    { id: 'small', createdAt: GENERATION_ONE, expiresAt: EXPIRES_AT },
    { id: 'c1', createdAt: GENERATION_TWO, expiresAt: EXPIRES_AT },
  ] }); t.after(() => f.close());
  assert.equal((await handleRequest(request(), f.env)).status, 400);
  assert.deepEqual(await (await handleRequest(request({}, `id=victim&createdAt=${GENERATION_ONE}`), f.env)).json(), { error: 'invalid_container_id' });
  assert.equal((await handleRequest(request({}, `id=c1&createdAt=${GENERATION_TWO}`, 'GET', SESSION_TWO), f.env)).status, 409);
  assert.equal((await handleRequest(request({}, `id=c1&createdAt=${GENERATION_ONE}`), f.env)).status, 409);
  const response = await handleRequest(request({}, `id=c1&createdAt=${GENERATION_TWO}`), f.env);
  assert.equal(response.status, 101);
  assert.equal(f.machineNames.at(-1), `user:${USER_ONE}:slot:1`);
  assert.equal(f.machineCalls.at(-1)!.request.headers.get('x-terminal-created-at'), GENERATION_TWO);
});

test('stopped, starting, stale, unpaid and malformed selections cannot open a shell', async t => {
  const f = await paidContainerFixture(t, { [USER_ONE]: [{ id: 'small', createdAt: GENERATION_ONE, expiresAt: EXPIRES_AT }] });
  t.after(() => f.close());
  f.containers.set(USER_ONE, []);
  assert.equal((await handleRequest(request(), f.env)).status, 409);
  f.containers.set(USER_ONE, [{ id: 'small', createdAt: GENERATION_ONE, expiresAt: EXPIRES_AT, status: 'starting' }]);
  assert.equal((await handleRequest(request(), f.env)).status, 409);
  f.containers.set(USER_ONE, [{ id: 'small', createdAt: GENERATION_TWO, expiresAt: EXPIRES_AT, status: 'running' }]);
  assert.equal((await handleRequest(request(), f.env)).status, 409);
  f.setBillingMode('unpaid');
  assert.equal((await handleRequest(request(), f.env)).status, 402);
  f.setBillingMode('paid');
  assert.equal((await handleRequest(request({}, `id=c500&createdAt=${GENERATION_ONE}`), f.env)).status, 400);
  assert.equal(f.machineCalls.length, 0);
});

test('dimensions are finite integers, clamped, and selection parameters rejected', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  for (const extra of ['userId=victim', 'image=other', 'instance=standard-2', 'session=other', 'cols=1&cols=2']) {
    assert.equal((await handleRequest(request({}, `createdAt=${GENERATION_ONE}&${extra}`), f.env)).status, 400);
  }
  for (const value of ['NaN', 'Infinity', '1.2', '1e2', '']) {
    assert.equal((await handleRequest(request({}, `createdAt=${GENERATION_ONE}&cols=${value}`), f.env)).status, 400);
  }
  assert.equal((await handleRequest(request({}, ''), f.env)).status, 400);
  await handleRequest(request({}, `createdAt=${GENERATION_ONE}&cols=9999&rows=-1`), f.env);
  assert.equal(f.machineCalls.at(-1)!.request.headers.get('x-terminal-cols'), '500');
  assert.equal(f.machineCalls.at(-1)!.request.headers.get('x-terminal-rows'), '1');
  await handleRequest(request({}, `createdAt=${GENERATION_ONE}`), f.env);
  assert.equal(f.machineCalls.at(-1)!.request.headers.get('x-terminal-cols'), '80');
  assert.equal(f.machineCalls.at(-1)!.request.headers.get('x-terminal-rows'), '24');
});

test('terminal service errors are sanitized, unpaid access fails closed, and billing outages stay unavailable', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  f.setTerminalStatus(429);
  assert.equal((await handleRequest(request(), f.env)).status, 429);
  f.setTerminalStatus(500);
  assert.deepEqual(await (await handleRequest(request(), f.env)).json(), { error: 'terminal_unavailable' });
  f.setBillingMode('failure');
  assert.equal((await handleRequest(request(), f.env)).status, 503);
  assert.equal((await handleRequest(request(), { ...f.env, USER_CONTAINER: undefined } as unknown as Env)).status, 503);
});
