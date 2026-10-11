import { entitlementHeaders, requestEntitlement, validEntitlement, PLAN_LIMITS } from './plan-policy.js';
import { validContainerName, validIdempotencyKey } from './container-account-core.js';
import { MAX_MANAGED_POOLS, POOL_POLL_MS, POOL_OPERATION_RETENTION_MS, validPoolId, validPoolSize, validPoolTTL } from './pool-contract.js';

const INDEX = 'managedPools';
const ACCOUNT = 'containerAccount';
const MAX_REFILLS_PER_ALARM = 4;

// Pool inventory belongs to the account coordinator. A reservation and its
// inventory ownership commit together, before boot. Acquiring atomically removes
// ownership, so draining or retrying a deleted pool cannot stop a claimed guest.
export class AccountPools {
  constructor(account) { this.account = account; }
  async load() { return await this.account.ctx.storage.get(INDEX) ?? { pools: [] }; }
  async nextAlarm() {
    const a = this.account, { pools } = await this.load();
    const times = pools.filter(p => p.entries.length || a.managedPoolsEnabled !== false && p.targetSize > 0 && !p.deleting && p.expiresAt > a.now()).map(p =>
      p.deleting || p.expiresAt <= a.now() ? a.now() + POOL_POLL_MS
        : Math.min(p.expiresAt, p.entries.length < p.targetSize && a.managedPoolsEnabled !== false
          ? Math.max(a.now() + 1000, p.retryAt ?? 0) : a.now() + POOL_POLL_MS));
    return times.length ? Math.min(...times) : Infinity;
  }
  async active() { return this.account.managedPoolsEnabled !== false && (await this.load()).pools.some(p => !p.deleting && p.targetSize > 0 && p.expiresAt > this.account.now()); }
  owned(state, entry) { return entry.slot && state.slots.includes(entry.slot) && state.reservations[entry.slot] === entry.reservationId; }
  view(pool, state, containers) {
    const owned = pool.entries.filter(entry => this.owned(state, entry));
    const ready = owned.filter(entry => containers.some(c => c.id === entry.slot && c.status === 'running')).length;
    const expired = pool.expiresAt <= this.account.now();
    return { id: pool.id, name: pool.name, targetSize: pool.targetSize, ready: expired || pool.deleting ? 0 : ready,
      starting: expired || pool.deleting ? 0 : pool.entries.length - ready,
      status: pool.deleting ? 'deleting' : expired ? 'expired' : pool.targetSize === 0 ? 'paused' : pool.lastError ? 'degraded' : 'active',
      createdAt: new Date(pool.createdAt).toISOString(), updatedAt: new Date(pool.updatedAt).toISOString(), expiresAt: new Date(pool.expiresAt).toISOString(),
      selection: pool.selection, ...(pool.lastError ? { lastError: pool.lastError } : {}) };
  }
  async sync(index, state, containers) {
    const a = this.account;
    for (const pool of index.pools) {
      pool.entries = pool.entries.filter(entry => !entry.slot || this.owned(state, entry));
      if (!state.entitlement.active && pool.targetSize > 0 && pool.expiresAt > a.now() && !pool.deleting) {
        pool.lastError = 'subscription_required'; pool.retryAt = a.now() + POOL_POLL_MS;
      } else if (state.entitlement.active && pool.lastError === 'subscription_required') {
        delete pool.lastError; delete pool.retryAt;
      }
      if (pool.entries.length === pool.targetSize && pool.entries.every(entry => this.owned(state, entry) && containers.some(c => c.id === entry.slot && c.status === 'running'))) {
        delete pool.lastError; delete pool.retryAt;
      }
      const target = a.managedPoolsEnabled === false || pool.deleting || pool.expiresAt <= a.now() ? 0 : pool.targetSize;
      while (pool.entries.length > target) {
        const entry = pool.entries.at(-1);
        if (this.owned(state, entry)) {
          // Reservation identity fences cleanup even while the boot response is
          // lost and the public createdAt is not yet known.
          try {
            const stopped = await a.machine(state, entry.slot, 'DELETE', state.entitlement);
            a.settleLease(state, entry.slot, stopped.lastRun?.stoppedAt ?? a.now());
            state.slots = state.slots.filter(id => id !== entry.slot);
            delete state.pending[entry.slot];
            containers = containers.filter(c => c.id !== entry.slot);
          } catch { pool.lastError = 'pool_cleanup_pending'; break; }
        }
        pool.entries.pop();
        // Persist each successful stop before attempting another runtime.
        await a.ctx.storage.put({ [ACCOUNT]: state, [INDEX]: index });
      }
    }
    index.pools = index.pools.filter(pool => !pool.deleting || pool.entries.length);
    await a.ctx.storage.put(INDEX, index);
    return containers;
  }
  // Called inside the normal account start lock before quota is reserved.
  async admission(poolId, creationKey) {
    const index = await this.load(), pool = index.pools.find(p => p.id === poolId);
    const entry = pool?.entries.find(e => e.key === creationKey);
    if (this.account.managedPoolsEnabled === false || !pool || pool.deleting || pool.expiresAt <= this.account.now() || !entry || pool.entries.indexOf(entry) >= pool.targetSize) return null;
    return { index, pool, entry };
  }
  async fetch(request) {
    const a = this.account, url = new URL(request.url), match = /^\/pools(?:\/(pool_[a-f0-9-]+)(\/acquire)?)?$/.exec(url.pathname);
    const poolId = match?.[1], acquire = Boolean(match?.[2]);
    if (!match || poolId && !validPoolId(poolId) || url.search) return a.respond({ error: 'invalid_request' }, 400);
    const allowed = acquire ? ['POST'] : poolId ? ['GET', 'PATCH', 'DELETE'] : ['GET', 'POST'];
    if (!allowed.includes(request.method)) return a.respond({ error: 'method_not_allowed' }, 405);
    if (!['GET', 'DELETE'].includes(request.method) && a.managedPoolsEnabled === false) return a.respond({ error: 'pools_unavailable' }, 503);
    const userId = request.headers.get('x-mainbrella-user');
    if (!userId || !/^[A-Za-z0-9_-]{1,128}$/.test(userId)) return a.respond({ error: 'not_authenticated' }, 401);
    const key = request.headers.get('Idempotency-Key');
    if (request.method === 'POST' && !validIdempotencyKey(key)) return a.respond({ error: 'invalid_idempotency_key' }, 400);
    let body;
    try { body = request.body ? await request.json() : {}; } catch { return a.respond({ error: 'invalid_request' }, 400); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return a.respond({ error: 'invalid_request' }, 400);
    if (request.method === 'PATCH' && (!Object.keys(body).length || Object.keys(body).some(k => !['name', 'targetSize'].includes(k)))) return a.respond({ error: 'invalid_request' }, 400);
    if (acquire && Object.keys(body).length) return a.respond({ error: 'invalid_request' }, 400);
    if (body.name !== undefined && !validContainerName(body.name) || body.targetSize !== undefined && !validPoolSize(body.targetSize)) return a.respond({ error: 'invalid_request' }, 400);
    if (request.method === 'POST' && !acquire && (!validContainerName(body.name) || !validPoolSize(body.targetSize) || !validPoolTTL(body.ttlSeconds) || !body.selection || !body.launch)) return a.respond({ error: 'invalid_request' }, 400);
    try { return await a.serialized(async () => {
      const supplied = requestEntitlement(request, a.now()), state = await a.initialize(userId, supplied);
      const index = await this.load();
      // Deletion is always possible, including during billing lookup outages.
      const entitlement = request.method === 'DELETE' && validEntitlement(state.entitlement, a.now()) ? state.entitlement : supplied;
      let containers = await a.reconcile(state, entitlement, request.method !== 'DELETE');
      containers = await this.sync(index, state, containers);
      let pool = index.pools.find(p => p.id === poolId);
      if (request.method === 'DELETE') {
        if (pool) {
          pool.deleting = true; pool.updatedAt = a.now();
          await a.ctx.storage.put(INDEX, index);
          await this.sync(index, state, containers);
          await a.saveState(state);
          if (index.pools.some(p => p.id === poolId)) return a.respond({ error: 'pool_cleanup_pending' }, 503);
        }
        return a.respond({ deleted: true });
      }
      const receiptKey = `creation:pool-${acquire ? 'acquire' : 'create'}:${key}`;
      const fingerprint = acquire ? poolId : JSON.stringify([body.name, body.targetSize, body.ttlSeconds, body.selection]);
      if (request.method === 'POST') {
        const receipt = await a.ctx.storage.get(receiptKey);
        if (receipt && receipt.expiresAt > a.now()) {
          if (receipt.fingerprint !== fingerprint) return a.respond({ error: 'idempotency_key_conflict' }, 409);
          if (acquire) {
            const container = state.reservations[receipt.slot] === receipt.reservationId && containers.find(c => c.id === receipt.slot && c.createdAt === receipt.createdAt && c.status === 'running');
            return container ? a.respond({ poolId, container }) : a.respond({ error: 'acquisition_no_longer_running' }, 409);
          }
          const existing = index.pools.find(p => p.id === receipt.poolId);
          return existing && !existing.deleting ? a.respond({ pool: this.view(existing, state, containers) }) : a.respond({ error: 'pool_no_longer_exists' }, 409);
        }
      }
      if (poolId && (!pool || pool.deleting)) return a.respond({ error: 'pool_not_found' }, 404);
      if (request.method === 'GET') return a.respond(pool ? { pool: this.view(pool, state, containers) } : { pools: index.pools.map(p => this.view(p, state, containers)) });
      if (!state.entitlement.active) return a.respond({ error: 'subscription_required' }, 402);
      if (acquire) {
        if (pool.expiresAt <= a.now()) return a.respond({ error: 'pool_expired' }, 410);
        const entry = pool.entries.find(entry => this.owned(state, entry) && containers.some(c => c.id === entry.slot && c.status === 'running' && Date.parse(c.expiresAt) > a.now() + 1000));
        if (!entry) return a.respond({ error: 'pool_empty' }, 409);
        const container = containers.find(c => c.id === entry.slot);
        pool.entries = pool.entries.filter(e => e !== entry);
        pool.updatedAt = a.now(); delete pool.lastError; delete pool.retryAt;
        const expiresAt = a.now() + POOL_OPERATION_RETENTION_MS;
        state.nextCreationExpiry = Math.min(state.nextCreationExpiry ?? Infinity, expiresAt);
        await a.ctx.storage.put({ [ACCOUNT]: state, [INDEX]: index, [receiptKey]: { fingerprint, slot: entry.slot, reservationId: entry.reservationId, createdAt: container.createdAt, expiresAt } });
        await a.saveState(state);
        return a.respond({ poolId, container });
      }
      const desired = body.targetSize ?? pool?.targetSize;
      const total = index.pools.filter(p => p !== pool && !p.deleting && p.expiresAt > a.now()).reduce((sum, p) => sum + p.targetSize, desired);
      if (total > PLAN_LIMITS[state.entitlement.plan].maxContainers) return a.respond({ error: 'pool_capacity_exceeded' }, 409);
      if (request.method === 'PATCH') {
        if (pool.expiresAt <= a.now()) return a.respond({ error: 'pool_expired' }, 410);
        if (body.name !== undefined) pool.name = body.name.trim();
        pool.targetSize = desired; pool.updatedAt = a.now(); delete pool.lastError; delete pool.retryAt;
        await a.ctx.storage.put(INDEX, index);
        containers = await this.sync(index, state, containers);
      } else {
        if (index.pools.length >= MAX_MANAGED_POOLS) return a.respond({ error: 'pool_limit_exceeded' }, 409);
        pool = { id: `pool_${crypto.randomUUID()}`, name: body.name.trim(), targetSize: desired, selection: body.selection, launch: body.launch,
          createdAt: a.now(), updatedAt: a.now(), expiresAt: a.now() + body.ttlSeconds * 1000, entries: [] };
        index.pools.push(pool);
        // Leave room for every future inventory reservation below DO's value cap.
        if (new TextEncoder().encode(JSON.stringify(index)).byteLength + index.pools.length * 8192 > 112 * 1024) return a.respond({ error: 'pool_capacity_exceeded' }, 409);
        const expiresAt = a.now() + POOL_OPERATION_RETENTION_MS;
        state.nextCreationExpiry = Math.min(state.nextCreationExpiry ?? Infinity, expiresAt);
        await a.ctx.storage.put({ [ACCOUNT]: state, [INDEX]: index, [receiptKey]: { fingerprint, poolId: pool.id, expiresAt } });
      }
      await a.saveState(state);
      return a.respond({ pool: this.view(pool, state, containers) }, request.method === 'POST' ? 201 : 200);
    }); } catch (error) { return a.respond({ error: error.message === 'account_mismatch' ? 'account_mismatch' : 'pools_unavailable' }, error.message === 'account_mismatch' ? 403 : 503); }
  }
  async maintain() {
    const a = this.account;
    if (!(await this.load()).pools.length) return;
    const tasks = await a.serialized(async () => {
      const state = await a.ctx.storage.get(ACCOUNT);
      if (!state) return [];
      const index = await this.load();
      // Account.alarm already reconciled; status below obtains authoritative
      // generations and fences any expired inventory before replacements start.
      const containers = await a.reconcile(state, state.entitlement);
      await this.sync(index, state, containers);
      const tasks = [];
      if (state.entitlement.active && a.managedPoolsEnabled !== false) {
        for (const pool of index.pools) {
          if (pool.deleting || pool.expiresAt <= a.now() || pool.retryAt > a.now()) continue;
          for (const entry of pool.entries.filter(e => !e.slot)) {
            if (tasks.length >= MAX_REFILLS_PER_ALARM) break;
            tasks.push({ poolId: pool.id, key: entry.key, userId: state.userId, entitlement: state.entitlement, launch: pool.launch });
          }
          while (pool.entries.length < pool.targetSize && tasks.length < MAX_REFILLS_PER_ALARM) {
            const entry = { key: `pool_${crypto.randomUUID()}` }; pool.entries.push(entry);
            tasks.push({ poolId: pool.id, key: entry.key, userId: state.userId, entitlement: state.entitlement, launch: pool.launch });
          }
        }
      }
      await a.ctx.storage.put(INDEX, index);
      await a.saveState(state);
      return tasks;
    });
    await Promise.all(tasks.map(async task => {
      const response = await a.fetch(new Request('https://internal/containers', { method: 'POST', headers: {
        ...entitlementHeaders(task.entitlement), 'x-mainbrella-user': task.userId, 'Idempotency-Key': task.key, 'x-mainbrella-pool': task.poolId,
      }, body: JSON.stringify(task.launch) }));
      const result = await response.json();
      await a.serialized(async () => {
        const index = await this.load(), pool = index.pools.find(p => p.id === task.poolId);
        if (!pool || pool.deleting) return;
        if (response.ok) { delete pool.lastError; delete pool.retryAt; }
        else {
          pool.lastError = typeof result.error === 'string' ? result.error : 'containers_unavailable';
          pool.retryAt = a.now() + POOL_POLL_MS;
          // Unknown starts retain their key and reservation. Reconciliation
          // determines whether they committed before any replacement can start.
        }
        await a.ctx.storage.put(INDEX, index);
        const state = await a.ctx.storage.get(ACCOUNT);
        if (state) await a.saveState(state);
      });
    }));
  }
}
