import test from 'node:test';
import assert from 'node:assert/strict';
import { poolFixture } from './pools-test-helpers.mjs';

test('pool creation is durable, bounded, account scoped and idempotent without reserving a guest', async () => {
  const f = poolFixture();
  const first = await f.create(); assert.equal(first.status, 201);
  assert.match(first.data.pool.id, /^pool_/); assert.equal(first.data.pool.ready, 0);
  assert.equal(first.data.pool.expiresAt, new Date(f.now() + 3600000).toISOString());
  assert.equal((await f.ctx.storage.get('containerAccount')).slots.length, 0);
  f.restart();
  assert.equal((await f.create()).data.pool.id, first.data.pool.id);
  assert.equal((await f.create({ name: 'changed' })).status, 409);
  assert.equal((await f.create({ ttlSeconds: 86401 }, 'long')).status, 400);
  assert.equal((await f.create({ targetSize: 6 }, 'large')).status, 409);
  assert.equal((await f.read('/pools', 'GET', undefined, undefined, 'another')).status, 403);
  assert.equal((await f.read('/pools')).data.pools.length, 1);
  assert.equal(f.ctx.storage.alarmAt, f.now() + 1000);
});

test('alarms replenish persisted inventory, concurrent acquisitions claim distinct guests, and deletion retains acquired generations', async () => {
  const f = poolFixture(), { data: { pool } } = await f.create();
  await f.alarm();
  assert.equal((await f.read(`/pools/${pool.id}`)).data.pool.ready, 2);
  assert.equal((await f.read('/containers')).data.usage.starts, 2);
  f.restart();
  const acquisitions = await Promise.all(['first', 'second', 'first'].map(key => f.read(`/pools/${pool.id}/acquire`, 'POST', {}, key)));
  assert.deepEqual(acquisitions.map(result => result.status), [200, 200, 200]);
  assert.notEqual(acquisitions[0].data.container.id, acquisitions[1].data.container.id);
  assert.deepEqual(acquisitions[0].data, acquisitions[2].data);
  assert.equal((await f.read(`/pools/${pool.id}/acquire`, 'POST', {}, 'empty')).data.error, 'pool_empty');
  await f.alarm();
  assert.equal((await f.read(`/pools/${pool.id}`)).data.pool.ready, 2);
  assert.equal((await f.read('/containers')).data.usage.starts, 4);
  const before = (await f.read('/containers')).data.usage.reservedComputeUnitHours;
  assert.equal((await f.read(`/pools/${pool.id}`, 'DELETE')).status, 200);
  const state = await f.read('/containers');
  assert.equal(state.data.containers.length, 2);
  assert.ok(state.data.usage.reservedComputeUnitHours < before);
  assert.deepEqual((await f.read(`/pools/${pool.id}/acquire`, 'POST', {}, 'first')).data, acquisitions[0].data);
  assert.equal((await f.create()).data.error, 'pool_no_longer_exists');
  await f.alarm(); assert.equal((await f.read('/containers')).data.usage.starts, 4);
});

test('TTL expiry and target zero drain inventory without touching acquired guests', async () => {
  const f = poolFixture(), { data: { pool } } = await f.create({ ttlSeconds: 60 });
  await f.alarm();
  const acquired = await f.read(`/pools/${pool.id}/acquire`, 'POST', {}, 'one');
  await f.alarm();
  f.setTime(f.now() + 60001); await f.alarm();
  const status = (await f.read(`/pools/${pool.id}`)).data.pool;
  assert.equal(status.status, 'expired'); assert.equal(status.ready, 0);
  assert.equal((await f.read('/containers')).data.containers.length, 1);
  assert.equal((await f.read('/containers')).data.containers[0].id, acquired.data.container.id);
  assert.equal((await f.read(`/pools/${pool.id}/acquire`, 'POST', {}, 'late')).status, 410);
  assert.equal((await f.read(`/pools/${pool.id}`, 'PATCH', { targetSize: 1 })).status, 410);
  const second = (await f.create({ targetSize: 1 }, 'second')).data.pool;
  await f.alarm(); assert.equal((await f.read(`/pools/${second.id}`)).data.pool.ready, 1);
  assert.equal((await f.read(`/pools/${second.id}`, 'PATCH', { targetSize: 0 })).data.pool.status, 'paused');
  await f.alarm(); assert.equal((await f.read('/containers')).data.containers.length, 1);
});

test('warm inventory consumes normal concurrency limits and does not reserve quota on rejected refill', async () => {
  const f = poolFixture(), { data: { pool } } = await f.create({ targetSize: 5 });
  await f.alarm(); await f.alarm();
  assert.equal((await f.read(`/pools/${pool.id}`)).data.pool.ready, 5);
  await f.read(`/pools/${pool.id}/acquire`, 'POST', {}, 'one');
  await f.alarm();
  const status = (await f.read(`/pools/${pool.id}`)).data.pool;
  assert.equal(status.ready, 4); assert.equal(status.status, 'degraded');
  assert.equal(status.lastError, 'container_limit_exceeded');
  assert.equal((await f.read('/containers')).data.usage.starts, 5);
  assert.ok(f.ctx.storage.alarmAt <= f.now() + 30000);
});

test('recovery from a lost boot response neither duplicates billing reservations nor loses inventory', async () => {
  const f = poolFixture(), { data: { pool } } = await f.create({ targetSize: 1 });
  f.machineFor('owner', 'small').loseStartReply = true;
  await f.alarm(); f.restart();
  assert.equal((await f.read('/containers')).data.usage.starts, 1);
  assert.equal((await f.read(`/pools/${pool.id}`)).data.pool.starting, 1);
  f.setTime(f.now() + 91000); await f.alarm();
  assert.equal((await f.read(`/pools/${pool.id}`)).data.pool.ready, 1);
  assert.equal((await f.read(`/pools/${pool.id}`)).data.pool.status, 'active');
  assert.ok(f.ctx.storage.alarmAt > f.now());
  assert.equal((await f.read('/containers')).data.usage.starts, 1);
  assert.equal(f.machineFor('owner', 'small').ctx.container.starts, 1);
});

test('deleting during dispatch fences a delayed start and never leaves an unowned guest', async () => {
  const f = poolFixture(), { data: { pool } } = await f.create({ targetSize: 1 });
  let release, dispatched;
  const started = new Promise(resolve => { dispatched = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  f.machineFor('owner', 'small').beforeStart = async () => { dispatched(); await gate; };
  const alarm = f.alarm(); await started;
  assert.equal((await f.read(`/pools/${pool.id}`, 'DELETE')).status, 200);
  release(); await alarm;
  assert.equal((await f.read('/containers')).data.containers.length, 0);
  assert.equal(f.machineFor('owner', 'small').ctx.container.running, false);
  assert.equal((await f.read('/pools')).data.pools.length, 0);
});

test('slot replacement and acquisition retries are fenced by reservation and generation', async () => {
  const f = poolFixture(), { data: { pool } } = await f.create({ targetSize: 2 });
  await f.alarm();
  const acquired = (await f.read(`/pools/${pool.id}/acquire`, 'POST', {}, 'one')).data.container;
  const staleWarm = (await f.read('/containers')).data.containers.find(c => c.id !== acquired.id);
  await f.read(`/containers?id=${staleWarm.id}&createdAt=${encodeURIComponent(staleWarm.createdAt)}`, 'DELETE');
  f.setTime(f.now() + 1);
  const replacement = (await f.read('/containers', 'POST', {}, 'replacement')).data.creation;
  assert.equal(replacement.containerId, staleWarm.id);
  await f.read(`/pools/${pool.id}`, 'DELETE');
  assert.equal((await f.read('/containers')).data.containers.length, 2);
  await f.read(`/containers?id=${acquired.id}&createdAt=${encodeURIComponent(acquired.createdAt)}`, 'DELETE');
  assert.equal((await f.read(`/pools/${pool.id}/acquire`, 'POST', {}, 'one')).data.error, 'acquisition_no_longer_running');
});

test('failed pool cleanup stays durable and retries without restarting deleted inventory', async () => {
  const f = poolFixture(), { data: { pool } } = await f.create({ targetSize: 1 });
  await f.alarm(); f.machineFor('owner', 'small').failStop = true;
  assert.equal((await f.read(`/pools/${pool.id}`, 'DELETE')).data.error, 'pool_cleanup_pending');
  assert.equal((await f.ctx.storage.get('managedPools')).pools[0].deleting, true);
  f.restart(); f.machineFor('owner', 'small').failStop = false;
  await f.alarm(); assert.equal((await f.read('/pools')).data.pools.length, 0);
  assert.equal((await f.read('/containers')).data.usage.starts, 1);
});

test('lost paid access stops warm guests and prevents automatic launches; disabled rollout drains them', async () => {
  const f = poolFixture(), { data: { pool } } = await f.create({ targetSize: 1 });
  await f.alarm(); f.setPaid(false);
  await f.read('/pools'); await f.alarm();
  assert.ok(f.ctx.storage.alarmAt >= f.now() + 30000);
  assert.equal((await f.read('/containers')).data.containers.length, 0);
  assert.equal((await f.read('/containers')).data.usage.starts, 1);
  f.setPaid(true); await f.read('/pools'); await f.alarm();
  assert.equal((await f.read(`/pools/${pool.id}`)).data.pool.ready, 1);
  f.disable(); await f.alarm();
  assert.equal((await f.read('/containers')).data.containers.length, 0);
});

test('disabled pool issuance rejects mutations and paused inventory does not schedule refill alarms', async () => {
  const f = poolFixture(); f.disable();
  assert.equal((await f.create()).data.error, 'pools_unavailable');
  f.restart();
  const created = await f.create({ targetSize: 0 });
  const receiptExpiry = f.now() + 86400000;
  assert.equal(f.ctx.storage.alarmAt, receiptExpiry);
  f.setTime(f.now() + 3600001); await f.alarm();
  assert.equal((await f.read(`/pools/${created.data.pool.id}`)).data.pool.status, 'expired');
  assert.equal(f.ctx.storage.alarmAt, receiptExpiry);
});
