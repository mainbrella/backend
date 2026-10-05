import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleRequest } from './router';
import { hashToken } from './auth-core';
import { paidContainerFixture, GENERATION_ONE, GENERATION_TWO, EXPIRES_AT, SESSION_ONE, USER_ONE } from './paid-container-test-helpers';

function request(body: unknown = { command: 'echo hello' }, headers: Record<string, string> = {},
  query = `id=small&createdAt=${GENERATION_ONE}`, method = 'POST') {
  return new Request(`https://api.mainbrella.com/containers/exec?${query}`, { method,
    headers: { Origin: 'https://mainbrella.com', Cookie: `mainbrella_session=${SESSION_ONE}`, ...headers },
    ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
}

test('exec authenticates cookie mutations, Bearer sessions and API keys without forwarding secrets', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  f.sqlite.exec(readFileSync(new URL('../../migrations/010_api_keys.sql', import.meta.url), 'utf8'));
  const token = `mb_${'a'.repeat(64)}`;
  f.sqlite.prepare('INSERT INTO api_keys (id, user_id, name, token_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('key-one', USER_ONE, 'Tests', await hashToken(token), token.slice(0, 11), GENERATION_ONE);
  const original = f.env.USER_CONTAINER;
  const calls: Request[] = [];
  f.env.USER_CONTAINER = { ...original, get(id: DurableObjectId) {
    original.get(id);
    return { async fetch(req: Request) { calls.push(req); return Response.json({ stdout: 'hello\n', stderr: '', exitCode: 0, timedOut: false, outputTruncated: false }); } };
  } } as unknown as DurableObjectNamespace;
  const response = await handleRequest(request({ command: 'echo hello' }, { Authorization: `Bearer ${token}`, Origin: '', 'x-exec-created-at': 'victim', 'x-user-id': 'victim' }), f.env);
  assert.equal(response.status, 200);
  assert.equal((await response.json() as any).stdout, 'hello\n');
  assert.deepEqual(f.accountNames, ['account:account-one']);
  assert.deepEqual(f.machineNames, ['user:account-one']);
  assert.deepEqual([...calls[0].headers.keys()].sort(), ['content-type', 'x-exec-created-at', 'x-exec-expires-at']);
  assert.equal(calls[0].headers.get('x-exec-created-at'), GENERATION_ONE);
  assert.equal(calls[0].headers.get('x-exec-expires-at'), String(Date.parse(EXPIRES_AT)));
  assert.deepEqual(await calls[0].json(), { command: 'echo hello' });
  assert.ok(f.accountCalls.every(call => call.request.method === 'GET'));
  f.sqlite.prepare('DELETE FROM api_keys WHERE id = ?').run('key-one');
  assert.equal((await handleRequest(request(undefined, { Authorization: `Bearer ${token}` }), f.env)).status, 401);
  assert.equal((await handleRequest(request(undefined, { Cookie: '' }), f.env)).status, 401);
  assert.equal((await handleRequest(request(undefined, { Authorization: 'Bearer invalid' }), f.env)).status, 401);
  assert.equal((await handleRequest(request(undefined, { Origin: '' }), f.env)).status, 403);
  assert.equal((await handleRequest(request(undefined, { Origin: 'https://attacker.com' }), f.env)).status, 403);
});

test('exec validates command bytes, timeout, body size and generation before machine calls', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  for (const body of [null, [], {}, 'bad json', { command: '' }, { command: '\0' },
    { command: '界'.repeat(6000) }, { command: 'ls', timeoutMs: 60001 }, { command: 'ls', timeoutMs: 0 },
    { command: 'ls', timeoutMs: 1.5 }, { command: 'ls', cwd: '/other' }]) {
    assert.equal((await handleRequest(request(body), f.env)).status, 400);
  }
  assert.equal((await handleRequest(request('x'.repeat(32769)), f.env)).status, 413);
  for (const query of ['id=small', 'id=small&createdAt=bad', `id=small&id=small&createdAt=${GENERATION_ONE}`, `id=victim&createdAt=${GENERATION_ONE}`, `id=small&createdAt=${GENERATION_ONE}&userId=victim`]) {
    assert.equal((await handleRequest(request(undefined, {}, query), f.env)).status, 400);
  }
  assert.equal((await handleRequest(request(undefined, {}, undefined, 'GET'), f.env)).status, 405);
  assert.equal((await handleRequest(request(undefined, {}, undefined, 'OPTIONS'), f.env)).status, 204);
  assert.equal(f.machineCalls.length, 0);
});

test('exec enforces owned running generations, paid access, and billing availability', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  assert.equal((await handleRequest(request(undefined, {}, `id=small&createdAt=${GENERATION_TWO}`), f.env)).status, 409);
  assert.equal((await handleRequest(request(undefined, {}, `id=c1&createdAt=${GENERATION_ONE}`), f.env)).status, 409);
  f.containers.get(USER_ONE)![0].status = 'starting';
  assert.equal((await handleRequest(request(), f.env)).status, 409);
  f.containers.get(USER_ONE)![0].status = 'running';
  f.setBillingMode('unpaid');
  assert.equal((await handleRequest(request(), f.env)).status, 402);
  f.setBillingMode('failure');
  assert.equal((await handleRequest(request(), f.env)).status, 503);
  assert.equal(f.machineCalls.length, 0);
});

test('private runtime errors are sanitized and expected statuses preserved', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  const original = f.env.USER_CONTAINER;
  for (const status of [409, 429, 500]) {
    f.env.USER_CONTAINER = { ...original, get() { return { fetch: async () => Response.json({ error: 'private credential' }, { status }) }; } } as unknown as DurableObjectNamespace;
    const response = await handleRequest(request(), f.env);
    assert.equal(response.status, status === 500 ? 503 : status);
    assert.deepEqual(await response.json(), { error: status === 409 ? 'container_not_running' : status === 429 ? 'execution_limit' : 'execution_unavailable' });
  }
});
