import test from 'node:test';
import assert from 'node:assert/strict';
const { Mainbrella } = await import(process.env.MAINBRELLA_SDK_MODULE || './index.js');
const id = 'pool_a12d8bf6-12dc-4f4b-9aa1-7a1f174683a4';
const generation = '2026-10-11T08:00:00.000Z';

test('managed pool clients retain keys on uncertain creation and acquisition and preserve sandbox policy', async () => {
  const calls = [];
  let unavailable = true;
  const client = new Mainbrella({ apiKey: `mb_${'a'.repeat(64)}`, fetch: async (url, options) => {
    calls.push({ path: url.pathname, method: options.method, key: options.headers['Idempotency-Key'], body: options.body });
    if (unavailable) { unavailable = false; throw new Error('private transport diagnostics'); }
    if (url.pathname.endsWith('/acquire')) return Response.json({ poolId: id, container: { id: 'c1', createdAt: generation,
      status: 'running', internet: false, networkPolicy: { allow: ['example.com'] }, secretBindings: ['sec-owned'], imageDigest: 'sha256:owned' } });
    return Response.json({ pool: { id } });
  } });
  const options = { name: 'Workers', targetSize: 2, ttlSeconds: 600, catalogId: 'node', idempotencyKey: 'pool-request' };
  await assert.rejects(client.pools.create(options), { code: 'transport_unavailable', idempotencyKey: 'pool-request' });
  await client.pools.create(options);
  assert.deepEqual(calls[0], calls[1]);
  assert.deepEqual(JSON.parse(calls[1].body), { name: 'Workers', targetSize: 2, ttlSeconds: 600, catalogId: 'node' });
  unavailable = true;
  await assert.rejects(client.pools.acquire(id, { idempotencyKey: 'claim-request' }), { code: 'transport_unavailable', idempotencyKey: 'claim-request' });
  const sandbox = await client.pools.acquire(id, { idempotencyKey: 'claim-request' });
  assert.deepEqual(calls[2], calls[3]);
  assert.equal(sandbox.id, 'c1'); assert.equal(sandbox.createdAt, generation);
  assert.equal(sandbox.internet, false); assert.deepEqual(sandbox.networkPolicy, { allow: ['example.com'] });
  assert.deepEqual(sandbox.secretBindings, ['sec-owned']); assert.equal(sandbox.imageDigest, 'sha256:owned');
  await client.pools.list(); await client.pools.get(id); await client.pools.update(id, { targetSize: 0 }); await client.pools.delete(id);
  assert.deepEqual(calls.slice(4).map(item => [item.method, item.path]), [['GET', '/pools'], ['GET', `/pools/${id}`], ['PATCH', `/pools/${id}`], ['DELETE', `/pools/${id}`]]);
  assert.throws(() => client.pools.get('../secrets'), { code: 'invalid_pool_identity' });
  await assert.rejects(client.pools.create({ ...options, idempotencyKey: '' }), { code: 'invalid_pool_options' });
});

test('managed pool acquisition rejects unconfirmed ownership, status and generation without losing retry key', async () => {
  for (const response of [null, {}, { poolId: id, container: { id: 'c1', createdAt: generation, status: 'starting' } },
    { poolId: 'another', container: { id: 'c1', createdAt: generation, status: 'running' } },
    { poolId: id, container: { id: 'c1', createdAt: 'invalid', status: 'running' } }]) {
    let count = 0;
    const client = new Mainbrella({ apiKey: `mb_${'a'.repeat(64)}`, fetch: async () => { count++; return Response.json(response); } });
    await assert.rejects(client.pools.acquire(id, { idempotencyKey: 'same-claim' }), error => error.idempotencyKey === 'same-claim');
    assert.equal(count, 1);
  }
});
