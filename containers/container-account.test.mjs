import test from 'node:test';
import assert from 'node:assert/strict';
import { ContainerAccountController, machineName } from './container-account-core.js';
import { UserContainerController } from './user-container-core.js';
import { entitlementHeaders, PLAN_LIMITS } from './plan-policy.js';

class Storage {
  values = new Map(); alarmAt = null;
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) {
    if (typeof key === 'object') for (const [name, entry] of Object.entries(key)) this.values.set(name, structuredClone(entry));
    else this.values.set(key, structuredClone(value));
  }
  async delete(key) {
    if (Array.isArray(key)) return key.reduce((count, name) => count + Number(this.values.delete(name)), 0);
    return this.values.delete(key);
  }
  async list({ prefix, limit, startAfter }) {
    return new Map([...this.values].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).filter(([key]) => key.startsWith(prefix) && (!startAfter || key > startAfter)).slice(0, limit));
  }
  async setAlarm(at) { this.alarmAt = at; }
  async deleteAlarm() { this.alarmAt = null; }
}
function fixture(initialPlan = 'builder', refresh = false, recharge) {
  let now = Date.UTC(2026, 9, 5, 12);
  const prepaid = initialPlan === 'prepaid';
  let plan = prepaid ? 'usage' : initialPlan;
  const invoices = [];
  const invoiceUsage = async entry => { invoices.push(structuredClone(entry)); return 'ii_usage'; };
  let periodStart = Date.UTC(2026, 9, 5, 12);
  let paid = true;
  let validUntil = now + 31 * 86400000;
  const machines = new Map();
  const ctx = { storage: new Storage() };
  const machineFor = (user, id) => {
    const key = machineName(user, id);
    if (!machines.has(key)) {
      const machineCtx = { storage: new Storage(), container: {
        images: { terminal: 'registry.test/image' }, running: false, starts: 0, destroys: 0,
        start(options) { this.running = true; this.starts++; this.startOptions = options; },
        async setInactivityTimeout() {},
        async exec() { if (this.gate) await this.gate; return { output: async () => ({ exitCode: this.exitCode ?? 0 }) }; },
        async destroy() { this.running = false; this.destroys++; },
      } };
      const controller = new UserContainerController(machineCtx, () => now);
      machines.set(key, { ctx: machineCtx, controller, fetch: req => controller.fetch(req) });
    }
    return machines.get(key);
  };
  const refreshEntitlement = refresh ? async () => ({ active: paid, plan: paid ? plan : null, validUntil: paid ? validUntil : null, checkedAt: now, billing: { customerId: 'cus_owner', subscriptionId: 'sub_owner', periodStart, periodEnd: validUntil } }) : undefined;
  const billing = () => prepaid ? { kind: 'prepaid', customerId: 'cus_owner', periodStart: Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1), periodEnd: Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() + 1, 1) }
    : { customerId: 'cus_owner', subscriptionId: 'sub_owner', periodStart, periodEnd: validUntil };
  let account = new ContainerAccountController(ctx, machineFor, () => now, invoiceUsage, refreshEntitlement, recharge);
  const request = (method = 'GET', id, overrides = {}, body) => {
    const url = new URL('https://internal/containers');
    if (id) url.searchParams.set('id', id);
    return account.fetch(new Request(url, { method, headers: { 'x-mainbrella-user': 'owner',
      ...entitlementHeaders({ active: paid, plan: paid ? plan : null, validUntil: paid ? validUntil : null, checkedAt: now, ...(plan === 'usage' ? { billing: billing() } : {}) }), ...overrides }, ...(body ? { body: JSON.stringify(body) } : {}) }));
  };
  const read = async (...args) => { const response = await request(...args); return { status: response.status, data: await response.json() }; };
  const billingRequest = async (body, path = '/billing') => {
    const headers = { 'x-mainbrella-user': 'owner', ...entitlementHeaders({ active: paid, plan, validUntil, checkedAt: now,
      billing: billing() }) };
    const response = await account.fetch(new Request(`https://internal${path}`, { method: body ? 'POST' : 'GET', headers,
      ...(body ? { body: JSON.stringify(body) } : {}) }));
    return { status: response.status, data: await response.json() };
  };
  return { ctx, machines, invoices, billingRequest, machineFor, request, read, setPlan(value) { plan = value; }, setPaid(value) { paid = value; },
    setTime(value) { now = value; }, setValidUntil(value) { validUntil = value; }, setPeriodStart(value) { periodStart = value; }, now: () => now,
    restart() { account = new ContainerAccountController(ctx, machineFor, () => now, invoiceUsage, refreshEntitlement, recharge); }, alarm: () => account.alarm() };
}

const funding = (f, amountCents = 500, overrides = {}) => ({ id: 'pi_funded', customerId: 'cus_owner', amountCents, refundedCents: 0, disputed: false, kind: 'topup', createdAt: f.now(), ...overrides });
const fund = (f, amount = 500, overrides = {}) => f.billingRequest(funding(f, amount, overrides), '/billing/funding');
const walletSettings = (f, input) => f.billingRequest({ customerId: 'cus_owner', ...input }, '/billing/settings');
const production = { lifecycle: 'production', startupCommand: 'npm start', size: 'lite' };

test('prepaid balance reads never provision and an empty wallet cannot start compute', async () => {
  const f = fixture('prepaid');
  assert.equal((await f.billingRequest(undefined, '/billing/balance')).data.balance.balanceCents, 0);
  assert.equal(f.machines.size, 0);
  assert.equal((await f.read('POST')).status, 402);
  assert.equal([...f.machines.values()].reduce((sum, machine) => sum + machine.ctx.container.starts, 0), 0);
});

test('prepaid production requires 24 hours for the full desired fleet and shared concurrent funding', async () => {
  const f = fixture('prepaid');
  await fund(f, 500);
  await walletSettings(f, { spendLimitCents: 100000 });
  // Lite uses one compute unit: each day's allocation costs 48 cents.
  const results = await Promise.all(Array.from({ length: 11 }, () => f.read('POST', undefined, {}, production)));
  assert.equal(results.filter(result => result.status === 200).length, 10);
  assert.equal(results.find(result => result.status === 402).data.error, 'insufficient_production_balance');
  const balance = (await f.billingRequest(undefined, '/billing/balance')).data.balance;
  assert.ok(balance.availableBalanceCents >= 0);
  assert.equal(balance.productionHourlyCents, 20);
});

test('prepaid usage and reserved funds carry across month rollover and eviction without invoices', async () => {
  const f = fixture('prepaid');
  f.setTime(Date.UTC(2026, 9, 31, 23, 58));
  await fund(f, 500); await walletSettings(f, { spendLimitCents: 5000 });
  assert.equal((await f.read('POST', undefined, {}, production)).status, 200);
  f.setTime(f.now() + 60000); await f.alarm();
  const before = (await f.ctx.storage.get('containerAccount')).leases.small.endAt;
  assert.ok(before > Date.UTC(2026, 10, 1));
  f.setTime(Date.UTC(2026, 10, 1, 0, 2)); f.restart(); await f.alarm();
  const state = await f.ctx.storage.get('containerAccount');
  assert.ok(state.wallet.usedUnitMs > 0);
  assert.ok(state.wallet.monthlyUnitMs['2026-10'] > 0);
  assert.ok(state.wallet.monthlyUnitMs['2026-11'] > 0);
  assert.equal(state.wallet.usedUnitMs, 4 * 60000);
  const data = (await f.read()).data;
  assert.ok(data.usage.computeUnitHours > 0);
  assert.ok(data.usage.reservedComputeUnitHours > 0);
  assert.equal(data.usage.computeUnitHours, data.billing.computeUnitHours);
  assert.equal(f.invoices.length, 0);
  assert.equal((await f.billingRequest(undefined, '/billing/balance')).data.balance.balanceCents, 499);
});

test('refunds revoke funded leases and delayed success cannot restore refunded credit', async () => {
  const f = fixture('prepaid'), payment = funding(f);
  await f.billingRequest(payment, '/billing/funding');
  await f.read('POST', undefined, {}, production);
  f.setTime(f.now() + 60000);
  const result = await f.billingRequest({ ...payment, refundedCents: 500 }, '/billing/funding');
  assert.equal(result.status, 200); assert.ok(result.data.balance.balanceCents < 0);
  assert.equal(f.machineFor('owner', 'small').ctx.container.running, false);
  const replay = await f.billingRequest(payment, '/billing/funding');
  assert.equal(replay.data.balance.balanceCents, result.data.balance.balanceCents);
  f.restart(); await f.alarm();
  assert.equal(f.machineFor('owner', 'small').ctx.container.starts, 1);
  await fund(f, 500, { id: 'pi_new' }); await f.alarm();
  assert.equal(f.machineFor('owner', 'small').ctx.container.running, true);
});

test('switching a running legacy service to prepaid replaces its lease with funded wallet runtime', async () => {
  const f = fixture('usage');
  assert.equal((await f.read('POST', undefined, {}, production)).status, 200);
  f.setTime(f.now() + 60000);
  await fund(f);
  assert.equal(f.machineFor('owner', 'small').ctx.container.running, false);
  await f.alarm();
  const migrated = await f.ctx.storage.get('containerAccount');
  assert.equal(migrated.leases.small.billing.kind, 'prepaid');
  assert.equal(migrated.wallet.usedUnitMs, 0);
  f.setTime(f.now() + 60000); await f.alarm();
  assert.equal((await f.ctx.storage.get('containerAccount')).wallet.usedUnitMs, 60000);
});

test('ambiguous automatic recharge retries its durable identity and funds only a verified success', async () => {
  const calls = [];
  let f;
  f = fixture('prepaid', false, async entry => {
    calls.push(structuredClone(entry));
    if (calls.length === 1) throw new Error('lost Stripe response');
    return { status: 'succeeded', paymentIntentId: 'pi_recharge', funding: funding(f, 500, { id: 'pi_recharge' }) };
  });
  await fund(f);
  await walletSettings(f, { spendLimitCents: 5000, autoRecharge: { enabled: true, amountCents: 500, monthlyLimitCents: 1000 } });
  await f.read('POST');
  assert.equal(calls.length, 1);
  assert.equal((await f.billingRequest(undefined, '/billing/balance')).data.balance.autoRecharge.spentCents, 0);
  f.restart(); f.setTime(f.now() + 60000); await f.alarm();
  assert.equal(calls.length, 2); assert.equal(calls[0].identifier, calls[1].identifier);
  assert.equal((await f.billingRequest(undefined, '/billing/balance')).data.balance.autoRecharge.spentCents, 500);
});

test('internet-off creation is immutable, idempotent and propagates the provider switch through the trusted runtime', async () => {
  const f = fixture(), headers = { 'Idempotency-Key': 'offline-generation' };
  const result = await f.read('POST', undefined, headers, { internet: false }); assert.equal(result.status, 200);
  const machine = f.machineFor('owner', 'small'); assert.equal(machine.ctx.container.startOptions.enableInternet, false);
  assert.equal(result.data.containers[0].internet, false);
  f.restart(); const replay = await f.read('POST', undefined, headers, { internet: false }); assert.equal(replay.status, 200);
  assert.equal(replay.data.creation.id, result.data.creation.id); assert.equal(machine.ctx.container.starts, 1);
  for (const selection of [{}, { internet: true }]) assert.equal((await f.read('POST', undefined, headers, selection)).status, 409);
  const wrong = await f.read('POST', undefined, {}, { internet: 'false' }); assert.equal(wrong.status, 400);
  assert.equal((await f.read()).data.usage.starts, 1);
  await f.read('DELETE', 'small'); const next = await f.read('POST', undefined, {}, { internet: true });
  assert.equal(next.status, 200); assert.equal(next.data.containers[0].internet, true); assert.equal(machine.ctx.container.startOptions.enableInternet, true);
});

test('incompatible or malformed private network features fail before quota, compute and idempotency reservation', async () => {
  const f = fixture(), machine = f.machineFor('owner', 'small'), original = machine.fetch;
  for (const response of [Response.json({ error: 'not_found' }, { status: 404 }), Response.json({ protocol: 1, internetControl: false }),
    Response.json({ protocol: 2, internetControl: true }), new Response('x'.repeat(2049)), new Response('{broken')]) {
    machine.fetch = req => new URL(req.url).pathname === '/features' ? Promise.resolve(response) : original(req);
    const result = await f.read('POST', undefined, { 'Idempotency-Key': 'not-reserved' }, { internet: false });
    assert.equal(result.status, 503); assert.equal(result.data.error, 'network_policy_unavailable');
    const state = await f.ctx.storage.get('containerAccount'); assert.equal(state.usage['2026-10'] ?? 0, 0);
    assert.equal(state.computeUsage['2026-10'] ?? 0, 0); assert.deepEqual(state.slots, []);
    assert.equal(await f.ctx.storage.get('creation:not-reserved'), undefined); assert.equal(machine.ctx.container.starts, 0);
  }
  machine.fetch = original;
  assert.equal((await f.read('POST', undefined, { 'Idempotency-Key': 'not-reserved' }, { internet: false })).status, 200);
});

test('default and explicit internet-on retain old creation fingerprints', async () => {
  const f = fixture(); const headers = { 'Idempotency-Key': 'legacy-on' };
  const first = await f.read('POST', undefined, headers); assert.equal(first.status, 200);
  const key = 'creation:legacy-on', record = await f.ctx.storage.get(key);
  record.fingerprint = JSON.stringify(['terminal', null]); await f.ctx.storage.put(key, record);
  assert.equal((await f.read('POST', undefined, headers, { internet: true })).status, 200);
  assert.equal((await f.read('POST', undefined, headers, { internet: false })).status, 409);
});

test('runtime downgrade after feature discovery cannot boot an internet-enabled replacement', async () => {
  const f = fixture(), machine = f.machineFor('owner', 'small'), original = machine.fetch;
  machine.fetch = req => new URL(req.url).pathname === '/container/network-v1' ? Promise.resolve(Response.json({ error: 'not_found' }, { status: 404 })) : original(req);
  const result = await f.read('POST', undefined, {}, { internet: false });
  assert.equal(result.status, 503); assert.equal(result.data.error, 'network_policy_unavailable'); assert.equal(machine.ctx.container.starts, 0);
});

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
  await f.read();
  const seeded = await f.ctx.storage.get('containerAccount');
  seeded.usage['2026-10'] = PLAN_LIMITS.builder.maxStartsPerMonth - 1;
  await f.ctx.storage.put('containerAccount', seeded);
  assert.equal((await f.read('POST')).status, 200);
  await f.read('DELETE', 'small');
  assert.equal((await f.read('POST')).status, 429);
  f.restart(); assert.equal((await f.read('POST')).status, 429);
  f.setPlan('pro'); assert.equal((await f.read('POST')).status, 200);
  f.setTime(f.now() + 1); f.setPaid(false); await f.read();
  f.setTime(f.now() + 1); f.setPaid(true); f.setPlan('builder');
  assert.equal((await f.read('POST')).status, 429);
  assert.equal((await f.read()).data.usage.starts, PLAN_LIMITS.builder.maxStartsPerMonth + 1);
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
  await legacy.ctx.storage.put('builderMachineStarts', { '2026-10': PLAN_LIMITS.builder.maxStartsPerMonth - 1 });
  const state = await f.read(); assert.equal(state.data.usage.starts, PLAN_LIMITS.builder.maxStartsPerMonth - 1);
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


test('keyed concurrent starts and restart retries share a durable operation and one charge', async () => {
  const f = fixture(); let release;
  f.machineFor('owner', 'small').ctx.container.gate = new Promise(resolve => { release = resolve; });
  const headers = { 'Idempotency-Key': 'one-operation' };
  const first = f.request('POST', null, headers);
  await new Promise(resolve => setImmediate(resolve));
  const pending = await f.read('POST', null, headers);
  assert.equal(pending.status, 200);
  assert.equal(pending.data.creation.status, 'starting');
  assert.equal(pending.data.usage.starts, 1);
  release(); const completed = await (await first).json();
  assert.equal(completed.creation.id, pending.data.creation.id);
  assert.equal(completed.creation.status, 'running');
  f.restart();
  const retry = await f.read('POST', null, headers);
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.data.creation, completed.creation);
  assert.equal(retry.data.usage.starts, 1);
  assert.equal(f.machineFor('owner', 'small').ctx.container.starts, 1);
});

test('keyed retries recover lost responses and never dispatch an ambiguous reservation twice', async () => {
  const f = fixture(); const machine = f.machineFor('owner', 'small'); const original = machine.fetch;
  machine.fetch = async request => {
    const result = await original(request);
    if (request.method === 'POST') throw new Error('response lost');
    return result;
  };
  const headers = { 'Idempotency-Key': 'lost-response' };
  assert.equal((await f.read('POST', null, headers)).status, 503);
  f.restart(); machine.fetch = original;
  assert.equal((await f.read('POST', null, headers)).data.creation.status, 'starting');
  f.setTime(f.now() + 90001);
  const retry = await f.read('POST', null, headers);
  assert.equal(retry.data.creation.status, 'running');
  assert.equal(retry.data.usage.starts, 1);
  assert.equal(machine.ctx.container.starts, 1);
});

test('key conflicts, invalid keys, and retries after slot reuse cannot consume another start', async () => {
  const f = fixture(); const headers = { 'Idempotency-Key': '__proto__' };
  const first = await f.read('POST', null, headers);
  assert.equal(first.status, 200);
  const conflict = await f.read('POST', null, headers, { imageKey: 'other' });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.error, 'idempotency_key_conflict');
  for (const key of ['', 'bad key', 'x'.repeat(129), 'a,b']) assert.equal((await f.read('POST', null, { 'Idempotency-Key': key })).status, 400);
  await f.read('DELETE', 'small');
  await f.read('POST');
  const retry = await f.read('POST', null, headers);
  assert.equal(retry.status, 409);
  assert.equal(retry.data.error, 'creation_no_longer_running');
  assert.equal(retry.data.creation.id, first.data.creation.id);
  assert.equal((await f.read()).data.usage.starts, 2);
});

test('failed boot retries remain charged once and become stopped after recovery fences the slot', async () => {
  const f = fixture(); f.machineFor('owner', 'small').ctx.container.exitCode = 7;
  const headers = { 'Idempotency-Key': 'failed-boot' };
  assert.equal((await f.read('POST', null, headers)).status, 503);
  assert.equal((await f.read('POST', null, headers)).data.creation.status, 'starting');
  f.setTime(f.now() + 90001); await f.alarm();
  assert.equal((await f.read('POST', null, headers)).data.error, 'creation_no_longer_running');
  assert.equal((await f.read()).data.usage.starts, 1);
});

test('keys expire after 24 hours and are garbage collected even with no containers', async () => {
  const f = fixture(); const headers = { 'Idempotency-Key': 'reusable' };
  const first = await f.read('POST', null, headers);
  const expiresAt = f.now() + 24 * 60 * 60_000;
  await f.read('DELETE');
  assert.equal(f.ctx.storage.alarmAt, expiresAt);
  f.setTime(expiresAt); await f.alarm();
  assert.equal(await f.ctx.storage.get('creation:reusable'), undefined);
  assert.equal(f.ctx.storage.alarmAt, null);
  const next = await f.read('POST', null, headers);
  assert.equal(next.status, 200);
  assert.notEqual(next.data.creation.id, first.data.creation.id);
  assert.equal(next.data.usage.starts, 2);
});

test('keys belong to the account and retries bypass occupied capacity but retain billing enforcement', async () => {
  const headers = { 'Idempotency-Key': 'same-key' };
  const f = fixture(); const other = fixture();
  const first = await f.read('POST', null, headers);
  const second = await other.read('POST', null, headers);
  assert.notEqual(first.data.creation.id, second.data.creation.id);
  for (let i = 0; i < 4; i++) await f.read('POST');
  assert.equal((await f.read('POST')).status, 409);
  assert.equal((await f.read('POST', null, headers)).status, 200);
  assert.equal((await f.read()).data.usage.starts, 5);
  f.setTime(f.now() + 1); f.setPaid(false);
  assert.equal((await f.read('POST', null, headers)).status, 402);
});


test('retention cleanup pages through expired keys and preserves the next live expiry', async () => {
  const f = fixture(); await f.read();
  const now = f.now();
  const state = await f.ctx.storage.get('containerAccount');
  state.nextCreationExpiry = now;
  await f.ctx.storage.put('containerAccount', state);
  for (let i = 0; i < 1001; i++) await f.ctx.storage.put(`creation:${String(i).padStart(4, '0')}`, { expiresAt: now });
  await f.ctx.storage.put('creation:live', { expiresAt: now + 60000 });
  await f.alarm();
  assert.equal([...f.ctx.storage.values.keys()].filter(key => key.startsWith('creation:')).length, 1);
  assert.equal(f.ctx.storage.alarmAt, now + 60000);
  f.setTime(now + 60000); await f.alarm();
  assert.equal(await f.ctx.storage.get('creation:live'), undefined);
  assert.equal(f.ctx.storage.alarmAt, null);
});

test('same-image retries succeed at monthly quota and failed atomic reservation saves do not boot', async () => {
  const f = fixture(); const headers = { 'Idempotency-Key': 'one-start' };
  assert.equal((await f.read('POST', null, headers)).status, 200);
  const state = await f.ctx.storage.get('containerAccount');
  state.usage['2026-10'] = PLAN_LIMITS.builder.maxStartsPerMonth;
  await f.ctx.storage.put('containerAccount', state);
  assert.equal((await f.read('POST', null, headers, { imageKey: 'terminal', imageName: 'Node' })).status, 200);
  assert.equal((await f.read('POST')).status, 429);

  const fresh = fixture(); const original = fresh.ctx.storage.put.bind(fresh.ctx.storage);
  fresh.ctx.storage.put = async (key, value) => {
    if (typeof key === 'object') throw new Error('storage unavailable');
    return original(key, value);
  };
  assert.equal((await fresh.read('POST', null, headers)).status, 503);
  assert.equal((await fresh.read()).data.usage.starts, 0);
  assert.equal(fresh.machineFor('owner', 'small').ctx.container.starts, 0);
  assert.equal(await fresh.ctx.storage.get('creation:one-start'), undefined);
  fresh.ctx.storage.put = original;
  assert.equal((await fresh.read('POST', null, headers)).status, 200);
  assert.equal((await fresh.read()).data.usage.starts, 1);
});

test('all five sizes reach the runtime on every plan and contribute their weight', async () => {
  const specs = [['lite', 'lite', 1], ['small', 'standard-1', 6], ['medium', 'standard-2', 10], ['large', 'standard-3', 16], ['xl', 'standard-4', 28]];
  for (const plan of ['builder', 'pro', 'scale']) {
    for (const [size, instance, units] of specs) {
      const f = fixture(); f.setPlan(plan);
      const runtime = f.machineFor('owner', 'small').ctx.container;
      const original = runtime.start;
      runtime.start = function(options) { this.options = options; original.call(this); };
      const result = await f.read('POST', undefined, {}, { size });
      assert.equal(result.status, 200, `${plan}/${size}`);
      assert.equal(runtime.options.instance, instance);
      assert.equal(result.data.containers[0].size, size);
      assert.equal(result.data.usage.concurrentComputeUnits, units);
      const allocated = (Date.parse(result.data.containers[0].expiresAt) - f.now()) / 3600000 * units;
      assert.equal(result.data.usage.reservedComputeUnitHours, allocated);
      assert.equal(result.data.usage.availableComputeUnitHours, PLAN_LIMITS[plan].maxComputeUnitHours - allocated);
    }
  }
});

test('weighted capacity serializes simultaneous large launches without spending rejected starts', async () => {
  const f = fixture();
  const results = await Promise.all(Array.from({ length: 5 }, () => f.read('POST', undefined, {}, { size: 'xl' })));
  assert.equal(results.filter(result => result.status === 200).length, 1);
  assert.equal(results.filter(result => result.data.error === 'compute_capacity_exceeded').length, 4);
  const status = await f.read();
  assert.equal(status.data.usage.starts, 1);
  assert.equal(status.data.usage.concurrentComputeUnits, 28);
});

test('size participates in idempotency and invalid sizes spend no budget', async () => {
  const f = fixture();
  assert.equal((await f.read('POST', undefined, {}, { size: 'basic' })).status, 400);
  assert.equal(f.ctx.storage.values.size, 0);
  const headers = { 'Idempotency-Key': 'size-operation' };
  assert.equal((await f.read('POST', undefined, headers, { size: 'small' })).status, 200);
  const before = (await f.read()).data.usage;
  assert.equal((await f.read('POST', undefined, headers, { size: 'medium' })).data.error, 'idempotency_key_conflict');
  assert.equal((await f.read('POST', undefined, headers, { size: 'small' })).status, 200);
  assert.deepEqual((await f.read()).data.usage, before);
});

test('unused runtime is refunded once after confirmed stop and remains correct after restart', async () => {
  const f = fixture();
  const start = f.now();
  await f.read('POST', undefined, {}, { size: 'medium' });
  f.setTime(start + 5 * 60_000);
  const running = await f.read();
  assert.equal(running.data.usage.computeUnitHours, 10 / 12);
  assert.equal(running.data.usage.reservedComputeUnitHours, 10 * 55 / 60);
  const stopped = await f.read('DELETE', 'small');
  assert.ok(Math.abs(stopped.data.usage.computeUnitHours - 10 / 12) < 1e-10);
  assert.equal(stopped.data.usage.reservedComputeUnitHours, 0);
  f.restart();
  assert.deepEqual((await f.read()).data.usage, stopped.data.usage);
  await f.read('POST', undefined, {}, { size: 'lite' });
  assert.equal((await f.read()).data.usage.availableComputeUnitHours, 250 - 10 / 12 - 1);
});

test('remaining budget clamps the hard machine deadline and cannot be extended by terminal activity', async () => {
  const f = fixture(); await f.read();
  const state = await f.ctx.storage.get('containerAccount');
  state.computeUsage['2026-10'] = (250 - 0.1) * 3600000;
  await f.ctx.storage.put('containerAccount', state);
  const result = await f.read('POST', undefined, {}, { size: 'xl' });
  assert.equal(result.status, 200);
  const machine = f.machineFor('owner', 'small');
  const deadline = Date.parse(result.data.containers[0].expiresAt);
  assert.equal(deadline, f.now() + Math.floor(0.1 * 3600000 / 28));
  assert.equal((await f.read('POST')).data.error, 'compute_capacity_exceeded');
  f.setTime(deadline - 1);
  assert.equal(await machine.controller.touchTerminalActivity(result.data.containers[0].createdAt), true);
  assert.equal((await machine.ctx.storage.get('builderMachine')).expiresAt, deadline);
  f.setTime(deadline); await machine.controller.alarm();
  assert.equal(machine.ctx.container.running, false);
  assert.ok((await f.read()).data.usage.computeUnitHours <= 250);
  assert.ok((await f.read()).data.usage.availableComputeUnitHours < 28 / 3600000);
});

test('monthly compute exhaustion denies starts without increasing usage and upgrade retains consumed usage', async () => {
  const f = fixture(); await f.read();
  const state = await f.ctx.storage.get('containerAccount');
  state.computeUsage['2026-10'] = 250 * 3600000;
  await f.ctx.storage.put('containerAccount', state);
  assert.equal((await f.read('POST')).data.error, 'compute_allowance_exhausted');
  assert.equal((await f.read()).data.usage.starts, 0);
  f.restart(); assert.equal((await f.read('POST')).status, 429);
  f.setPlan('pro'); assert.equal((await f.read('POST')).status, 200);
  assert.equal((await f.read()).data.usage.computeUnitHours, 250);
});

test('unreadable machines retain the full budget reservation until successful cleanup', async () => {
  const f = fixture(); await f.read('POST', undefined, {}, { size: 'small' });
  const machine = f.machineFor('owner', 'small');
  const original = machine.fetch;
  machine.fetch = async () => { throw new Error('unavailable'); };
  f.setTime(f.now() + 60_000); f.restart();
  assert.equal((await f.read()).status, 503);
  assert.equal((await f.ctx.storage.get('containerAccount')).computeUsage['2026-10'], 6 * 3600000);
  machine.fetch = original;
  const stopped = await f.read('DELETE', 'small');
  assert.equal(stopped.data.usage.computeUnitHours, 0.1);
  assert.equal(stopped.data.usage.availableComputeUnitHours, 249.9);
});

test('effective downgrade enforces weighted capacity and the smaller runtime budget', async () => {
  const f = fixture(); f.setPlan('scale');
  await f.read('POST', undefined, {}, { size: 'xl' });
  f.setTime(f.now() + 1);
  await f.read('POST', undefined, {}, { size: 'xl' });
  f.setTime(f.now() + 1); f.setPlan('builder');
  const result = await f.read();
  assert.equal(result.status, 200);
  assert.equal(result.data.containers.length, 1); // The retained XL is clamped to Builder's one-hour lease.
  assert.equal(result.data.usage.concurrentComputeUnits, 28);
  assert.ok(result.data.usage.reservedComputeUnitHours <= 28);
  assert.ok(result.data.usage.computeUnitHours < 1);
  assert.ok(result.data.usage.availableComputeUnitHours > 221);
});

test('month boundary enforces budget deadline and the new month starts with a fresh allowance', async () => {
  const f = fixture(); f.setPlan('pro');
  f.setTime(Date.UTC(2026, 9, 31, 23, 59));
  const result = await f.read('POST', undefined, {}, { size: 'large' });
  const boundary = Date.UTC(2026, 10, 1);
  assert.equal(Date.parse(result.data.containers[0].expiresAt), boundary);
  f.setTime(boundary); await f.machineFor('owner', 'small').controller.alarm();
  const status = await f.read();
  assert.equal(status.data.usage.month, '2026-11');
  assert.equal(status.data.usage.computeUnitHours, 0);
  assert.equal(status.data.usage.availableComputeUnitHours, 9000);
  assert.equal((await f.read('POST', undefined, {}, { size: 'xl' })).status, 200);
});

test('legacy running machines acquire a budget without resetting prior starts', async () => {
  const f = fixture();
  await f.read('POST');
  const saved = await f.ctx.storage.get('containerAccount');
  delete saved.leases; delete saved.computeUsage;
  await f.ctx.storage.put('containerAccount', saved);
  f.restart();
  const result = await f.read();
  assert.equal(result.status, 200);
  assert.equal(result.data.containers.length, 1);
  assert.equal(result.data.usage.starts, 1);
  assert.equal(result.data.usage.reservedComputeUnitHours, 1);
});

test('simultaneous reservations cannot overdraw the remaining monthly runtime pool', async () => {
  const f = fixture(); f.setPlan('pro'); await f.read();
  const state = await f.ctx.storage.get('containerAccount');
  state.computeUsage['2026-10'] = (9000 - 16) * 3600000;
  await f.ctx.storage.put('containerAccount', state);
  const results = await Promise.all(Array.from({ length: 3 }, () => f.read('POST', undefined, {}, { size: 'large' })));
  assert.equal(results.filter(r => r.status === 200).length, 1);
  assert.equal(results.filter(r => r.data.error === 'compute_allowance_exhausted').length, 2);
  const status = await f.read();
  assert.equal(status.data.usage.availableComputeUnitHours, 0);
  assert.equal(status.data.usage.reservedComputeUnitHours, 16);
  assert.equal(status.data.usage.starts, 1);
});

test('pre-size idempotency records still reconcile an omitted or explicit Lite size', async () => {
  const f = fixture(); const headers = { 'Idempotency-Key': 'legacy-key' };
  const started = await f.read('POST', undefined, headers);
  const record = await f.ctx.storage.get('creation:legacy-key');
  record.fingerprint = JSON.stringify(['terminal', null]);
  await f.ctx.storage.put('creation:legacy-key', record);
  f.restart();
  const retry = await f.read('POST', undefined, headers, { size: 'lite' });
  assert.equal(retry.status, 200);
  assert.equal(retry.data.creation.id, started.data.creation.id);
  assert.equal(retry.data.usage.starts, 1);
  assert.equal((await f.read('POST', undefined, headers, { size: 'small' })).data.error, 'idempotency_key_conflict');
});

test('an alarm can migrate legacy account state before the first new request', async () => {
  const f = fixture(); await f.read('POST');
  const state = await f.ctx.storage.get('containerAccount');
  delete state.leases; delete state.computeUsage;
  await f.ctx.storage.put('containerAccount', state);
  f.restart(); await f.alarm();
  const result = await f.read();
  assert.equal(result.status, 200);
  assert.equal(result.data.containers.length, 1);
  assert.equal(result.data.usage.reservedComputeUnitHours, 1);
});


test('container names persist while starting, after restart and on keyed retries, and do not leak into reused slots', async () => {
  const f = fixture(); let release;
  f.machineFor('owner', 'small').ctx.container.gate = new Promise(resolve => { release = resolve; });
  const headers = { 'Idempotency-Key': 'named-operation' };
  const first = f.request('POST', undefined, headers, { name: '  My API  ' });
  await new Promise(resolve => setImmediate(resolve));
  const pending = await f.read();
  assert.equal(pending.data.containers[0].status, 'starting');
  assert.equal(pending.data.containers[0].name, 'My API');
  release();
  assert.equal((await (await first).json()).containers[0].name, 'My API');
  f.restart();
  assert.equal((await f.read()).data.containers[0].name, 'My API');
  assert.equal((await f.read('POST', undefined, headers, { name: 'My API' })).status, 200);
  for (const body of [{ name: 'Other' }, {}]) {
    assert.equal((await f.read('POST', undefined, headers, body)).data.error, 'idempotency_key_conflict');
  }
  assert.equal((await f.read()).data.usage.starts, 1);
  await f.read('DELETE', 'small');
  assert.equal((await f.read('POST')).data.containers[0].name, 'Small container');
});

test('invalid container names spend no starts or compute', async () => {
  const f = fixture();
  for (const name of ['', '   ', 'a'.repeat(81), null, 123, 'bad\nname']) {
    const result = await f.read('POST', undefined, {}, { name });
    assert.equal(result.status, 400);
    assert.equal(result.data.error, 'invalid_container_name');
  }
  assert.equal((await f.read()).data.usage.starts, 0);
});


test('usage starts default to a $5 cap and require explicit authorization for overages', async () => {
  const f = fixture('usage');
  const status = await f.read();
  assert.equal(status.data.billing.spendLimitCents, 500);
  assert.equal(status.data.billing.overagesEnabled, false);
  assert.equal(status.data.billing.alert, null);
  assert.equal((await f.billingRequest({ spendLimitCents: 5000 })).data.error, 'overage_authorization_required');
  assert.equal((await f.billingRequest({ spendLimitCents: 5000, authorizeOverages: true })).status, 200);
  assert.equal((await f.read()).data.billing.overagesEnabled, true);
  assert.equal((await f.ctx.storage.get('containerAccount')).overageConsent.spendLimitCents, 5000);
});

test('usage reserves only available spend, bills elapsed runtime, and preserves the ledger across eviction', async () => {
  const f = fixture('usage');
  const start = await f.read('POST', undefined, {}, { size: 'xl' });
  assert.equal(start.status, 200);
  const expires = Date.parse(start.data.containers[0].expiresAt);
  assert.equal(expires - f.now(), Math.floor(250 * 3600000 / 28));
  assert.equal(start.data.billing.estimatedCents, 500);
  assert.equal((await f.read('POST')).data.error, 'spend_limit_reached');
  f.setTime(f.now() + 60_000);
  await f.alarm();
  assert.equal(f.invoices.length, 0, 'Accounting is internal until invoicing');
  await f.read('DELETE', 'small');
  f.restart();
  const status = await f.read();
  assert.ok(Math.abs(status.data.billing.computeUnitHours - 28 / 60) < 0.00001);
  assert.equal(status.data.billing.committedCents, 500);
  assert.ok(status.data.usage.availableComputeUnitHours > 249);
});

test('usage periods can cross a UTC month boundary, and caps cannot drop below reserved spend', async () => {
  const f = fixture('usage');
  f.setTime(Date.UTC(2026, 9, 31, 23));
  await f.billingRequest({ spendLimitCents: 5000, authorizeOverages: true });
  const start = await f.read('POST', undefined, {}, { size: 'xl' });
  assert.ok(Date.parse(start.data.containers[0].expiresAt) > Date.UTC(2026, 10, 1));
  const reduced = await f.billingRequest({ spendLimitCents: 500 });
  assert.equal(reduced.status, 409); assert.equal(reduced.data.error, 'spend_limit_below_committed_usage');
  await f.read('DELETE', 'small');
  assert.equal((await f.billingRequest({ spendLimitCents: 500 })).status, 200);
});


test('production ignores idle and session limits while reserving only renewable runtime', async () => {
  const f = fixture('usage');
  const first = await f.read('POST', undefined, {}, { lifecycle: 'production', name: 'api', size: 'small', startupCommand: 'echo ready' });
  assert.equal(first.status, 200);
  const generation = first.data.containers[0].createdAt;
  const machine = f.machineFor('owner', 'small');
  assert.equal(machine.ctx.container.startOptions.entrypoint.at(-2), 'echo ready');
  assert.ok(first.data.billing.committedCents <= 500);
  // Run each account heartbeat before its current compute lease expires.
  for (let minutes = 0; minutes < 25 * 60; minutes += 4) {
    f.setTime(f.now() + 4 * 60_000);
    await f.alarm();
    await machine.controller.alarm();
  }
  const current = await f.read();
  assert.equal(current.data.containers[0].createdAt, generation);
  assert.equal(current.data.containers[0].lifecycle, 'production');
  assert.equal(machine.ctx.container.starts, 1);
  assert.equal(current.data.usage.starts, 1);
  assert.ok(current.data.billing.computeUnitHours >= 150);
});

test('multiple production sizes share the cap and explicit stop cannot resurrect', async () => {
  const f = fixture('usage');
  assert.equal((await f.read('POST', undefined, {}, { lifecycle: 'production', size: 'small' })).status, 200);
  const second = await f.read('POST', undefined, {}, { lifecycle: 'production', size: 'medium' });
  assert.equal(second.status, 200);
  assert.equal(second.data.containers.length, 2);
  await f.read('DELETE', 'small');
  await f.alarm();
  assert.equal(f.machineFor('owner', 'small').ctx.container.running, false);
  assert.equal((await f.ctx.storage.get('containerAccount')).production.small, undefined);
  assert.equal((await f.read()).data.containers.length, 1);
});

test('production recovers the same service identity and pinned image without billing stopped time', async () => {
  const f = fixture('usage');
  const first = await f.read('POST', undefined, {}, { lifecycle: 'production', name: 'api' });
  const machine = f.machineFor('owner', 'small'), generation = first.data.containers[0].createdAt;
  f.setTime(f.now() + 60_000);
  machine.ctx.container.running = false;
  await machine.controller.observePlatformStop(Date.parse(generation));
  machine.ctx.container.images.terminal = 'registry.test/new-image';
  f.setTime(f.now() + 60_000);
  f.restart();
  const recovered = await f.read();
  assert.equal(recovered.status, 200);
  assert.equal(recovered.data.containers[0].createdAt, generation);
  assert.equal(recovered.data.containers[0].name, 'api');
  assert.equal(machine.ctx.container.startOptions.image, 'registry.test/image');
  assert.equal(machine.ctx.container.starts, 2);
  assert.equal(recovered.data.usage.starts, 1);
  assert.ok(Math.abs(recovered.data.billing.computeUnitHours - 1 / 60) < 1e-8);
});

test('production stops at the cap and resumes in a new verified billing period', async () => {
  const f = fixture('usage', true);
  const first = await f.read('POST', undefined, {}, { lifecycle: 'production' });
  let state = await f.ctx.storage.get('containerAccount');
  Object.values(state.billingPeriods)[0].unitMs = 250 * 3600000;
  await f.ctx.storage.put('containerAccount', state);
  f.setTime(f.now() + 6 * 60_000);
  const capped = await f.read();
  assert.equal(capped.status, 200);
  assert.equal(capped.data.containers[0].status, 'stopped');
  assert.equal(capped.data.containers[0].stopReason, 'spend_limit_reached');
  assert.equal(f.machineFor('owner', 'small').ctx.container.running, false);
  const nextPeriod = f.now() + 31 * 86400000;
  f.setTime(nextPeriod); f.setPeriodStart(nextPeriod); f.setValidUntil(nextPeriod + 31 * 86400000);
  await f.alarm();
  const renewed = await f.read();
  assert.equal(renewed.data.containers[0].status, 'running');
  assert.equal(renewed.data.containers[0].createdAt, first.data.containers[0].createdAt);
  assert.equal(renewed.data.billing.computeUnitHours, 0);
});

test('production creation validates lifecycle and runtime support before reserving a start', async () => {
  const legacy = fixture();
  assert.equal((await legacy.read('POST', undefined, {}, { lifecycle: 'production' })).status, 402);
  const f = fixture('usage'), machine = f.machineFor('owner', 'small'), original = machine.fetch;
  machine.fetch = request => new URL(request.url).pathname === '/features' ? Promise.resolve(Response.json({ protocol: 1, internetControl: true })) : original(request);
  assert.equal((await f.read('POST', undefined, {}, { lifecycle: 'production' })).data.error, 'production_unavailable');
  assert.equal((await f.read()).data.usage.starts, 0);
  machine.fetch = original;
  assert.equal((await f.read('POST', undefined, {}, { lifecycle: 'forever' })).status, 400);
  assert.equal((await f.read('POST', undefined, {}, { startupCommand: 'echo hi' })).status, 400);
  const headers = { 'Idempotency-Key': 'production-api' };
  assert.equal((await f.read('POST', undefined, headers, { lifecycle: 'production', startupCommand: 'echo hi' })).status, 200);
  assert.equal((await f.read('POST', undefined, headers, { lifecycle: 'production', startupCommand: 'echo changed' })).status, 409);
});


test('production payment revocation stops compute and later paid access recovers; deletion skips recovery', async () => {
  const f = fixture('usage');
  const first = await f.read('POST', undefined, { 'Idempotency-Key': 'stable-service' }, { lifecycle: 'production', name: 'api' });
  const machine = f.machineFor('owner', 'small');
  f.setTime(f.now() + 60_000); f.setPaid(false);
  const revoked = await f.read();
  assert.equal(revoked.data.containers[0].status, 'stopped');
  assert.equal(machine.ctx.container.running, false);
  f.setTime(f.now() + 60_000); f.setPaid(true);
  const recovered = await f.read();
  assert.equal(recovered.data.containers[0].status, 'running');
  assert.equal(recovered.data.containers[0].name, 'api');
  assert.equal(recovered.data.containers[0].createdAt, first.data.containers[0].createdAt);
  const replay = await f.read('POST', undefined, { 'Idempotency-Key': 'stable-service' }, { lifecycle: 'production', name: 'api' });
  assert.equal(replay.status, 200); assert.equal(replay.data.creation.id, first.data.creation.id);
  machine.ctx.container.running = false;
  const starts = machine.ctx.container.starts;
  await f.read('DELETE', 'small');
  assert.equal(machine.ctx.container.starts, starts);
  await f.alarm(); assert.equal(machine.ctx.container.running, false);
});


test('production retries an interrupted first boot without inheriting the previous slot generation', async () => {
  const f = fixture('usage');
  await f.read('POST'); await f.read('DELETE', 'small');
  const machine = f.machineFor('owner', 'small');
  machine.ctx.container.images = {};
  const failed = await f.read('POST', undefined, {}, { lifecycle: 'production', name: 'api' });
  assert.equal(failed.status, 409);
  machine.ctx.container.images = { terminal: 'registry.test/recovered-image' };
  f.setTime(f.now() + 100_000);
  const recovered = await f.read();
  assert.equal(recovered.status, 200);
  assert.equal(recovered.data.containers[0].lifecycle, 'production');
  assert.equal(recovered.data.containers[0].status, 'running');
  assert.equal(machine.ctx.container.startOptions.image, 'registry.test/recovered-image');
});
