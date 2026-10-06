import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleRequest } from './router';
import { hashToken } from './auth-core';
import { MAX_FILESYSTEM_BODY_BYTES, MAX_FILESYSTEM_OUTPUT_BYTES } from '../../containers/filesystem-contract.js';
import { paidContainerFixture, GENERATION_ONE, GENERATION_TWO, EXPIRES_AT, SESSION_ONE, USER_ONE } from './paid-container-test-helpers';

const methods: Record<string, string> = { list: 'GET', stat: 'GET', mkdir: 'POST', remove: 'DELETE', move: 'POST', chmod: 'PATCH' };
function request(operation: string, options: Record<string, unknown> = {}, headers: Record<string, string> = {}, identity = { id: 'small', createdAt: GENERATION_ONE }) {
  const params = new URLSearchParams(identity);
  const values: Record<string, unknown> = { path: '/workspace/界 $(literal)', ...options };
  let body;
  if (['mkdir', 'move'].includes(operation)) body = JSON.stringify(values);
  else if (operation === 'chmod') { params.set('path', values.path as string); body = JSON.stringify({ mode: values.mode }); }
  else for (const [key, value] of Object.entries(values)) params.set(key, String(value));
  return new Request(`https://api.mainbrella.com/containers/files/${operation}?${params}`, { method: methods[operation] || 'GET', body,
    headers: { Origin: 'https://mainbrella.com', Cookie: `mainbrella_session=${SESSION_ONE}`, 'Content-Type': 'application/json', ...headers } });
}

test('filesystem routes preserve authenticated ownership and exact generation while stripping untrusted headers', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  f.sqlite.exec(readFileSync(new URL('../../migrations/010_api_keys.sql', import.meta.url), 'utf8'));
  const token = `mb_${'a'.repeat(64)}`;
  f.sqlite.prepare('INSERT INTO api_keys (id, user_id, name, token_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('key-one', USER_ONE, 'Tests', await hashToken(token), token.slice(0, 11), GENERATION_ONE);
  const original = f.env.USER_CONTAINER;
  const calls: Request[] = [];
  f.env.USER_CONTAINER = { ...original, get(id: DurableObjectId) {
    original.get(id);
    return { async fetch(req: Request) {
      calls.push(req);
      const value = await req.json();
      assert.equal((value as { path: string }).path, '/workspace/界 $(literal)');
      return Response.json({ ok: true }, { headers: { 'set-cookie': 'private', 'x-secret': 'private' } });
    } };
  } } as unknown as DurableObjectNamespace;
  const credentials: Record<string, string>[] = [{}, { Authorization: `Bearer ${token}`, Origin: '', Cookie: '', 'x-user-id': 'victim', 'x-exec-created-at': 'victim' }];
  for (const headers of credentials) {
    for (const operation of Object.keys(methods)) {
      const options = operation === 'chmod' ? { mode: '0644' } : operation === 'move' ? { destination: '/workspace/moved' } : {};
      const response = await handleRequest(request(operation, options, headers), f.env);
      assert.equal(response.status, 200, `${operation}: ${await response.clone().text()}`);
      assert.deepEqual(await response.json(), { ok: true });
      assert.equal(response.headers.get('set-cookie'), null); assert.equal(response.headers.get('x-secret'), null);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
  }
  assert.ok(f.accountNames.every(name => name === 'account:account-one'));
  assert.ok(f.machineNames.every(name => name === 'user:account-one'));
  for (const call of calls) {
    assert.equal(call.method, 'POST');
    assert.deepEqual([...call.headers.keys()].sort(), ['content-type', 'x-exec-created-at', 'x-exec-expires-at']);
    assert.equal(call.headers.get('x-exec-created-at'), GENERATION_ONE);
    assert.equal(call.headers.get('x-exec-expires-at'), String(Date.parse(EXPIRES_AT)));
  }
  assert.ok(f.accountCalls.every(call => call.request.method === 'GET'));
  f.sqlite.prepare('DELETE FROM api_keys WHERE id = ?').run('key-one');
  assert.equal((await handleRequest(request('stat', {}, { Authorization: `Bearer ${token}` }), f.env)).status, 401);
});

test('filesystem validates strict paths, query types, modes, bodies and origin policy before a machine call', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  for (const path of ['relative', '/a/../b', '/a/', '/a//b', '/a\0b', `/${'界'.repeat(1500)}`]) assert.equal((await handleRequest(request('stat', { path }), f.env)).status, 400);
  for (const [operation, values] of [['list', { limit: '1e2' }], ['list', { limit: 0 }], ['list', { offset: -1 }], ['list', { limit: 1001 }],
    ['stat', { followSymlinks: 1 }], ['remove', { recursive: 'yes' }], ['remove', { path: '/' }], ['mkdir', { path: '/', recursive: true }],
    ['mkdir', { recursive: 'true' }], ['chmod', { mode: '4755' }], ['move', { destination: '/workspace/界 $(literal)/child' }], ['mkdir', { extra: true }]] as [string, Record<string, unknown>][]) {
    assert.equal((await handleRequest(request(operation, values), f.env)).status, 400, operation);
  }
  const valid = request('list');
  for (const suffix of ['&path=/duplicate', '&userId=victim', '&limit=1&limit=2']) {
    assert.equal((await handleRequest(new Request(valid.url + suffix, valid), f.env)).status, 400);
  }
  assert.equal((await handleRequest(request('mkdir', { path: `/${'x'.repeat(MAX_FILESYSTEM_BODY_BYTES)}` }), f.env)).status, 400);
  assert.equal((await handleRequest(request('mkdir', {}, { Origin: '' }), f.env)).status, 403);
  assert.equal((await handleRequest(request('list', {}, { Origin: 'https://attacker.com' }), f.env)).status, 403);
  assert.equal((await handleRequest(request('list', {}, { Cookie: '' }), f.env)).status, 401);
  const options = await handleRequest(new Request(valid.url, { method: 'OPTIONS', headers: valid.headers }), f.env);
  assert.equal(options.status, 204); assert.match(options.headers.get('access-control-allow-methods')!, /PATCH/);
  assert.equal((await handleRequest(new Request(valid.url, { method: 'POST', headers: valid.headers }), f.env)).status, 405);
  assert.equal((await handleRequest(request('unknown'), f.env)).status, 404);
  assert.equal(f.machineCalls.length, 0);
});

test('filesystem cannot reach foreign, stale, expired, starting or unpaid generations', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  for (const identity of [{ id: 'small', createdAt: GENERATION_TWO }, { id: 'c1', createdAt: GENERATION_ONE }]) {
    assert.equal((await handleRequest(request('list', {}, {}, identity), f.env)).status, 409);
  }
  f.containers.get(USER_ONE)![0].status = 'starting';
  assert.equal((await handleRequest(request('stat'), f.env)).status, 409);
  f.containers.get(USER_ONE)![0].status = 'running'; f.containers.get(USER_ONE)![0].expiresAt = GENERATION_ONE;
  assert.equal((await handleRequest(request('remove'), f.env)).status, 409);
  f.containers.get(USER_ONE)![0].expiresAt = EXPIRES_AT;
  f.setBillingMode('unpaid'); assert.equal((await handleRequest(request('stat'), f.env)).status, 402);
  f.setBillingMode('failure'); assert.equal((await handleRequest(request('stat'), f.env)).status, 503);
  assert.equal(f.machineCalls.length, 0);
});

test('filesystem retains documented errors and sanitizes malformed or oversized runtime responses', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  const original = f.env.USER_CONTAINER;
  for (const [status, error] of [[403, 'file_access_denied'], [404, 'file_not_found'], [409, 'file_exists'], [409, 'directory_not_empty'],
    [409, 'symlink_not_allowed'], [409, 'unsupported_file_name'], [413, 'directory_too_large'], [429, 'execution_limit']] as const) {
    f.env.USER_CONTAINER = { ...original, get() { return { fetch: async () => Response.json({ error, secret: 'private' }, { status }) }; } } as unknown as DurableObjectNamespace;
    const response = await handleRequest(request('list'), f.env);
    assert.equal(response.status, status); assert.deepEqual(await response.json(), { error });
  }
  for (const response of [Response.json({ error: 'private' }, { status: 409 }), new Response('private'), new Response('x'.repeat(MAX_FILESYSTEM_OUTPUT_BYTES + 1))]) {
    f.env.USER_CONTAINER = { ...original, get() { return { fetch: async () => response }; } } as unknown as DurableObjectNamespace;
    const result = await handleRequest(request('list'), f.env);
    assert.equal(result.status, 503); assert.deepEqual(await result.json(), { error: 'files_unavailable' });
  }
});
