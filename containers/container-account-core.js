import { PLAN_LIMITS, NO_PLAN_LIMITS, entitlementHeaders, requestEntitlement, validEntitlement } from './plan-policy.js';
import { IMAGE_CATALOG } from './image-catalog.js';

const KEY = 'containerAccount';
const CREATION_PREFIX = 'creation:';
const CREATION_RETENTION_MS = 24 * 60 * 60_000;
export const validIdempotencyKey = key => typeof key === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(key);
export const validContainerId = (id) => id === 'small' || /^c(?:[1-9]\d{0,2})$/.test(id) && Number(id.slice(1)) < 500;
export const machineName = (userId, id) => id === 'small' ? `user:${userId}` : `user:${userId}:slot:${id.slice(1)}`;

// One serialized account owner reserves every start before provisioning a slot.
// It survives restarts and plan/customer/subscription changes without resetting usage.
export class ContainerAccountController {
  constructor(ctx, machineFor, now = () => Date.now()) {
    Object.assign(this, { ctx, machineFor, now });
    this.tail = Promise.resolve();
  }
  async serialized(fn) {
    const previous = this.tail;
    let release;
    this.tail = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await fn(); } finally { release(); }
  }
  respond(data, status = 200) { return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } }); }
  async machine(state, id, method, entitlement, reservationId = state.reservations?.[id], selection) {
    const response = await this.machineFor(state.userId, id).fetch(new Request('https://internal/container', {
      method, headers: { ...entitlementHeaders(entitlement), ...(reservationId ? { 'x-mainbrella-reservation': String(reservationId) } : {}), ...(method === 'POST' && selection ? { 'Content-Type': 'application/json' } : {}) },
      ...(method === 'POST' && selection ? { body: JSON.stringify(selection) } : {}),
    }));
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      throw new Error(data?.error === 'container_start_canceled' ? 'container_not_running'
        : data?.error === 'subscription_required' ? 'subscription_required'
        : data?.error === 'image_not_available' ? 'image_not_available' : 'container_request_failed');
    }
    return response.json();
  }
  async initialize(userId, entitlement) {
    let state = await this.ctx.storage.get(KEY);
    if (state) {
      if (state.userId !== userId) throw new Error('account_mismatch');
      state.pending ??= {};
      state.reservations ??= {};
      state.nextReservationId ??= 0;
      return state;
    }
    // Preserve legacy slot and starts. An unpaid legacy machine is stopped by
    // the slot's entitlement check, while its historical usage remains intact.
    state = { userId, slots: ['small'], usage: {}, pending: {}, reservations: {}, nextReservationId: 0, entitlement };
    const legacy = await this.machine(state, 'small', 'GET', entitlement);
    state.imageCatalog = legacy.imageCatalog ?? [];
    if (legacy.usage?.month && Number.isSafeInteger(legacy.usage.starts)) state.usage[legacy.usage.month] = legacy.usage.starts;
    if (!legacy.containers?.length) state.slots = [];
    await this.ctx.storage.put(KEY, state);
    return state;
  }
  async stopIndependently(state, ids, entitlement) {
    const failed = [];
    for (let offset = 0; offset < ids.length; offset += 20) {
      const batch = ids.slice(offset, offset + 20);
      const results = await Promise.allSettled(batch.map(id => this.machine(state, id, 'DELETE', entitlement)));
      results.forEach((result, index) => { if (result.status === 'rejected') failed.push(batch[index]); });
    }
    return failed;
  }
  async pruneCreations(state) {
    if (!state.nextCreationExpiry || state.nextCreationExpiry > this.now()) return;
    let startAfter;
    let nextExpiry;
    do {
      const records = await this.ctx.storage.list({ prefix: CREATION_PREFIX, limit: 1000, ...(startAfter ? { startAfter } : {}) });
      const expired = [];
      for (const [key, record] of records) {
        if (record.expiresAt <= this.now()) expired.push(key);
        else nextExpiry = Math.min(nextExpiry ?? Infinity, record.expiresAt);
        startAfter = key;
      }
      if (expired.length) await this.ctx.storage.delete(expired);
      if (records.size < 1000) break;
    } while (true);
    state.nextCreationExpiry = nextExpiry;
  }
  creationResponse(state, containers, record) {
    const container = state.reservations[record.slot] === record.reservationId && containers.find(c => c.id === record.slot);
    if (!container) return this.respond({ error: 'creation_no_longer_running', creation: { id: record.id, containerId: record.slot, status: 'stopped' } }, 409);
    return this.respond({ ...this.status(state, containers), creation: { id: record.id, containerId: record.slot, createdAt: container.createdAt, status: container.status } });
  }
  async saveState(state, retry = false) {
    const month = new Date(this.now()).toISOString().slice(0, 7);
    state.usage = { [month]: state.usage[month] ?? 0 };
    state.pending = Object.fromEntries(Object.entries(state.pending).filter(([id]) => state.slots.includes(id)));
    await this.ctx.storage.put(KEY, state);
    let alarmAt;
    if (retry && state.slots.length) alarmAt = this.now() + 30_000;
    else if (state.entitlement.active && state.slots.length) {
      alarmAt = Math.min(state.entitlement.validUntil, ...Object.values(state.pending).map(at => at + 90_000));
    }
    if (state.nextCreationExpiry) alarmAt = Math.min(alarmAt ?? Infinity, state.nextCreationExpiry);
    if (alarmAt) await this.ctx.storage.setAlarm(alarmAt);
    else await this.ctx.storage.deleteAlarm();
  }
  async reconcile(state, entitlement) {
    if ((state.entitlement?.checkedAt ?? 0) > (entitlement.checkedAt ?? 0)
      || (state.entitlement?.checkedAt === entitlement.checkedAt && !state.entitlement.active && entitlement.active)) entitlement = state.entitlement;
    if (!validEntitlement(entitlement, this.now())) entitlement = { active: false, plan: null, validUntil: null, checkedAt: entitlement.checkedAt };
    state.entitlement = entitlement;
    // A durable retry precedes any fanout: interruption or one unavailable DO
    // cannot erase the revocation decision or abandon the rest of the account.
    await this.saveState(state, true);
    if (!entitlement.active) {
      state.slots = await this.stopIndependently(state, state.slots, entitlement);
      await this.saveState(state, state.slots.length > 0);
      if (state.slots.length) throw new Error('container_reconciliation_failed');
      return [];
    }
    if (!state.slots.length) {
      const machine = await this.machine(state, 'small', 'GET', entitlement);
      state.imageCatalog = machine.imageCatalog ?? [];
    }
    const results = [];
    let unreadable = [];
    for (let offset = 0; offset < state.slots.length; offset += 20) {
      const ids = state.slots.slice(offset, offset + 20);
      const batch = await Promise.allSettled(ids.map(async id => {
        const reservation = state.pending[id];
        if (reservation && this.now() < reservation + 90_000) {
          return { id, name: id === 'small' ? 'Small container' : `Small container ${Number(id.slice(1)) + 1}`,
            instance: 'lite', status: 'starting', createdAt: new Date(reservation).toISOString(),
            expiresAt: new Date(Math.min(reservation + PLAN_LIMITS[entitlement.plan].maxSessionMs, entitlement.validUntil)).toISOString() };
        }
        delete state.pending[id];
        const data = await this.machine(state, id, 'GET', entitlement);
        state.imageCatalog = data.imageCatalog ?? [];
        if (!data.containers?.[0]) {
          // Fence delayed boot dispatches before releasing an apparently empty
          // slot, including recovery after an interrupted provisioning request.
          await this.machine(state, id, 'DELETE', entitlement);
          return null;
        }
        return { ...data.containers[0], id, name: id === 'small' ? 'Small container' : `Small container ${Number(id.slice(1)) + 1}` };
      }));
      batch.forEach((result, index) => {
        if (result.status === 'rejected') unreadable.push(ids[index]);
        else if (result.value) results.push(result.value);
      });
    }
    results.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const limits = PLAN_LIMITS[entitlement.plan];
    // Unknown machines still occupy capacity. If unknown machines alone exceed
    // the cap, try stopping each; otherwise preserve them until status recovers.
    if (unreadable.length > limits.maxContainers) unreadable = await this.stopIndependently(state, unreadable, entitlement);
    const retained = results.slice(0, Math.max(0, limits.maxContainers - unreadable.length));
    let failedStops = await this.stopIndependently(state, results.slice(retained.length).map(c => c.id), entitlement);
    // A failed stop still occupies a slot. Keep stopping reachable excess until
    // all remaining known machines fit, instead of aborting on the first error.
    while (retained.length && retained.length + unreadable.length + failedStops.length > limits.maxContainers) {
      const count = Math.min(retained.length, retained.length + unreadable.length + failedStops.length - limits.maxContainers);
      const extra = retained.splice(retained.length - count);
      failedStops.push(...await this.stopIndependently(state, extra.map(c => c.id), entitlement));
    }
    state.slots = [...retained.map(c => c.id), ...unreadable, ...failedStops];
    if (!validEntitlement(entitlement, this.now())) {
      return this.reconcile(state, { active: false, plan: null, validUntil: null, checkedAt: entitlement.checkedAt });
    }
    const incomplete = unreadable.length > 0 || failedStops.length > 0;
    await this.saveState(state, incomplete);
    if (incomplete) throw new Error('container_reconciliation_failed');
    return retained;
  }
  status(state, containers) {
    const month = new Date(this.now()).toISOString().slice(0, 7);
    return { plan: state.entitlement.plan, active: state.entitlement.active,
      limits: state.entitlement.active ? PLAN_LIMITS[state.entitlement.plan] : NO_PLAN_LIMITS,
      usage: { month, starts: state.usage[month] ?? 0 }, containers, imageCatalog: state.imageCatalog ?? [] };
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== '/containers') return this.respond({ error: 'not_found' }, 404);
    if (!['GET', 'POST', 'DELETE', 'PUT'].includes(request.method)) return this.respond({ error: 'method_not_allowed' }, 405);
    const userId = request.headers.get('x-mainbrella-user');
    if (!userId || !/^[A-Za-z0-9_-]{1,128}$/.test(userId)) return this.respond({ error: 'not_authenticated' }, 401);
    const id = url.searchParams.get('id');
    if (id !== null && (!validContainerId(id) || url.searchParams.getAll('id').length !== 1)) return this.respond({ error: 'invalid_container_id' }, 400);
    const suppliedEntitlement = requestEntitlement(request, this.now());
    const cleanupOnly = request.method === 'DELETE' && request.headers.get('x-mainbrella-cleanup') === '1';
    const idempotencyKey = request.method === 'POST' ? request.headers.get('Idempotency-Key') : null;
    if (idempotencyKey !== null && !validIdempotencyKey(idempotencyKey)) return this.respond({ error: 'invalid_idempotency_key' }, 400);
    let reservation;
    try {
      const selection = request.method === 'POST' && request.body ? await request.json() : undefined;
      const fingerprint = JSON.stringify([selection?.imageKey ?? 'terminal', selection?.imageId ?? null]);
      const result = await this.serialized(async () => {
        const state = await this.initialize(userId, suppliedEntitlement);
        await this.pruneCreations(state);
        let entitlement = cleanupOnly && validEntitlement(state.entitlement, this.now()) ? state.entitlement : suppliedEntitlement;
        let containers = await this.reconcile(state, entitlement);
        entitlement = state.entitlement;
        if (request.method === 'POST') {
          if (!validEntitlement(entitlement, this.now())) {
            await this.reconcile(state, { active: false, plan: null, validUntil: null, checkedAt: entitlement.checkedAt });
            return this.respond({ error: 'subscription_required' }, 402);
          }
          if (idempotencyKey) {
            const record = await this.ctx.storage.get(CREATION_PREFIX + idempotencyKey);
            if (record && record.expiresAt > this.now()) {
              if (record.fingerprint !== fingerprint) return this.respond({ error: 'idempotency_key_conflict' }, 409);
              return this.creationResponse(state, containers, record);
            }
          }
          const catalogImage = IMAGE_CATALOG.find(image => image.key === selection?.imageKey);
          if (catalogImage && !(state.imageCatalog ?? []).some(image => image.id === catalogImage.id)) {
            return this.respond({ error: 'image_not_available' }, 409);
          }
          const limits = PLAN_LIMITS[entitlement.plan];
          if (state.slots.length >= limits.maxContainers) return this.respond({ error: 'container_limit_exceeded' }, 409);
          const month = new Date(this.now()).toISOString().slice(0, 7);
          if ((state.usage[month] ?? 0) >= limits.maxStartsPerMonth) return this.respond({ error: 'container_quota_exceeded' }, 429);
          const slot = Array.from({ length: limits.maxContainers }, (_, index) => index === 0 ? 'small' : `c${index}`).find(candidate => !state.slots.includes(candidate));
          state.usage[month] = (state.usage[month] ?? 0) + 1;
          state.slots.push(slot);
          state.pending[slot] = this.now();
          const reservationId = ++state.nextReservationId;
          state.reservations[slot] = reservationId;
          const creation = idempotencyKey ? { id: crypto.randomUUID(), slot, reservationId, fingerprint, expiresAt: this.now() + CREATION_RETENTION_MS } : undefined;
          if (creation) {
            state.nextCreationExpiry = Math.min(state.nextCreationExpiry ?? Infinity, creation.expiresAt);
            // Multi-key puts are atomic: the key and charged reservation survive together.
            await this.ctx.storage.put({ [KEY]: state, [CREATION_PREFIX + idempotencyKey]: creation });
          } else await this.ctx.storage.put(KEY, state);
          await this.ctx.storage.setAlarm(Math.min(entitlement.validUntil, this.now() + 90_000, state.nextCreationExpiry ?? Infinity));
          reservation = { state, slot, entitlement, reservationId, creation };
          return null;
        }
        if (request.method === 'DELETE') {
          if (!id && containers.length > 1) return this.respond({ error: 'container_id_required' }, 400);
          const target = id ?? containers[0]?.id;
          if (target && !state.slots.includes(target)) return this.respond({ error: 'container_not_running' }, 409);
          const generation = url.searchParams.get('createdAt');
          if (generation && containers.find(c => c.id === target)?.createdAt !== generation) return this.respond({ error: 'container_not_running' }, 409);
          if (target) {
            await this.machine(state, target, 'DELETE', entitlement);
            delete state.pending[target];
          }
          containers = await this.reconcile(state, entitlement);
        }
        return this.respond(this.status(state, containers));
      });
      if (result) return result;
      // Boot outside the reservation lock so a Scale account can launch many
      // containers together. Pending slots count toward capacity throughout.
      const { state, slot, entitlement, reservationId, creation } = reservation;
      await this.machine(state, slot, 'POST', entitlement, reservationId, selection);
      return await this.serialized(async () => {
        const current = await this.ctx.storage.get(KEY);
        if (current.reservations?.[slot] !== reservationId || !current.slots.includes(slot)) {
          return this.respond({ error: 'container_not_running' }, 409);
        }
        delete current.pending[slot];
        const currentEntitlement = validEntitlement(current.entitlement, this.now()) ? current.entitlement : { active: false, plan: null, validUntil: null, checkedAt: current.entitlement.checkedAt };
        const containers = await this.reconcile(current, currentEntitlement);
        return creation ? this.creationResponse(current, containers, creation) : this.respond(this.status(current, containers));
      });
    } catch (error) {
      // Keep reserved quota and pending slots on every ambiguous failure.
      if (error.message === 'container_not_running') return this.respond({ error: error.message }, 409);
      if (error.message === 'image_not_available') return this.respond({ error: error.message }, 409);
      if (error.message === 'subscription_required') return this.respond({ error: error.message }, 402);
      return this.respond({ error: 'containers_unavailable' }, 503);
    }
  }
  alarm() {
    return this.serialized(async () => {
      const state = await this.ctx.storage.get(KEY);
      if (!state) return;
      await this.pruneCreations(state);
      const entitlement = validEntitlement(state.entitlement, this.now()) ? state.entitlement : { active: false, plan: null, validUntil: null, checkedAt: state.entitlement.checkedAt };
      await this.reconcile(state, entitlement);
    });
  }
}
