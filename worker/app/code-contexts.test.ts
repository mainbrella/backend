import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from './router';
import { codeContextSchema, codeResultSchema } from './openapi-code-contexts';
import { paidContainerFixture, GENERATION_ONE, GENERATION_TWO, SESSION_ONE, USER_ONE } from './paid-container-test-helpers';

const contextId = 'd688d42a-25ef-4c13-9b28-21a0fde6e163';
const record = { id: contextId, language: 'python', createdAt: GENERATION_ONE, expiresAt: Date.now() + 300_000 };
const query = new URLSearchParams({ id: 'small', createdAt: GENERATION_ONE });
function request(path = '', method = 'GET', body?: object, headers: Record<string, string> = {}) {
  return new Request(`https://api.mainbrella.com/containers/code-contexts${path}?${query}`, { method, body: body && JSON.stringify(body),
    headers: { Origin: 'https://mainbrella.com', Cookie: `mainbrella_session=${SESSION_ONE}`, ...headers } });
}
test('interpreter routes preserve trusted ownership and cleanup remains available during billing outages', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  const calls: Request[] = [], original = f.env.USER_CONTAINER;
  f.env.USER_CONTAINER = { ...original, get(id: DurableObjectId) {
    original.get(id);
    return { async fetch(req: Request) {
      calls.push(req);
      if (new URL(req.url).pathname.endsWith('/execute')) return Response.json({ stdout: '', stderr: '', results: [{ mimeType: 'application/json', data: '42' }], error: null, outputTruncated: false });
      return Response.json(req.method === 'DELETE' ? { closed: true } : req.method === 'GET' ? { contexts: [record] } : record, { status: req.method === 'POST' ? 201 : 200 });
    } };
  } } as unknown as DurableObjectNamespace;
  const created = await handleRequest(request('', 'POST', { language: 'python' }, { 'x-exec-created-at': GENERATION_TWO, 'x-user-id': 'victim' }), f.env);
  assert.equal(created.status, 201); codeContextSchema.parse(await created.json());
  assert.equal(calls[0].headers.get('x-exec-created-at'), GENERATION_ONE);
  assert.equal(calls[0].headers.get('x-user-id'), null); assert.equal(calls[0].headers.get('cookie'), null);
  const executed = await handleRequest(request(`/${contextId}/execute`, 'POST', { code: '42' }), f.env);
  assert.equal(executed.status, 200); codeResultSchema.parse(await executed.json());
  f.setBillingMode('failure');
  assert.equal((await handleRequest(request(), f.env)).status, 200);
  assert.equal((await handleRequest(request(`/${contextId}`, 'DELETE'), f.env)).status, 200);
  assert.equal((await handleRequest(request(`/${contextId}/execute`, 'POST', { code: '42' }), f.env)).status, 503);
  assert.ok(f.machineNames.every(name => name === 'user:account-one'));
});

test('interpreter checks authentication, strict requests, lease and generation before forwarding', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  assert.equal((await handleRequest(request('', 'POST', { language: 'python' }, { Cookie: '' }), f.env)).status, 401);
  assert.equal((await handleRequest(request('', 'POST', { language: 'python' }, { Origin: '' }), f.env)).status, 403);
  assert.equal((await handleRequest(request('', 'POST', { language: 'javascript' }), f.env)).status, 400);
  assert.equal((await handleRequest(request(`/${contextId}/execute`, 'POST', { code: '1', timeoutMs: 60001 }), f.env)).status, 400);
  assert.equal((await handleRequest(request(`/${contextId}/execute`, 'POST', { code: '🦄'.repeat(5000) }), f.env)).status, 400);
  assert.equal((await handleRequest(request('', 'PUT'), f.env)).status, 405);
  f.containers.get(USER_ONE)![0].createdAt = GENERATION_TWO;
  assert.equal((await handleRequest(request('', 'POST', { language: 'python' }), f.env)).status, 409);
  assert.equal(f.machineCalls.length, 0);
});
