import test from 'node:test';
import assert from 'node:assert/strict';
const { Mainbrella, MainbrellaError, SandboxPool } = await import(process.env.MAINBRELLA_SDK_MODULE || './index.js');

function fixture() {
  const calls = [], containers = [], killed = [];
  let serial = 0, ambiguous = false, cleanupFailure = false;
  const client = {
    async capabilities() { return { containers: { idempotentCreate: true, creationRetentionMs: 86_400_000 } }; },
    async list() { return { containers }; },
    async create(options) {
      calls.push(options);
      if (ambiguous) { ambiguous = false; throw new MainbrellaError('creation_ambiguous', 0, { idempotencyKey: options.idempotencyKey }); }
      const sandbox = { id: `c${++serial}`, createdAt: '2026-10-11T00:00:00.000Z',
        async kill() {
          if (cleanupFailure) { cleanupFailure = false; throw new MainbrellaError('transport_unavailable'); }
          killed.push(this.id);
          const index = containers.findIndex(item => item.id === this.id && item.createdAt === this.createdAt);
          if (index >= 0) containers.splice(index, 1);
        } };
      containers.push({ id: sandbox.id, createdAt: sandbox.createdAt, status: 'running' });
      return sandbox;
    },
  };
  return { client, calls, containers, killed, ambiguous: () => { ambiguous = true; }, cleanupFailure: () => { cleanupFailure = true; } };
}

test('explicit refill serializes parallel callers, respects target, and gives each generation to one consumer', async () => {
  const f = fixture();
  const pool = new SandboxPool(f.client, { targetSize: 2, create: { catalogId: 'python' } });
  await Promise.all([pool.refill(), pool.refill()]);
  assert.equal(f.calls.length, 2);
  const acquired = await Promise.allSettled([pool.acquire(), pool.acquire(), pool.acquire()]);
  assert.deepEqual(acquired.slice(0, 2).map(item => item.value.id), ['c1', 'c2']);
  assert.equal(acquired[2].reason.code, 'pool_empty');
  assert.equal(f.calls.length, 2);
  await pool.refill();
  await pool.close();
  assert.deepEqual(f.killed, ['c3', 'c4']);
  assert.deepEqual(f.containers.map(item => item.id), ['c1', 'c2']);
  await assert.rejects(pool.refill(), { code: 'pool_closed' });
});

test('ambiguous refill and close reuse original creation key and retain failed cleanup for retry', async () => {
  const f = fixture(), pool = new SandboxPool(f.client);
  f.ambiguous();
  await assert.rejects(pool.refill(), { code: 'creation_ambiguous' });
  assert.equal(pool.state.pending.idempotencyKey, f.calls[0].idempotencyKey);
  f.cleanupFailure();
  await assert.rejects(pool.close(), { code: 'transport_unavailable' });
  assert.equal(f.calls[1].idempotencyKey, f.calls[0].idempotencyKey);
  assert.equal(pool.state.available.length, 1);
  await pool.close();
  assert.deepEqual(f.killed, ['c1']);
  assert.equal(pool.state.pending, null);
});

test('acquire discards expired/replaced generations without returning or deleting their replacements', async () => {
  const f = fixture(), pool = new SandboxPool(f.client);
  await pool.refill();
  f.containers[0].createdAt = '2026-10-11T01:00:00.000Z';
  await assert.rejects(pool.acquire(), { code: 'pool_empty' });
  assert.deepEqual(f.killed, []);
  await pool.close();
  assert.equal(f.containers.length, 1);
});

test('pool captures create options and preserves account admission failures with the same key', async () => {
  const options = { networkPolicy: { allow: ['example.com'] } };
  const f = fixture(), pool = new SandboxPool(f.client, { create: options });
  options.networkPolicy.allow.push('attacker.example');
  f.client.create = async options => { f.calls.push(options); throw new MainbrellaError('concurrent_limit', 429); };
  await assert.rejects(pool.refill(), { status: 429 });
  await assert.rejects(pool.refill(), { status: 429 });
  assert.deepEqual(f.calls[0].networkPolicy.allow, ['example.com']);
  assert.equal(f.calls[0].idempotencyKey, f.calls[1].idempotencyKey);
  const client = new Mainbrella({ apiKey: `mb_${'a'.repeat(64)}` });
  assert.ok(client.pool() instanceof SandboxPool);
  for (const options of [{ targetSize: 0 }, { targetSize: 11 }, { create: { idempotencyKey: 'shared' } }, { create: { lifecycle: 'production' } }]) {
    assert.throws(() => client.pool(options), { code: 'invalid_pool_options' });
  }
});

test('pending creates stop before receipt expiry and bound long caller timeouts', async t => {
  const f = fixture();
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const pool = new SandboxPool(f.client, { create: { waitTimeoutMs: 172_800_000 } });
  f.ambiguous();
  await assert.rejects(pool.refill(), { code: 'creation_ambiguous' });
  assert.equal(f.calls[0].waitTimeoutMs, 3_600_000);
  now += 3_600_001;
  await assert.rejects(pool.refill(), { code: 'pool_creation_expired' });
  await assert.rejects(pool.close(), { code: 'pool_creation_expired' });
  assert.equal(f.calls.length, 1);
  assert.equal(pool.state.pending.idempotencyKey, f.calls[0].idempotencyKey);
});

test('lost cleanup responses reconcile through generation inventory before another delete', async () => {
  const f = fixture(), pool = new SandboxPool(f.client);
  const create = f.client.create;
  f.client.create = async options => {
    const sandbox = await create(options), kill = sandbox.kill.bind(sandbox);
    sandbox.kill = async () => { await kill(); throw new MainbrellaError('transport_unavailable'); };
    return sandbox;
  };
  await pool.refill();
  await assert.rejects(pool.close(), { code: 'transport_unavailable' });
  assert.equal(pool.state.available.length, 1);
  await pool.close();
  assert.equal(pool.state.available.length, 0);
  assert.deepEqual(f.killed, ['c1']);
});
