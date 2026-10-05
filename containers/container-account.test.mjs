import test from 'node:test';
import assert from 'node:assert/strict';
import { ContainerAccountController, machineName } from './container-account-core.js';
import { UserContainerController } from './user-container-core.js';
import { entitlementHeaders, PLAN_LIMITS } from './plan-policy.js';

class Storage {
  values = new Map(); alarmAt = null;
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async setAlarm(at) { this.alarmAt = at; }
  async deleteAlarm() { this.alarmAt = null; }
}
function fixture() {
  let now = Date.UTC(2026, 9, 5, 12);
  let plan = 'builder';
  let paid = true;
  let validUntil = now + 31 * 86400000;
  const machines = new Map();
  const ctx = { storage: new Storage() };
  const machineFor = (user, id) => {
    const key = machineName(user, id);
    if (!machines.has(key)) {
      const machineCtx = { storage: new Storage(), container: {
        images: { terminal: 'registry.test/image' }, running: false, starts: 0, destroys: 0,
        start() { this.running = true; this.starts++; },
        async setInactivityTimeout() {},
        async exec() { if (this.gate) await this.gate; return { output: async () => ({ exitCode: this.exitCode ?? 0 }) }; },
        async destroy() { this.running = false; this.destroys++; },
      } };
      const controller = new UserContainerController(machineCtx, () => now);
      machines.set(key, { ctx: machineCtx, controller, fetch: req => controller.fetch(req) });
    }
    return machines.get(key);
  };
  let account = new ContainerAccountController(ctx, machineFor, () => now);
  const request = (method = 'GET', id, overrides = {}) => {
    const url = new URL('https://internal/containers');
    if (id) url.searchParams.set('id', id);
    return account.fetch(new Request(url, { method, headers: { 'x-mainbrella-user': 'owner',
      ...entitlementHeaders({ active: paid, plan: paid ? plan : null, validUntil: paid ? validUntil : null, checkedAt: now }), ...overrides } }));
  };
  const read = async (...args) => { const response = await request(...args); return { status: response.status, data: await response.json() }; };
  return { ctx, machines, machineFor, request, read, setPlan(value) { plan = value; }, setPaid(value) { paid = value; },
    setTime(value) { now = value; }, setValidUntil(value) { validUntil = value; }, now: () => now,
    restart() { account = new ContainerAccountController(ctx, machineFor, () => now); }, alarm: () => account.alarm() };
}

test('six concurrent Builder starts reserve five distinct slots and allow parallel readiness', async () => {
  const f = fixture();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  for (const id of ['small', 'c1', 'c2', 'c3', 'c4']) f.machineFor('owner', id).ctx.container.gate = gate;
  const pending = Array.from({ length: 6 }, () => f.request('POST'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal([...f.machines.values()].reduce((sum, machine) => sum + machine.ctx.container.starts, 0), 5);
  const during = await f.read();
  assert.equal(during.data.containers.length, 5);
  assert.ok(during.data.containers.every(c => c.status === 'starting'));
  release();
  const results = await Promise.all(pending);
  assert.equal(results.filter(r => r.status === 200).length, 5);
  assert.equal(results.filter(r => r.status === 409).length, 1);
  const final = await f.read();
  assert.equal(final.data.usage.starts, 5);
  assert.equal(final.data.containers.length, 5);
  assert.equal(new Set(final.data.containers.map(c => c.id)).size, 5);
});

test('unpaid first start returns 402, zero allowance and consumes no start', async () => {
  const f = fixture(); f.setPaid(false);
  const response = await f.read('POST');
  assert.equal(response.status, 402);
  assert.deepEqual(response.data, { error: 'subscription_required' });
  const result = await f.read();
  assert.equal(result.data.plan, null); assert.equal(result.data.active, false);
  assert.equal(result.data.limits.maxContainers, 0); assert.equal(result.data.usage.starts, 0);
  assert.equal([...f.machines.values()].reduce((sum, m) => sum + m.ctx.container.starts, 0), 0);
});

test('monthly quota is shared across slots, survives restart, changes and cancel/resubscribe', async () => {
  const f = fixture();
  for (let i = 0; i < 10; i++) { assert.equal((await f.read('POST')).status, 200); await f.read('DELETE', 'small'); }
  assert.equal((await f.read('POST')).status, 429);
  f.restart(); assert.equal((await f.read('POST')).status, 429);
  f.setPlan('pro'); assert.equal((await f.read('POST')).status, 200);
  f.setTime(f.now() + 1); f.setPaid(false); await f.read();
  f.setTime(f.now() + 1); f.setPaid(true); f.setPlan('builder');
  assert.equal((await f.read('POST')).status, 429);
  assert.equal((await f.read()).data.usage.starts, 11);
  f.setTime(Date.UTC(2026, 10, 1));
  assert.equal((await f.read('POST')).status, 200);
  assert.equal((await f.read()).data.usage.starts, 1);
});

test('downgrade stops excess machines and clamps deadlines while retaining usage', async () => {
  const f = fixture(); f.setPlan('pro');
  for (let i = 0; i < 7; i++) { await f.read('POST'); f.setTime(f.now() + 1); }
  f.setPlan('builder'); const result = await f.read();
  assert.equal(result.data.containers.length, 5); assert.equal(result.data.usage.starts, 7);
  assert.deepEqual(result.data.limits, PLAN_LIMITS.builder);
  assert.ok(result.data.containers.every(c => Date.parse(c.expiresAt) <= Date.parse(c.createdAt) + 3600000));
  assert.equal(f.machines.get('user:owner:slot:6').ctx.container.running, false);
  assert.equal(f.machines.get('user:owner:slot:5').ctx.container.running, false);
  assert.equal((await f.read('POST')).status, 409);
});

test('paid expiration alarm stops all machines without a browser poll', async () => {
  const f = fixture(); f.setValidUntil(f.now() + 60000);
  await f.read('POST'); await f.read('POST');
  f.setTime(f.now() + 60000); await f.alarm();
  assert.ok([...f.machines.values()].every(m => !m.ctx.container.running));
  assert.equal((await f.read()).data.usage.starts, 2);
});

test('individual stop requires an id for multiple slots and cannot stop stale generations', async () => {
  const f = fixture(); await f.read('POST'); await f.read('POST');
  assert.equal((await f.read('DELETE')).status, 400);
  const stop = await f.read('DELETE', 'c1'); assert.equal(stop.data.containers.length, 1);
  assert.equal(stop.data.containers[0].id, 'small'); assert.equal(stop.data.usage.starts, 2);
  assert.equal((await f.read('DELETE', 'c499')).status, 409);
});

test('legacy machine and monthly usage migrate without resetting quota', async () => {
  const f = fixture(); const legacy = f.machineFor('owner', 'small');
  await legacy.ctx.storage.put('builderMachineStarts', { '2026-10': 9 });
  const state = await f.read(); assert.equal(state.data.usage.starts, 9);
  await f.read('POST'); await f.read('DELETE');
  assert.equal((await f.read('POST')).status, 429);
});

test('failed readiness remains charged and pending slot recovers after its deadline', async () => {
  const f = fixture(); f.machineFor('owner', 'small').ctx.container.exitCode = 7;
  assert.equal((await f.read('POST')).status, 503);
  assert.equal((await f.read()).data.usage.starts, 1);
  f.setTime(f.now() + 90000);
  const result = await f.read(); assert.equal(result.data.containers.length, 0); assert.equal(result.data.usage.starts, 1);
});

test('older paid observation cannot reinstate a newer unpaid decision', async () => {
  const f = fixture(); await f.read('POST');
  const older = f.now(); f.setTime(f.now() + 1); f.setPaid(false); await f.read();
  f.setPaid(true);
  const response = await f.read('POST', null, { 'x-mainbrella-checked-at': String(older) });
  assert.equal(response.status, 402); assert.equal((await f.read()).data.usage.starts, 1);
});

test('Pro and Scale have exact concurrency caps and their own session and idle policies', async () => {
  for (const [plan, count] of [['pro', 100], ['scale', 500]]) {
    const f = fixture(); f.setPlan(plan);
    const results = await Promise.all(Array.from({ length: count + 1 }, () => f.request('POST')));
    assert.equal(results.filter(r => r.status === 200).length, count, plan);
    assert.equal(results.filter(r => r.status === 409).length, 1, plan);
    const state = await f.read();
    assert.equal(state.data.containers.length, count); assert.equal(state.data.usage.starts, count);
    assert.deepEqual(state.data.limits, PLAN_LIMITS[plan]);
    for (const machine of f.machines.values()) {
      const metadata = await machine.ctx.storage.get('builderMachine');
      if (!metadata) continue;
      assert.equal(metadata.expiresAt - metadata.createdAt, PLAN_LIMITS[plan].maxSessionMs);
      assert.equal(metadata.idleTimeoutMs, PLAN_LIMITS[plan].idleTimeoutMs);
    }
  }
});

test('paid higher tiers also enforce monthly exhaustion independently of free slots', async () => {
  for (const plan of ['pro', 'scale']) {
    const f = fixture(); f.setPlan(plan); await f.read();
    const saved = await f.ctx.storage.get('containerAccount');
    saved.usage['2026-10'] = PLAN_LIMITS[plan].maxStartsPerMonth;
    await f.ctx.storage.put('containerAccount', saved);
    const response = await f.read('POST');
    assert.equal(response.status, 429); assert.equal(response.data.error, 'container_quota_exceeded');
    assert.equal((await f.read()).data.containers.length, 0);
  }
});

test('revocation while a machine is booting stops the machine and retains its reserved usage', async () => {
  const f = fixture(); let release;
  f.machineFor('owner', 'small').ctx.container.gate = new Promise(resolve => { release = resolve; });
  const boot = f.request('POST'); await new Promise(resolve => setImmediate(resolve));
  f.setTime(f.now() + 1); f.setPaid(false);
  const revoke = f.request('PUT');
  release(); await Promise.all([boot, revoke]);
  const result = await f.read();
  assert.equal(result.data.active, false); assert.equal(result.data.containers.length, 0); assert.equal(result.data.usage.starts, 1);
  assert.equal(f.machines.get('user:owner').ctx.container.running, false);
});

test('cleanup without a live billing lookup stops only the chosen machine', async () => {
  const f = fixture(); await f.read('POST'); await f.read('POST');
  f.setPaid(false);
  const response = await f.read('DELETE', 'c1', { 'x-mainbrella-cleanup': '1' });
  assert.equal(response.status, 200); assert.equal(response.data.containers.length, 1);
  assert.equal(response.data.containers[0].id, 'small');
  assert.equal(f.machines.get('user:owner').ctx.container.running, true);
});

test('one unavailable machine cannot block revocation of the rest and remains retryable', async () => {
  const f = fixture(); await f.read('POST'); await f.read('POST'); await f.read('POST');
  const unavailable = f.machines.get('user:owner:slot:1');
  const original = unavailable.fetch;
  unavailable.fetch = async () => { throw new Error('service_unavailable'); };
  f.setTime(f.now() + 1); f.setPaid(false);
  assert.equal((await f.read('PUT')).status, 503);
  assert.equal(f.machines.get('user:owner').ctx.container.running, false);
  assert.equal(f.machines.get('user:owner:slot:2').ctx.container.running, false);
  const state = await f.ctx.storage.get('containerAccount');
  assert.equal(state.entitlement.active, false); assert.deepEqual(state.slots, ['c1']);
  assert.equal(f.ctx.storage.alarmAt, f.now() + 30000);
  unavailable.fetch = original;
  await f.alarm();
  assert.equal(unavailable.ctx.container.running, false);
  assert.deepEqual((await f.ctx.storage.get('containerAccount')).slots, []);
  assert.equal(f.ctx.storage.alarmAt, null);
});

test('downgrade continues stopping reachable excess despite failed reads and stops', async () => {
  const f = fixture(); f.setPlan('pro');
  for (let i = 0; i < 7; i++) { await f.read('POST'); f.setTime(f.now() + 1); }
  const unknown = f.machines.get('user:owner:slot:6');
  const failedStop = f.machines.get('user:owner:slot:5');
  const readFetch = unknown.fetch;
  const stopFetch = failedStop.fetch;
  unknown.fetch = async request => request.method === 'GET' ? Promise.reject(new Error('unavailable')) : readFetch(request);
  failedStop.fetch = async request => request.method === 'DELETE' ? Promise.reject(new Error('unavailable')) : stopFetch(request);
  f.setPlan('builder');
  assert.equal((await f.read('PUT')).status, 503);
  assert.equal(f.machines.get('user:owner:slot:4').ctx.container.running, false);
  assert.equal(f.machines.get('user:owner:slot:3').ctx.container.running, false);
  assert.equal([...f.machines.values()].filter(machine => machine.ctx.container.running).length, 5);
  const saved = await f.ctx.storage.get('containerAccount');
  assert.equal(saved.entitlement.plan, 'builder'); assert.equal(saved.usage['2026-10'], 7);
  assert.equal(f.ctx.storage.alarmAt, f.now() + 30000);
  unknown.fetch = readFetch; failedStop.fetch = stopFetch;
  await f.alarm();
  assert.equal((await f.read()).data.containers.length, 5);
});

test('expiration during reconciliation denies creation before reserving quota', async () => {
  const f = fixture(); f.setValidUntil(f.now() + 1000);
  await f.read('POST');
  const machine = f.machineFor('owner', 'small'); const original = machine.fetch;
  machine.fetch = async request => {
    if (request.method === 'GET') f.setTime(f.now() + 1000);
    return original(request);
  };
  assert.equal((await f.read('POST')).status, 402);
  assert.equal((await f.ctx.storage.get('containerAccount')).usage['2026-10'], 1);
  assert.equal(machine.ctx.container.starts, 1);
});

test('expiry alarm preserves live observation ordering so a renewed check can recover access', async () => {
  const f = fixture(); const checkedAt = f.now(); f.setValidUntil(checkedAt + 1000);
  await f.read('POST'); f.setTime(checkedAt + 1000); await f.alarm();
  f.setValidUntil(f.now() + 86400000);
  const result = await f.read('POST', undefined, { 'x-mainbrella-checked-at': String(checkedAt + 500) });
  assert.equal(result.status, 200);
  assert.equal(result.data.active, true);
});

test('expiration during status reconciliation returns zero allowance and revokes every slot', async () => {
  const f = fixture(); f.setValidUntil(f.now() + 1000);
  await f.read('POST');
  const machine = f.machineFor('owner', 'small'); const original = machine.fetch;
  machine.fetch = async request => {
    const response = await original(request);
    if (request.method === 'GET') f.setTime(f.now() + 1000);
    return response;
  };
  const status = await f.read();
  assert.equal(status.status, 200);
  assert.equal(status.data.active, false);
  assert.equal(status.data.plan, null);
  assert.equal(status.data.limits.maxContainers, 0);
  assert.equal(status.data.limits.maxStartsPerMonth, 0);
  assert.deepEqual(status.data.containers, []);
  assert.equal(status.data.usage.starts, 1);
  assert.equal(machine.ctx.container.running, false);
});

test('a started machine whose response is lost is recovered without charging another start', async () => {
  const f = fixture(); const machine = f.machineFor('owner', 'small'); const original = machine.fetch;
  machine.fetch = async request => {
    const result = await original(request);
    if (request.method === 'POST') throw new Error('response lost');
    return result;
  };
  assert.equal((await f.read('POST')).status, 503);
  machine.fetch = original; f.restart(); f.setTime(f.now() + 90001); await f.alarm();
  const result = await f.read();
  assert.equal(result.data.containers.length, 1);
  assert.equal(result.data.usage.starts, 1);
  assert.equal(machine.ctx.container.starts, 1);
});

test('downgrade fences an excess reservation before a delayed machine POST arrives', async () => {
  const f = fixture(); f.setPlan('pro');
  for (let i = 0; i < 5; i++) { await f.read('POST'); f.setTime(f.now() + 1); }
  const machine = f.machineFor('owner', 'c5'); const original = machine.fetch;
  let release; const gate = new Promise(resolve => { release = resolve; });
  machine.fetch = async request => { if (request.method === 'POST') await gate; return original(request); };
  const pending = f.request('POST'); await new Promise(resolve => setImmediate(resolve));
  f.setTime(f.now() + 1); f.setPlan('builder');
  const downgraded = await f.read(); assert.equal(downgraded.data.containers.length, 5);
  release(); assert.equal((await pending).status, 409);
  assert.equal(machine.ctx.container.starts, 0);
  assert.equal((await f.read()).data.usage.starts, 6);
  assert.equal([...f.machines.values()].filter(m => m.ctx.container.running).length, 5);
});

test('stopping and reusing a slot fences old delayed dispatches even in the same millisecond', async () => {
  const f = fixture(); const machine = f.machineFor('owner', 'small'); const original = machine.fetch;
  let release; const gate = new Promise(resolve => { release = resolve; }); let posts = 0;
  machine.fetch = async request => { if (request.method === 'POST' && ++posts === 1) await gate; return original(request); };
  const pending = f.request('POST'); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.read('DELETE', 'small')).status, 200);
  assert.equal((await f.read('POST')).status, 200);
  release(); assert.equal((await pending).status, 409);
  const result = await f.read(); assert.equal(result.data.containers.length, 1);
  assert.equal(result.data.usage.starts, 2); assert.equal(machine.ctx.container.starts, 1);
});

test('a late old boot response cannot erase a replacement reservation', async () => {
  const f = fixture(); const machine = f.machineFor('owner', 'small'); const original = machine.fetch;
  let releaseOld; const oldResponse = new Promise(resolve => { releaseOld = resolve; }); let posts = 0;
  machine.fetch = async request => {
    const result = await original(request);
    if (request.method === 'POST' && ++posts === 1) await oldResponse;
    return result;
  };
  const old = f.request('POST'); await new Promise(resolve => setImmediate(resolve));
  await f.read('DELETE', 'small');
  let releaseNew; machine.ctx.container.gate = new Promise(resolve => { releaseNew = resolve; });
  const replacement = f.request('POST'); await new Promise(resolve => setImmediate(resolve));
  releaseOld(); assert.equal((await old).status, 409);
  const state = await f.ctx.storage.get('containerAccount');
  assert.ok(state.pending.small); assert.equal(state.reservations.small, 2);
  releaseNew(); assert.equal((await replacement).status, 200);
});

test('timed recovery fences a delayed dispatch before releasing an empty pending slot', async () => {
  const f = fixture(); const machine = f.machineFor('owner', 'small'); const original = machine.fetch;
  let release; const gate = new Promise(resolve => { release = resolve; });
  machine.fetch = async request => { if (request.method === 'POST') await gate; return original(request); };
  const pending = f.request('POST'); await new Promise(resolve => setImmediate(resolve));
  f.setTime(f.now() + 90001); await f.alarm();
  release(); assert.equal((await pending).status, 409);
  assert.equal(machine.ctx.container.starts, 0);
  assert.equal((await f.read()).data.usage.starts, 1);
});
