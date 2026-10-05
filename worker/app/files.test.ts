import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleRequest } from './router';
import { hashToken } from './auth-core';
import { MAX_FILE_BYTES } from '../../containers/file-contract.js';
import { paidContainerFixture, GENERATION_ONE, GENERATION_TWO, EXPIRES_AT, SESSION_ONE, USER_ONE } from './paid-container-test-helpers';

const bytes = new Uint8Array([0, 128, 255, 192, 10]);
function request(method = 'GET', body: BodyInit | undefined = undefined, headers: Record<string, string> = {},
  query = new URLSearchParams({ id: 'small', createdAt: GENERATION_ONE, path: '/workspace/界 $(literal).bin' }).toString()) {
  return new Request(`https://api.mainbrella.com/containers/files?${query}`, { method, body,
    headers: { Origin: 'https://mainbrella.com', Cookie: `mainbrella_session=${SESSION_ONE}`, ...headers } });
}

test('binary read/write authenticate API keys and sessions, enforce ownership, and strip client secrets', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  f.sqlite.exec(readFileSync(new URL('../../migrations/010_api_keys.sql', import.meta.url), 'utf8'));
  const token = `mb_${'a'.repeat(64)}`;
  const session = 'b'.repeat(64);
  f.sqlite.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(await hashToken(session), USER_ONE, EXPIRES_AT);
  f.sqlite.prepare('INSERT INTO api_keys (id, user_id, name, token_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('key-one', USER_ONE, 'Tests', await hashToken(token), token.slice(0, 11), GENERATION_ONE);
  const original = f.env.USER_CONTAINER;
  const calls: Request[] = [];
  f.env.USER_CONTAINER = { ...original, get(id: DurableObjectId) {
    original.get(id);
    return { async fetch(req: Request) {
      calls.push(req);
      if (req.method === 'PUT') { assert.deepEqual(new Uint8Array(await req.arrayBuffer()), bytes); return Response.json({ path: 'ignored', size: 5 }); }
      return new Response(bytes, { headers: { 'content-type': 'text/html', 'set-cookie': 'private' } });
    } };
  } } as unknown as DurableObjectNamespace;
  const credentials: Record<string, string>[] = [{}, { Authorization: `Bearer ${session}`, Origin: '', Cookie: '' },
    { Authorization: `Bearer ${token}`, Origin: '', Cookie: '', 'x-exec-created-at': 'victim', 'x-user-id': 'victim' }];
  for (const headers of credentials) {
    const write = await handleRequest(request('PUT', bytes, headers), f.env);
    assert.equal(write.status, 200);
    assert.deepEqual(await write.json(), { path: '/workspace/界 $(literal).bin', size: bytes.byteLength });
    const read = await handleRequest(request('GET', undefined, headers), f.env);
    assert.equal(read.status, 200);
    assert.deepEqual(new Uint8Array(await read.arrayBuffer()), bytes);
    assert.equal(read.headers.get('content-type'), 'application/octet-stream');
    assert.equal(read.headers.get('content-disposition'), 'attachment');
    assert.equal(read.headers.get('cache-control'), 'no-store');
    assert.equal(read.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(read.headers.get('set-cookie'), null);
  }
  assert.ok(f.accountNames.every(name => name === 'account:account-one'));
  assert.ok(f.machineNames.every(name => name === 'user:account-one'));
  for (const req of calls) {
    assert.deepEqual([...req.headers.keys()].sort(), ['content-type', 'x-exec-created-at', 'x-exec-expires-at']);
    assert.equal(req.headers.get('x-exec-created-at'), GENERATION_ONE);
    assert.equal(req.headers.get('x-exec-expires-at'), String(Date.parse(EXPIRES_AT)));
    assert.equal(new URL(req.url).searchParams.get('path'), '/workspace/界 $(literal).bin');
  }
  assert.ok(f.accountCalls.every(call => call.request.method === 'GET'));
  f.sqlite.prepare('DELETE FROM api_keys WHERE id = ?').run('key-one');
  assert.equal((await handleRequest(request('PUT', bytes, { Authorization: `Bearer ${token}` }), f.env)).status, 401);
  assert.equal((await handleRequest(request('GET', undefined, { Cookie: '' }), f.env)).status, 401);
  assert.equal((await handleRequest(request('PUT', bytes, { Origin: '' }), f.env)).status, 403);
  assert.equal((await handleRequest(request('GET', undefined, { Origin: 'https://attacker.com' }), f.env)).status, 403);
});

test('files validate paths, query duplication, generations and raw upload limits before calling a machine', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  const query = new URLSearchParams({ id: 'small', createdAt: GENERATION_ONE });
  for (const path of ['', '/', 'relative', '/workspace/', '/workspace/../file', '/workspace/./file', '/workspace//file', '/workspace/\0file', `/${'界'.repeat(1500)}`]) {
    query.set('path', path);
    assert.equal((await handleRequest(request('GET', undefined, {}, query.toString()), f.env)).status, 400);
  }
  query.set('path', '/file');
  for (const invalid of [`${query}&path=/duplicate`, `${query}&userId=victim`, `id=small&path=/file`,
    `id=small&path=/file&createdAt=bad`, `id=victim&path=/file&createdAt=${GENERATION_ONE}`]) {
    assert.equal((await handleRequest(request('GET', undefined, {}, invalid), f.env)).status, 400);
  }
  assert.equal((await handleRequest(request('PUT', new Uint8Array(MAX_FILE_BYTES + 1)), f.env)).status, 413);
  assert.equal((await handleRequest(request('POST'), f.env)).status, 405);
  const preflight = await handleRequest(request('OPTIONS'), f.env);
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('access-control-allow-methods')!, /PUT/);
  assert.equal(f.machineCalls.length, 0);
});

test('file access rejects stale, foreign, starting and expired machines and unavailable billing', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  for (const [id, createdAt] of [['small', GENERATION_TWO], ['c1', GENERATION_ONE]]) {
    assert.equal((await handleRequest(request('GET', undefined, {}, new URLSearchParams({ id, createdAt, path: '/file' }).toString()), f.env)).status, 409);
  }
  f.containers.get(USER_ONE)![0].status = 'starting';
  assert.equal((await handleRequest(request(), f.env)).status, 409);
  f.containers.get(USER_ONE)![0].status = 'running';
  f.containers.get(USER_ONE)![0].expiresAt = GENERATION_ONE;
  assert.equal((await handleRequest(request(), f.env)).status, 409);
  f.containers.get(USER_ONE)![0].expiresAt = EXPIRES_AT;
  f.setBillingMode('unpaid');
  assert.equal((await handleRequest(request(), f.env)).status, 402);
  f.setBillingMode('failure');
  assert.equal((await handleRequest(request(), f.env)).status, 503);
  assert.equal(f.machineCalls.length, 0);
});

test('file errors sanitize private diagnostics while preserving documented errors', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  const original = f.env.USER_CONTAINER;
  for (const [status, privateError, expected] of [[403, 'secret', 'file_access_denied'], [404, 'secret', 'file_not_found'],
    [409, 'not_regular_file', 'not_regular_file'], [409, 'secret', 'container_not_running'],
    [413, 'secret', 'file_too_large'], [429, 'secret', 'execution_limit'], [500, 'secret', 'files_unavailable']]) {
    f.env.USER_CONTAINER = { ...original, get() { return { fetch: async () => Response.json({ error: privateError }, { status: status as number }) }; } } as unknown as DurableObjectNamespace;
    const response = await handleRequest(request(), f.env);
    assert.equal(response.status, status === 500 ? 503 : status);
    assert.deepEqual(await response.json(), { error: expected });
  }
});
