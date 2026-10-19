import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleRequest } from './router';
import { hashToken } from './auth-core';
import { paidContainerFixture, SESSION_ONE, USER_ONE } from './paid-container-test-helpers';
import { managedPoolSchema } from './openapi-pools';
// @ts-expect-error Integration exercises actual JavaScript coordinator and runtime.
import { poolFixture } from '../../containers/pools-test-helpers.mjs';

const headers = { Origin: 'https://mainbrella.com', Cookie: `mainbrella_session=${SESSION_ONE}`, 'Idempotency-Key': 'create' };
const payload = { name: 'Agent workers', targetSize: 1, ttlSeconds: 3600 };
const poolId = `pool_${'a'.repeat(8)}-${'a'.repeat(4)}-${'a'.repeat(4)}-${'a'.repeat(4)}-${'a'.repeat(12)}`;

test('pool routes require authentication, origins, keys, rollout enablement, bounded bodies and trusted selection fields', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  const call = (method = 'POST', body: unknown = payload, overrides: Record<string, string> = {}, path = '/pools') => handleRequest(new Request(`https://api.mainbrella.com${path}`, {
    method, headers: { ...headers, ...overrides }, ...(['POST', 'PATCH'].includes(method) ? { body: JSON.stringify(body) } : {}),
  }), f.env);
  assert.equal((await call()).status, 503);
  f.env.MANAGED_POOLS_ENABLED = 'true';
  assert.equal((await call('POST', payload, { Cookie: '' })).status, 401);
  assert.equal((await call('POST', payload, { Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await call('POST', payload, { Origin: '' })).status, 403);
  assert.equal((await call('POST', payload, { 'Idempotency-Key': '' })).status, 400);
  for (const body of [null, [], { ...payload, ttlSeconds: 59 }, { ...payload, ttlSeconds: 86401 }, { ...payload, targetSize: 21 },
    { ...payload, userId: 'victim' }, { ...payload, imageKey: 'private' }, { ...payload, lifecycle: 'production' },
    { ...payload, internet: 'false' }, { ...payload, size: 'huge' }]) assert.equal((await call('POST', body)).status, 400, JSON.stringify(body));
  assert.equal((await call('POST', { ...payload, internet: false })).status, 503);
  assert.equal((await call('POST', { ...payload, catalogId: 'missing' })).status, 404);
  assert.equal((await call('PATCH', { ttlSeconds: 3600 }, {}, `/pools/${poolId}`)).status, 400);
  assert.equal((await call('POST', { command: 'unsafe' }, {}, `/pools/${poolId}/acquire`)).status, 400);
  assert.equal((await call('GET', undefined, {}, '/pools?owner=victim')).status, 400);
  assert.equal((await call('PUT')).status, 405);
  assert.equal((await call('POST', { ...payload, name: 'x'.repeat(65536) })).status, 413);
  assert.equal(f.accountCalls.length, 0);
  assert.equal((await call()).status, 200);
  const forwarded = f.accountCalls.at(-1)!.request;
  assert.equal(forwarded.headers.get('x-mainbrella-user'), USER_ONE);
  assert.equal(forwarded.headers.get('Idempotency-Key'), 'create');
  assert.deepEqual(await forwarded.json(), { ...payload, selection: { size: 'lite', internet: true, catalogId: 'node' }, launch: { size: 'lite', internet: true, imageKey: 'terminal', imageName: 'Node 24 + TypeScript' } });
});

test('pool deletion remains accessible during billing outages and disabled issuance', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close()); f.setBillingMode('failure');
  const response = await handleRequest(new Request(`https://api.mainbrella.com/pools/${poolId}`, { method: 'DELETE', headers }), f.env);
  assert.equal(response.status, 200);
  assert.equal(f.accountCalls.at(-1)!.request.headers.get('x-mainbrella-plan'), '');
  assert.equal(f.accountCalls.at(-1)!.request.url, `https://internal/pools/${poolId}`);
});

test('JavaScript SDK creates and acquires through the real HTTP handler, persistent coordinator and guest lifecycle', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  const runtime = poolFixture(); runtime.setTime(Date.now());
  f.env.MANAGED_POOLS_ENABLED = 'true';
  f.env.CONTAINER_ACCOUNT = { idFromName(name: string) { return name; }, get(name: string) {
    assert.equal(name, `account:${USER_ONE}`); return { fetch: (request: Request) => runtime.fetch(request) };
  } } as unknown as Env['CONTAINER_ACCOUNT'];
  const token = `mb_${'b'.repeat(64)}`;
  f.sqlite.exec(readFileSync(new URL('../../migrations/010_api_keys.sql', import.meta.url), 'utf8'));
  f.sqlite.prepare('INSERT INTO api_keys (id,user_id,name,token_hash,prefix,created_at) VALUES (?,?,?,?,?,?)')
    .run('pool-key', USER_ONE, 'Pool tests', await hashToken(token), token.slice(0, 11), new Date().toISOString());
  const module = process.env.MAINBRELLA_SDK_MODULE || new URL('../../sdk/javascript/index.js', import.meta.url).href;
  const { Mainbrella } = await import(module);
  const client = new Mainbrella({ apiKey: token, fetch: (input: string, init: RequestInit) => handleRequest(new Request(input, init), f.env) });
  const { pool } = await client.pools.create({ ...payload, idempotencyKey: 'create-sdk' });
  managedPoolSchema.parse(pool);
  assert.deepEqual(pool.selection, { size: 'lite', internet: true, catalogId: 'node' });
  assert.equal((await client.pools.create({ ...payload, idempotencyKey: 'create-sdk' })).pool.id, pool.id);
  await assert.rejects(client.pools.acquire(pool.id, { idempotencyKey: 'empty-sdk' }), { code: 'pool_empty', idempotencyKey: 'empty-sdk' });
  await runtime.alarm(); runtime.restart();
  const sandbox = await client.pools.acquire(pool.id, { idempotencyKey: 'acquire-sdk' });
  assert.equal(sandbox.id, 'small'); assert.equal(sandbox.internet, true); assert.equal(sandbox.catalogId, 'node');
  assert.equal(sandbox.createdAt, (await client.pools.acquire(pool.id, { idempotencyKey: 'acquire-sdk' })).createdAt);
  await runtime.alarm();
  assert.equal((await client.pools.get(pool.id)).pool.ready, 1);
  assert.deepEqual(await client.pools.delete(pool.id), { deleted: true });
  const state = await client.list();
  assert.equal(state.containers.length, 1);
  assert.equal(state.containers[0].id, sandbox.id);
  assert.equal(state.containers[0].createdAt, sandbox.createdAt);
  assert.equal((await client.pools.list()).pools.length, 0);
  await sandbox.delete();
  await assert.rejects(client.pools.acquire(pool.id, { idempotencyKey: 'acquire-sdk' }), { code: 'acquisition_no_longer_running' });
});
