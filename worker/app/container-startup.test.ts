import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from './router';
import { paidContainerFixture, SESSION_ONE, USER_ONE } from './paid-container-test-helpers';

test('startup settings authenticate the owner, preserve the exact generation and enforce request limits', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  const calls: { name: string; request: Request }[] = [];
  const body = { id: 'small', createdAt: '2026-10-11T00:00:00.000Z', launch: { command: 'npm start', readiness: { port: 3000 } } };
  const env = { ...f.env, WORKSPACE_PERSISTENCE_ENABLED: 'true', CONTAINER_ACCOUNT: {
    idFromName(name: string) { return name; }, get(name: string) { return { async fetch(request: Request) {
      calls.push({ name, request }); return Response.json(body);
    } }; },
  } } as unknown as Env;
  const call = (payload: unknown = body, extra = {}, target = env, path = '/containers/startup', method = 'PATCH') => handleRequest(new Request(`https://api.mainbrella.com${path}`, {
    method, headers: { Origin: 'https://mainbrella.com', Cookie: `mainbrella_session=${SESSION_ONE}`, 'x-mainbrella-user': 'victim', ...extra }, body: JSON.stringify(payload),
  }), target);
  assert.equal((await call()).status, 200);
  assert.equal(calls[0].name, `account:${USER_ONE}`);
  assert.equal(calls[0].request.method, 'PATCH');
  assert.equal(calls[0].request.headers.get('x-mainbrella-user'), USER_ONE);
  assert.deepEqual(await calls[0].request.json(), body);
  assert.equal((await call({ ...body, launch: null })).status, 200);
  assert.deepEqual(await calls[1].request.json(), { ...body, launch: null });
  assert.equal((await call(body, { Authorization: 'Bearer invalid' })).status, 401);
  assert.equal((await call(body, { Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await call(body, {}, env, '/containers/startup?owner=victim')).status, 400);
  assert.equal((await call({ ...body, launch: 'x'.repeat(32769) })).status, 413);
  assert.equal((await call(body, {}, { ...env, WORKSPACE_PERSISTENCE_ENABLED: 'false' })).status, 503);
  assert.equal((await call(body, {}, env, '/containers/startup', 'POST')).status, 405);
  assert.equal(calls.length, 2);
});
