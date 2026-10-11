import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from './router';
import { paidContainerFixture, SESSION_ONE, USER_ONE } from './paid-container-test-helpers';

const generation = { id: 'small', createdAt: '2026-10-11T00:00:00.000Z' };
test('filesystem lifecycle routes authenticate, fence generations, limit bodies and preserve retry keys', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  const forwarded: { name: string; request: Request }[] = [];
  const env = { ...f.env, WORKSPACE_PERSISTENCE_ENABLED: 'true', WORKSPACE_LIFECYCLE_ENABLED: 'true',
    CONTAINER_ACCOUNT: { idFromName(name: string) { return name; }, get(name: string) { return { async fetch(request: Request) {
      forwarded.push({ name, request }); return Response.json({ containers: [], creation: { id: 'receipt' } });
    } }; } } } as unknown as Env;
  const call = (path: string, body: unknown = generation, extra = {}, target = env) => handleRequest(new Request(`https://api.mainbrella.com${path}`, {
    method: 'POST', headers: { Origin: 'https://mainbrella.com', Cookie: `mainbrella_session=${SESSION_ONE}`, 'Idempotency-Key': 'lifecycle-1', ...extra }, body: JSON.stringify(body),
  }), target);
  for (const action of ['stop', 'resume', 'fork']) {
    assert.equal((await call(`/containers/${action}`, generation, { 'x-mainbrella-user': 'victim' })).status, 200);
    const forwardedCall = forwarded.at(-1)!;
    assert.equal(forwardedCall.name, `account:${USER_ONE}`);
    assert.equal(new URL(forwardedCall.request.url).pathname, `/containers/${action}`);
    assert.equal(forwardedCall.request.headers.get('x-mainbrella-user'), USER_ONE);
    assert.equal(forwardedCall.request.headers.get('Idempotency-Key'), 'lifecycle-1');
    assert.deepEqual(await forwardedCall.request.json(), generation);
  }
  const count = forwarded.length;
  assert.equal((await call('/containers/stop', { ...generation, containerSnapshot: { id: 'forged' } })).status, 400);
  assert.equal((await call('/containers/resume', { id: 'small' })).status, 400);
  assert.equal((await call('/containers/fork', generation, { 'Idempotency-Key': '' })).status, 400);
  assert.equal((await call('/containers/fork?user=victim')).status, 400);
  assert.equal((await call('/containers/fork', { ...generation, name: 'x'.repeat(3000) })).status, 413);
  assert.equal((await call('/containers/stop', generation, { Authorization: 'Bearer invalid' })).status, 401);
  assert.equal((await call('/containers/resume', generation, {}, { ...env, WORKSPACE_LIFECYCLE_ENABLED: 'false' })).status, 503);
  assert.equal(forwarded.length, count);
  const capabilities = await (await handleRequest(new Request('https://api.mainbrella.com/capabilities'), env)).json() as any;
  assert.equal(capabilities.persistence.filesystemAfterStop, true);
  assert.equal(capabilities.persistence.filesystemFork, true);
});
