import { ContainerAccountController, machineName } from './container-account-core.js';
import { UserContainerController } from './user-container-core.js';
import { entitlementHeaders } from './plan-policy.js';

export class PoolTestStorage {
  values = new Map(); alarmAt = null;
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) {
    if (typeof key === 'object') for (const [name, entry] of Object.entries(key)) this.values.set(name, structuredClone(entry));
    else this.values.set(key, structuredClone(value));
  }
  async delete(key) { if (Array.isArray(key)) return key.reduce((sum, name) => sum + Number(this.values.delete(name)), 0); return this.values.delete(key); }
  async list({ prefix = '', limit = 1000, startAfter } = {}) {
    return new Map([...this.values].sort(([a], [b]) => a.localeCompare(b)).filter(([key]) => key.startsWith(prefix) && (!startAfter || key > startAfter)).slice(0, limit));
  }
  async setAlarm(at) { this.alarmAt = at; }
  async deleteAlarm() { this.alarmAt = null; }
}

export function poolFixture() {
  let now = Date.UTC(2026, 9, 11, 12), paid = true, checkedAt = now, validUntil = now + 86400000;
  const ctx = { storage: new PoolTestStorage() }, machines = new Map();
  const entitlement = () => ({ active: paid, plan: paid ? 'builder' : null, validUntil: paid ? validUntil : null, checkedAt });
  const machineFor = (user, id) => {
    const key = machineName(user, id);
    if (!machines.has(key)) {
      const machineCtx = { storage: new PoolTestStorage(), container: {
        images: { terminal: 'registry.test/node' }, running: false, starts: 0, destroys: 0,
        start() { this.running = true; this.starts++; }, async setInactivityTimeout() {},
        async exec() { return { output: async () => ({ exitCode: 0 }) }; },
        async destroy() { this.running = false; this.destroys++; },
      } };
      const controller = new UserContainerController(machineCtx, () => now);
      const runtime = { ctx: machineCtx, controller, beforeStart: undefined, loseStartReply: false, failStop: false,
        async fetch(request) {
          if (request.method === 'POST' && new URL(request.url).pathname.startsWith('/container')) {
            if (runtime.beforeStart) await runtime.beforeStart();
            const result = await controller.fetch(request);
            if (runtime.loseStartReply) { runtime.loseStartReply = false; throw new Error('lost_reply'); }
            return result;
          }
          if (request.method === 'DELETE' && runtime.failStop) throw new Error('stop_unavailable');
          return controller.fetch(request);
        } };
      machines.set(key, runtime);
    }
    return machines.get(key);
  };
  let account = new ContainerAccountController(ctx, machineFor, () => now, undefined, async () => entitlement());
  account.managedPoolsEnabled = true;
  const request = (path = '/pools', method = 'GET', body, key, owner = 'owner') => account.fetch(new Request(`https://internal${path}`, {
    method, headers: { ...entitlementHeaders(entitlement()), 'x-mainbrella-user': owner, ...(key ? { 'Idempotency-Key': key } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const read = async (...args) => { const response = await request(...args); return { status: response.status, data: await response.json() }; };
  const create = (overrides = {}, key = 'create') => read('/pools', 'POST', { name: 'Python agents', targetSize: 2, ttlSeconds: 3600,
    selection: { size: 'lite', internet: true, catalogId: 'node' }, launch: { size: 'lite', internet: true, imageKey: 'terminal', imageName: 'Node 24 + TypeScript' }, ...overrides }, key);
  return { ctx, machines, machineFor, request, read, create, entitlement, fetch: request => account.fetch(request), now: () => now,
    setTime(value) { now = value; checkedAt = now; }, setPaid(value) { paid = value; checkedAt = ++now; }, setValidUntil(value) { validUntil = value; },
    restart() { account = new ContainerAccountController(ctx, machineFor, () => now, undefined, async () => entitlement()); account.managedPoolsEnabled = true; },
    disable() { account.managedPoolsEnabled = false; }, alarm: () => account.alarm() };
}
