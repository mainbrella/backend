import { AccountProduction } from './account-production.js';
import { PRODUCTION_LEASE_MS, PRODUCTION_POLL_MS, validLifecycle, validStartupCommand } from './production-policy.js';
import { PLAN_LIMITS, NO_PLAN_LIMITS, entitlementHeaders, requestEntitlement, validEntitlement, MACHINE_SIZES, machineSize } from './plan-policy.js';
import { IMAGE_CATALOG } from './image-catalog.js';
import { readFileBytes } from './file-contract.js';
import { AccountWorkspaces } from './workspaces.js';
import { AccountBilling } from './account-billing.js';
import { validSpendLimit } from './usage-policy.js';
import { prepaidState, utcPeriod } from './prepaid-wallet.js';

const KEY = 'containerAccount';
const CREATION_PREFIX = 'creation:';
const CREATION_RETENTION_MS = 24 * 60 * 60_000;
export const validIdempotencyKey = key => typeof key === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(key);
export const validContainerName = name => typeof name === 'string' && name.trim().length > 0 && name.trim().length <= 80 && !/[\u0000-\u001f\u007f]/.test(name);
export const validContainerId = (id) => id === 'small' || /^c(?:[1-9]\d{0,2})$/.test(id) && Number(id.slice(1)) < 500;
export const machineName = (userId, id) => id === 'small' ? `user:${userId}` : `user:${userId}:slot:${id.slice(1)}`;

// One serialized account owner reserves every start before provisioning a slot.
// It survives restarts and plan/customer/subscription changes without resetting usage.
export class ContainerAccountController {
  constructor(ctx, machineFor, now = () => Date.now(), invoiceUsage, refreshEntitlement, recharge, accountingSink) {
    Object.assign(this, { ctx, machineFor, now, refreshEntitlement, accountingSink });
    this.production = new AccountProduction(this);
    this.tail = Promise.resolve();
    this.workspaces = new AccountWorkspaces(this);
    this.billing = new AccountBilling(this, invoiceUsage, recharge);
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
    // A versioned private start path prevents a runtime downgrade between
    // discovery and boot from silently ignoring the internet-off selection.
    const path = method === 'POST' && selection?.lifecycle === 'production' ? '/container/production-v1' : method === 'POST' && selection?.workspaceId ? '/container/workspace-v1' : method === 'POST' && selection?.internet === false ? '/container/network-v1' : '/container';
    const response = await this.machineFor(state.userId, id).fetch(new Request(`https://internal${path}`, {
      method, headers: { ...entitlementHeaders(entitlement), 'x-mainbrella-user': state.userId, 'x-mainbrella-container': id, ...(selection?.recover ? { 'x-mainbrella-recover': '1' } : {}), ...(reservationId ? { 'x-mainbrella-reservation': String(reservationId) } : {}), ...(state.leases?.[id] ? { 'x-mainbrella-compute-until': String(state.leases[id].endAt) } : {}), ...(method === 'POST' && selection ? { 'Content-Type': 'application/json' } : {}) },
      ...(method === 'POST' && selection ? { body: JSON.stringify(selection) } : {}),
    }));
    if (!response.ok) {
      if (path === '/container/production-v1' && response.status === 404) throw new Error('production_unavailable');
      if (path === '/container/network-v1' && response.status === 404) throw new Error('network_policy_unavailable');
      if (path === '/container/workspace-v1' && response.status === 404) throw new Error('persistence_unavailable');
      const data = await response.json().catch(() => null);
      if (data?.error === 'compute_allowance_exhausted') throw new Error('compute_allowance_exhausted');
      if (['workspace_expired','workspace_image_incompatible','workspace_restore_failed'].includes(data?.error)) throw new Error(data.error);
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
      state.computeUsage ??= {};
      state.leases ??= {};
      state.pending ??= {};
      state.reservations ??= {};
      state.nextReservationId ??= 0;
      return state;
    }
    // Preserve legacy slot and starts. An unpaid legacy machine is stopped by
    // the slot's entitlement check, while its historical usage remains intact.
    state = { userId, slots: ['small'], usage: {}, computeUsage: {}, leases: {}, pending: {}, reservations: {}, nextReservationId: 0, entitlement };
    const legacy = await this.machine(state, 'small', 'GET', entitlement);
    state.imageCatalog = legacy.imageCatalog ?? [];
    if (legacy.usage?.month && Number.isSafeInteger(legacy.usage.starts)) state.usage[legacy.usage.month] = legacy.usage.starts;
    if (!legacy.containers?.length) state.slots = [];
    await this.ctx.storage.put(KEY, state);
    return state;
  }
  // Runtime is reserved durably before provisioning. A successful stop releases
  // only the unused portion, once; unreadable machines retain their reservation.
  settleLease(state, id, stoppedAt = this.now()) {
    const lease = state.leases[id];
    if (!lease) return;
    this.billing.record(state, lease, stoppedAt);
    if (lease.billing?.kind === 'prepaid') this.billing.wallet.finish(state, lease, stoppedAt);
    const elapsed = Math.max(0, Math.min(lease.endAt, stoppedAt) - lease.startAt);
    const refund = lease.unitMs - elapsed * machineSize(lease.size).computeUnits;
    state.computeUsage[lease.month] = Math.max(0, (state.computeUsage[lease.month] ?? 0) - refund);
    delete state.leases[id];
  }
  clampLease(state, id, endAt) {
    const lease = state.leases[id];
    if (!lease || !Number.isFinite(endAt) || endAt >= lease.endAt) return;
    endAt = Math.max(lease.startAt, endAt);
    const refund = (lease.endAt - endAt) * machineSize(lease.size).computeUnits;
    state.computeUsage[lease.month] = Math.max(0, (state.computeUsage[lease.month] ?? 0) - refund);
    lease.endAt = endAt;
    lease.unitMs -= refund;
  }
  reserveLease(state, id, size, endAt) {
    const startAt = this.now();
    const date = new Date(startAt);
    const month = date.toISOString().slice(0, 7);
    const limits = PLAN_LIMITS[state.entitlement.plan];
    const remaining = state.entitlement.plan === 'usage' ? this.billing.remainingUnitMs(state)
      : limits.maxComputeUnitHours * 3600000 - (state.computeUsage[month] ?? 0);
    endAt = Math.min(endAt, state.entitlement.plan === 'usage' ? state.entitlement.billing?.kind === 'prepaid' ? Infinity : state.entitlement.billing?.periodEnd ?? startAt : Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1),
      startAt + Math.max(0, Math.floor(remaining / size.computeUnits)));
    const unitMs = (endAt - startAt) * size.computeUnits;
    state.computeUsage[month] = (state.computeUsage[month] ?? 0) + unitMs;
    state.leases[id] = { size: size.id, startAt, endAt, month, unitMs };
    this.billing.attach(state, state.leases[id], id);
    return endAt;
  }
  async stopIndependently(state, ids, entitlement) {
    const failed = [];
    for (let offset = 0; offset < ids.length; offset += 20) {
      const batch = ids.slice(offset, offset + 20);
      const results = await Promise.allSettled(batch.map(id => this.machine(state, id, 'DELETE', entitlement)));
      results.forEach((result, index) => { if (result.status === 'rejected') failed.push(batch[index]);
        else this.settleLease(state, batch[index], result.value.lastRun?.stoppedAt ?? this.now()); });
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
    const container = (state.reservations[record.slot] === record.reservationId || state.production?.[record.slot]?.initialReservationId === record.reservationId) && containers.find(c => c.id === record.slot);
    if (!container) return this.respond({ error: 'creation_no_longer_running', creation: { id: record.id, containerId: record.slot, status: 'stopped' } }, 409);
    return this.respond({ ...this.status(state, containers), creation: { id: record.id, containerId: record.slot, createdAt: container.createdAt, status: container.status } });
  }
  async saveState(state, retry = false) {
    state.leases ??= {};
    state.computeUsage ??= {};
    const month = new Date(this.now()).toISOString().slice(0, 7);
    state.usage = { [month]: state.usage[month] ?? 0 };
    const retainedMonths = new Set([month, ...Object.values(state.leases).map(lease => lease.month)]);
    state.computeUsage = Object.fromEntries(Object.entries(state.computeUsage).filter(([key]) => retainedMonths.has(key)));
    state.pending = Object.fromEntries(Object.entries(state.pending).filter(([id]) => state.slots.includes(id)));
    await this.ctx.storage.put(KEY, state);
    let alarmAt;
    await this.billing.wallet.flushAccounting(state);
    if (Object.keys(state.wallet?.accounting?.pending ?? {}).length) alarmAt = this.now() + 60_000;
    if (retry && state.slots.length) alarmAt = this.now() + 30_000;
    else if (state.entitlement.active && state.slots.length) {
      alarmAt = Math.min(state.entitlement.validUntil, ...Object.values(state.pending).map(at => at + 90_000));
    }
    if (Object.values(state.leases).some(lease => lease.billing) || Object.values(state.billingPeriods ?? {}).some(period => period.pending)) {
      alarmAt = Math.min(alarmAt ?? Infinity, this.now() + 60_000);
    }
    if (Object.keys(state.production ?? {}).length) alarmAt = Math.min(alarmAt ?? Infinity, this.now() + PRODUCTION_POLL_MS);
    if (state.wallet?.pendingRecharge) alarmAt = Math.min(alarmAt ?? Infinity, this.now() + 60000);
    if (state.nextCreationExpiry) alarmAt = Math.min(alarmAt ?? Infinity, state.nextCreationExpiry);
    const workspaceAlarm = await this.workspaces.nextAlarm();
    if (Number.isFinite(workspaceAlarm)) alarmAt = Math.min(alarmAt ?? Infinity, workspaceAlarm);
    if (alarmAt) await this.ctx.storage.setAlarm(alarmAt);
    else await this.ctx.storage.deleteAlarm();
  }
  async reconcile(state, entitlement, recoverProduction = true) {
    if (prepaidState(state)) {
      await this.billing.wallet.maybeRecharge(state);
      if (state.wallet?.fundingRevoked) {
        state.entitlement = { active: false, plan: null, validUntil: null, checkedAt: Math.max(this.now(), (state.entitlement?.checkedAt ?? 0) + (state.entitlement?.active ? 1 : 0)) };
        await this.saveState(state, true);
        const failed = await this.stopIndependently(state, state.slots, state.entitlement);
        state.slots = [...new Set([...failed, ...Object.keys(state.production ?? {})])];
        if (!failed.length && this.billing.wallet.metrics(state).remaining >= 0) delete state.wallet.fundingRevoked;
        await this.saveState(state, failed.length > 0);
        if (failed.length) throw new Error('container_reconciliation_failed');
      }
      entitlement = this.prepaidEntitlement(state);
    }
    if ((state.entitlement?.checkedAt ?? 0) > (entitlement.checkedAt ?? 0)
      || (state.entitlement?.checkedAt === entitlement.checkedAt && !state.entitlement.active && entitlement.active)) entitlement = state.entitlement;
    if (!validEntitlement(entitlement, this.now())) entitlement = { active: false, plan: null, validUntil: null, checkedAt: entitlement.checkedAt };
    state.entitlement = entitlement;
    // A durable retry precedes any fanout: interruption or one unavailable DO
    // cannot erase the revocation decision or abandon the rest of the account.
    await this.saveState(state, true);
    if (!entitlement.active) {
      const failed = await this.stopIndependently(state, state.slots, entitlement);
      state.slots = [...new Set([...failed, ...Object.keys(state.production ?? {})])];
      await this.saveState(state, failed.length > 0);
      if (failed.length) throw new Error('container_reconciliation_failed');
      return Object.keys(state.production ?? {}).map(id => this.production.stopped(state, id, 'subscription_required'));
    }
    if (recoverProduction) for (const id of state.slots) this.production.renew(state, id);
    // Commit new compute reservations before extending any runtime deadline.
    await this.ctx.storage.put(KEY, state);
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
          this.clampLease(state, id, Math.min(reservation + (state.production?.[id] ? PRODUCTION_LEASE_MS : PLAN_LIMITS[entitlement.plan].maxSessionMs), entitlement.validUntil));
          return { id, name: state.leases[id]?.name ?? (id === 'small' ? 'Small container' : `Small container ${Number(id.slice(1)) + 1}`),
            lifecycle: state.production?.[id] ? 'production' : 'ad_hoc', size: state.leases[id]?.size ?? 'lite', instance: machineSize(state.leases[id]?.size ?? state.production?.[id]?.selection.size ?? 'lite').instance,
            computeUnits: machineSize(state.leases[id]?.size ?? state.production?.[id]?.selection.size ?? 'lite').computeUnits, internet: state.leases[id]?.internet ?? true, status: 'starting', createdAt: new Date(reservation).toISOString(),
            expiresAt: new Date(Math.min(reservation + (state.production?.[id] ? PRODUCTION_LEASE_MS : PLAN_LIMITS[entitlement.plan].maxSessionMs), entitlement.validUntil, state.leases[id]?.endAt ?? Infinity)).toISOString() };
        }
        delete state.pending[id];
        const data = await this.machine(state, id, 'GET', entitlement);
        state.imageCatalog = data.imageCatalog ?? [];
        if (!data.containers?.[0]) {
          // Fence delayed boot dispatches before releasing an apparently empty
          // slot, including recovery after an interrupted provisioning request.
          if (state.production?.[id]) {
            if (recoverProduction) return this.production.recover(state, id, data.lastRun);
            this.settleLease(state, id, data.lastRun?.stoppedAt ?? this.now());
            return this.production.stopped(state, id, 'runtime_unavailable');
          }
          const stopped = await this.machine(state, id, 'DELETE', entitlement);
          this.settleLease(state, id, stopped.lastRun?.stoppedAt ?? this.now());
          return null;
        }
        if (!state.leases[id]) {
          const size = machineSize(data.containers[0].size ?? 'lite');
          this.reserveLease(state, id, size, Math.max(this.now(), Date.parse(data.containers[0].expiresAt)));
          await this.ctx.storage.put(KEY, state);
          const clamped = await this.machine(state, id, 'GET', entitlement);
          if (!clamped.containers?.[0]) {
            const stopped = await this.machine(state, id, 'DELETE', entitlement);
            this.settleLease(state, id, stopped.lastRun?.stoppedAt ?? this.now());
            return null;
          }
          data.containers[0] = clamped.containers[0];
        }
        if (state.production?.[id]) state.production[id].createdAt = data.containers[0].createdAt;
        this.clampLease(state, id, Date.parse(data.containers[0].expiresAt));
        this.billing.record(state, state.leases[id], this.now());
        return { ...data.containers[0], id, name: state.leases[id]?.name ?? (id === 'small' ? 'Small container' : `Small container ${Number(id.slice(1)) + 1}`) };
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
    if (unreadable.length > limits.maxContainers || unreadable.reduce((sum, id) => sum + machineSize(state.leases[id]?.size ?? state.production?.[id]?.selection.size ?? 'lite').computeUnits, 0) > limits.maxConcurrentComputeUnits) unreadable = await this.stopIndependently(state, unreadable, entitlement);
    const weight = id => machineSize(state.leases[id]?.size ?? state.production?.[id]?.selection.size ?? 'lite').computeUnits;
    let units = unreadable.reduce((sum, id) => sum + weight(id), 0);
    const retained = [];
    const excess = [];
    for (const container of results) {
      if (retained.length + unreadable.length < limits.maxContainers && units + weight(container.id) <= limits.maxConcurrentComputeUnits) {
        retained.push(container); units += weight(container.id);
      } else excess.push(container);
    }
    let failedStops = await this.stopIndependently(state, excess.map(c => c.id), entitlement);
    // A failed stop still occupies a slot. Keep stopping reachable excess until
    // all remaining known machines fit, instead of aborting on the first error.
    while (retained.length && (retained.length + unreadable.length + failedStops.length > limits.maxContainers || [...retained.map(c => c.id), ...unreadable, ...failedStops].reduce((sum, id) => sum + weight(id), 0) > limits.maxConcurrentComputeUnits)) {
      const count = 1;
      const extra = retained.splice(retained.length - count);
      failedStops.push(...await this.stopIndependently(state, extra.map(c => c.id), entitlement));
    }
    const month = new Date(this.now()).toISOString().slice(0, 7);
    while (retained.length && limits.maxComputeUnitHours !== null && (state.computeUsage[month] ?? 0) > limits.maxComputeUnitHours * 3600000) {
      const extra = retained.pop();
      failedStops.push(...await this.stopIndependently(state, [extra.id], entitlement));
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
    const limits = state.entitlement.active ? PLAN_LIMITS[state.entitlement.plan] : NO_PLAN_LIMITS;
    const reservedUnitMs = Object.values(state.leases).filter(lease => lease.month === month)
      .reduce((sum, lease) => sum + Math.max(0, lease.endAt - Math.max(this.now(), lease.startAt)) * machineSize(lease.size).computeUnits, 0);
    const committedUnitMs = state.computeUsage[month] ?? 0;
    const billing = this.billing.status(state);
    const prepaid = prepaidState(state) ? this.billing.wallet.metrics(state) : null;
    return { billing, sizes: MACHINE_SIZES, plan: state.entitlement.plan, active: state.entitlement.active,
      limits: state.entitlement.active ? PLAN_LIMITS[state.entitlement.plan] : NO_PLAN_LIMITS,
      usage: { month, starts: state.usage[month] ?? 0,
        computeUnitHours: prepaid ? prepaid.monthly / 3600000 : Math.max(0, committedUnitMs - reservedUnitMs) / 3600000,
        reservedComputeUnitHours: (prepaid ? prepaid.monthReserved : reservedUnitMs) / 3600000,
        availableComputeUnitHours: state.entitlement.plan === 'usage' ? this.billing.remainingUnitMs(state) / 3600000 : Math.max(0, limits.maxComputeUnitHours - committedUnitMs / 3600000),
        concurrentComputeUnits: state.slots.reduce((sum, id) => sum + machineSize(state.leases[id]?.size ?? state.production?.[id]?.selection.size ?? 'lite').computeUnits, 0) }, containers, imageCatalog: state.imageCatalog ?? [] };
  }
  prepaidEntitlement(state) {
    const active = Boolean(state.wallet && !state.wallet.fundingRevoked && this.billing.wallet.metrics(state).balance > 0);
    return { active, plan: active ? 'usage' : null, validUntil: active ? this.now() + 86400000 : null,
      checkedAt: Math.max(this.now(), (state.entitlement?.checkedAt ?? 0) + (active !== state.entitlement?.active ? 1 : 0)),
      ...(state.wallet ? { billing: { kind: 'prepaid', customerId: state.wallet.customerId, ...utcPeriod(this.now()) } } : {}) };
  }
  async prepaidRequest(request, path) {
    const userId = request.headers.get('x-mainbrella-user');
    if (!userId || !/^[A-Za-z0-9_-]{1,128}$/.test(userId)) return this.respond({ error: 'not_authenticated' }, 401);
    const read = path === '/billing/balance' || path === '/billing/history';
    if (request.method !== (read ? 'GET' : 'POST')) return this.respond({ error: 'method_not_allowed' }, 405);
    const load = async () => {
      const stored = await this.ctx.storage.get(KEY);
      if (stored && stored.userId !== userId) throw new Error('account_mismatch');
      return stored ?? { userId, slots: [], usage: {}, computeUsage: {}, leases: {}, pending: {}, reservations: {}, nextReservationId: 0,
        entitlement: { active: false, plan: null, validUntil: null, checkedAt: this.now() } };
    };
    try {
      // Entitlement refresh can call this same DO while an alarm holds the
      // mutation lock. A balance read neither acquires it nor provisions guests.
      if (read) {
        const state = await load();
        if (path === '/billing/balance') return this.respond({ balance: this.billing.wallet.status(state) });
        const query = new URL(request.url).searchParams, limit = Number(query.get('limit') ?? 50);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100 || [...query.keys()].some(key => !['limit', 'resourceCursor', 'fundingCursor'].includes(key))) throw new Error('invalid_request');
        return this.respond(this.billing.wallet.history(state, { limit, resourceCursor: query.get('resourceCursor'), fundingCursor: query.get('fundingCursor') }));
      }
      return await this.serialized(async () => {
        const state = await load(), body = await request.json();
        if (path === '/billing/accounting-checkpoint') {
          const asOf = this.now();
          this.billing.wallet.checkpoint(state, asOf);
          this.billing.wallet.fundingEvidence(state);
          const fundings = Object.values(state.wallet?.fundings ?? {}).map(row => ({ id: row.id, creditCents: row.amountCents, revokedCents: row.disputed ? row.amountCents : row.refundedCents }));
          const usedUnitMs = state.wallet?.usedUnitMs ?? 0;
          this.billing.wallet.queue(state, { key: `wallet_checkpoint:${crypto.randomUUID()}`, type: 'wallet_checkpoint', occurredAt: asOf,
            data: { asOf, usedUnitMs, fundings } });
          await this.saveState(state);
          return this.respond({ asOf, usedUnitMs, fundings, pendingEvents: Object.keys(state.wallet?.accounting?.pending ?? {}).length });
        }
        if (path === '/billing/settings') this.billing.wallet.settings(state, body);
        else if (this.billing.wallet.applyFunding(state, body)) state.wallet.fundingRevoked = true;
        state.entitlement = this.prepaidEntitlement(state);
        // Revocations survive interruption before any pending boot is fenced.
        await this.saveState(state, true);
        if (state.wallet?.fundingRevoked && state.slots.length) {
          const ids = [...state.slots];
          const failed = await this.stopIndependently(state, ids, { active: false, plan: null, validUntil: null, checkedAt: state.entitlement.checkedAt });
          for (const id of ids) if (!failed.includes(id)) delete state.pending[id];
          state.slots = [...new Set([...failed, ...Object.keys(state.production ?? {})])];
          if (!failed.length && this.billing.wallet.metrics(state).remaining >= 0) delete state.wallet.fundingRevoked;
        } else if (state.wallet?.fundingRevoked && this.billing.wallet.metrics(state).remaining >= 0) delete state.wallet.fundingRevoked;
        state.entitlement = this.prepaidEntitlement(state);
        await this.saveState(state, Boolean(state.wallet?.fundingRevoked));
        return this.respond({ balance: this.billing.wallet.status(state) });
      });
    } catch (error) {
      const status = error.message === 'account_mismatch' ? 403 : error.message === 'spend_limit_below_committed_usage' || error.message === 'payment_conflict' ? 409 : 400;
      return this.respond({ error: ['account_mismatch','spend_limit_below_committed_usage','payment_conflict','invalid_payment','invalid_customer','invalid_request','invalid_spend_limit','invalid_auto_recharge','invalid_history_cursor'].includes(error.message) ? error.message : 'invalid_request' }, status);
    }
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (['/billing/balance', '/billing/history', '/billing/funding', '/billing/settings', '/billing/accounting-checkpoint'].includes(url.pathname)) return this.prepaidRequest(request, url.pathname);
    if (url.pathname === '/billing/invoice') {
      if (request.method !== 'POST') return this.respond({ error: 'method_not_allowed' }, 405);
      return this.serialized(async () => {
        const state = await this.ctx.storage.get(KEY);
        if (!state) return this.respond({ invoiced: true });
        if (request.headers.get('x-mainbrella-user') !== state.userId) return this.respond({ error: 'account_mismatch' }, 403);
        // Confirm stops and final runtime before closing any billing period.
        const context = await request.json();
        await this.reconcile(state, context.entitlement ?? state.entitlement);
        await this.billing.invoice(state, context);
        await this.saveState(state);
        return this.respond({ invoiced: true });
      });
    }
    if (url.pathname === '/workspaces') return this.workspaces.fetch(request);
    const billingRequest = url.pathname === '/billing';
    if (url.pathname !== '/containers' && !billingRequest) return this.respond({ error: 'not_found' }, 404);
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
      let selection = request.method === 'POST' && request.body ? await request.json() : undefined;
      let size = machineSize(selection?.size ?? 'lite');
      if (!size) return this.respond({ error: 'invalid_size' }, 400);
      if (selection?.internet !== undefined && typeof selection.internet !== 'boolean') return this.respond({ error: 'invalid_internet_policy' }, 400);
      if (selection?.name !== undefined) {
        if (!validContainerName(selection.name)) return this.respond({ error: 'invalid_container_name' }, 400);
        selection.name = selection.name.trim();
      }
      if (selection?.lifecycle !== undefined && !validLifecycle(selection.lifecycle)) return this.respond({ error: 'invalid_lifecycle' }, 400);
      if (selection?.startupCommand !== undefined && (!validStartupCommand(selection.startupCommand) || selection.lifecycle !== 'production')) return this.respond({ error: 'invalid_startup_command' }, 400);
      const baseFingerprint = selection?.workspaceId ? JSON.stringify(['workspace', selection.workspaceId, selection.size ?? null, selection.internet ?? null])
        : JSON.stringify([selection?.imageKey ?? 'terminal', selection?.imageId ?? null, size.id, ...(selection?.internet === false ? [false] : [])]);
      const namedFingerprint = selection?.name === undefined ? baseFingerprint : JSON.stringify([baseFingerprint, selection.name]);
      const fingerprint = selection?.lifecycle === 'production' ? JSON.stringify([namedFingerprint, 'production', selection.startupCommand ?? '']) : namedFingerprint;
      const result = await this.serialized(async () => {
        const state = await this.initialize(userId, suppliedEntitlement);
        await this.pruneCreations(state);
        let entitlement = cleanupOnly && validEntitlement(state.entitlement, this.now()) ? state.entitlement : suppliedEntitlement;
        let containers = await this.reconcile(state, entitlement, request.method !== 'DELETE');
        entitlement = state.entitlement;
        // Stop/status paths remain available even if usage invoicing is down.
        if (billingRequest) {
          if (request.method === 'POST') {
            if (entitlement.plan !== 'usage' || !entitlement.active) return this.respond({ error: 'subscription_required' }, 402);
            if (!validSpendLimit(selection?.spendLimitCents)) return this.respond({ error: 'invalid_spend_limit' }, 400);
            if (selection.spendLimitCents > 500 && selection.authorizeOverages !== true) return this.respond({ error: 'overage_authorization_required' }, 400);
            if (selection.spendLimitCents < (this.billing.status(state)?.committedCents ?? 500)) return this.respond({ error: 'spend_limit_below_committed_usage' }, 409);
            state.spendLimitCents = selection.spendLimitCents;
            state.overageConsent = selection.spendLimitCents > 500 ? { authorizedAt: this.now(), spendLimitCents: selection.spendLimitCents } : null;
            await this.saveState(state);
          }
          return this.respond({ billing: this.billing.status(state) });
        }
        if (request.method === 'POST') {
          if (selection?.lifecycle === 'production' && entitlement.plan !== 'usage') return this.respond({ error: 'production_requires_usage' }, 402);
          if (selection?.lifecycle === 'production' && selection?.workspaceId) return this.respond({ error: 'invalid_request' }, 400);
          if (entitlement.plan === 'usage') {
            if (!entitlement.billing || entitlement.billing.kind !== 'prepaid' && !this.billing.invoiceUsage) return this.respond({ error: 'billing_unavailable' }, 503);
            this.billing.checkPending(state);
          }
          if (!validEntitlement(entitlement, this.now())) {
            await this.reconcile(state, { active: false, plan: null, validUntil: null, checkedAt: entitlement.checkedAt });
            return this.respond({ error: 'subscription_required' }, 402);
          }
          if (idempotencyKey) {
            const record = await this.ctx.storage.get(CREATION_PREFIX + idempotencyKey);
            if (record && record.expiresAt > this.now()) {
              const legacyFingerprint = selection?.lifecycle !== 'production' && selection?.name === undefined && size.id === 'lite' && selection?.internet !== false ? JSON.stringify([selection?.imageKey ?? 'terminal', selection?.imageId ?? null]) : null;
              if (record.fingerprint !== fingerprint && record.fingerprint !== legacyFingerprint) return this.respond({ error: 'idempotency_key_conflict' }, 409);
              return this.creationResponse(state, containers, record);
            }
          }
          const catalogImage = IMAGE_CATALOG.find(image => image.key === selection?.imageKey);
          if (selection?.workspaceId) {
            selection = await this.workspaces.restoreSelection(state, selection);
            size = machineSize(selection.size);
          }
          if (catalogImage && !(state.imageCatalog ?? []).some(image => image.id === catalogImage.id)) {
            return this.respond({ error: 'image_not_available' }, 409);
          }
          const limits = PLAN_LIMITS[entitlement.plan];
          const concurrentUnits = state.slots.reduce((sum, id) => sum + machineSize(state.leases[id]?.size ?? state.production?.[id]?.selection.size ?? 'lite').computeUnits, 0);
          if (concurrentUnits + size.computeUnits > limits.maxConcurrentComputeUnits) return this.respond({ error: 'compute_capacity_exceeded' }, 409);
          if (state.slots.length >= limits.maxContainers) return this.respond({ error: 'container_limit_exceeded' }, 409);
          const month = new Date(this.now()).toISOString().slice(0, 7);
          if ((state.usage[month] ?? 0) >= limits.maxStartsPerMonth) return this.respond({ error: 'container_quota_exceeded' }, 429);
          const startAt = this.now();
          if (selection?.lifecycle === 'production' && prepaidState(state)) {
            await this.billing.wallet.maybeRecharge(state, size.computeUnits);
            if (!this.billing.wallet.canLaunchProduction(state, size)) return this.respond({ error: 'insufficient_production_balance' }, 402);
          }
          const monthEnd = Date.UTC(new Date(startAt).getUTCFullYear(), new Date(startAt).getUTCMonth() + 1, 1);
          const remaining = state.entitlement.plan === 'usage' ? this.billing.remainingUnitMs(state)
            : limits.maxComputeUnitHours * 3600000 - (state.computeUsage[month] ?? 0);
          const endAt = Math.min(startAt + (selection?.lifecycle === 'production' ? PRODUCTION_LEASE_MS : limits.maxSessionMs), entitlement.validUntil, entitlement.plan === 'usage' ? entitlement.billing.kind === 'prepaid' ? Infinity : entitlement.billing.periodEnd : monthEnd,
            startAt + Math.floor(remaining / size.computeUnits));
          if (endAt <= startAt || (entitlement.plan === 'usage' && endAt - startAt < 1000)) return this.respond({ error: entitlement.plan === 'usage' ? 'spend_limit_reached' : 'compute_allowance_exhausted' }, 429);
          const slot = Array.from({ length: limits.maxContainers }, (_, index) => index === 0 ? 'small' : `c${index}`).find(candidate => !state.slots.includes(candidate));
          if (selection?.workspaceId) {
            const response = await this.machineFor(state.userId, slot).fetch(new Request('https://internal/workspaces/restore-preflight-v1', {
              method:'POST',body:JSON.stringify({imageKey:selection.imageKey,imageDigest:selection.imageDigest,expiresAt:selection.workspaceExpiresAt}) }));
            if (!response.ok) {
              const data = await response.json().catch(()=>null);
              return this.respond({error:data?.error==='workspace_image_incompatible'?'workspace_image_incompatible':data?.error==='workspace_expired'?'workspace_expired':'persistence_unavailable'}, data?.error==='workspace_expired'?410:data?.error==='workspace_image_incompatible'?409:503);
            }
          }
          if (selection?.internet === false || selection?.lifecycle === 'production') {
            try {
              const signal = AbortSignal.timeout(5000);
              const response = await this.machineFor(state.userId, slot).fetch(new Request('https://internal/features', { signal }));
              const bytes = await readFileBytes(response.body, 2048, signal);
              const features = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
              if (selection?.lifecycle === 'production' && (!response.ok || features?.protocol !== 1 || features?.production !== 1)) return this.respond({ error: 'production_unavailable' }, 503);
              if (selection?.internet === false && (!response.ok || features?.protocol !== 1 || features?.internetControl !== true)) throw new Error('network_policy_unavailable');
            } catch { return this.respond({ error: selection?.lifecycle === 'production' ? 'production_unavailable' : 'network_policy_unavailable' }, 503); }
          }
          state.usage[month] = (state.usage[month] ?? 0) + 1;
          state.slots.push(slot);
          const unitMs = (endAt - startAt) * size.computeUnits;
          state.computeUsage[month] = (state.computeUsage[month] ?? 0) + unitMs;
          state.leases[slot] = { size: size.id, startAt, endAt, month, unitMs, internet: selection?.internet ?? true, ...(selection?.name === undefined ? {} : { name: selection.name }) };
          if (selection?.lifecycle === 'production') {
            state.leases[slot].lifecycle = 'production';
            this.production.remember(state, slot, { ...selection, size: size.id });
          }
          this.billing.attach(state, state.leases[slot], slot);
          state.pending[slot] = this.now();
          const reservationId = ++state.nextReservationId;
          state.reservations[slot] = reservationId;
          if (state.production?.[slot]) state.production[slot].initialReservationId = reservationId;
          const creation = idempotencyKey ? { id: crypto.randomUUID(), slot, reservationId, fingerprint, expiresAt: this.now() + CREATION_RETENTION_MS } : undefined;
          if (creation) {
            state.nextCreationExpiry = Math.min(state.nextCreationExpiry ?? Infinity, creation.expiresAt);
            // Multi-key puts are atomic: the key and charged reservation survive together.
            await this.ctx.storage.put({ [KEY]: state, [CREATION_PREFIX + idempotencyKey]: creation });
          } else await this.ctx.storage.put(KEY, state);
          await this.ctx.storage.setAlarm(Math.min(entitlement.validUntil, this.now() + 90_000, state.nextCreationExpiry ?? Infinity));
          reservation = { state, slot, entitlement, reservationId, creation, selection: { ...selection, size: size.id, computeExpiresAt: endAt } };
          return null;
        }
        if (request.method === 'DELETE') {
          if (!id && containers.length > 1) return this.respond({ error: 'container_id_required' }, 400);
          const target = id ?? containers[0]?.id;
          if (target && !state.slots.includes(target)) return this.respond({ error: 'container_not_running' }, 409);
          const generation = url.searchParams.get('createdAt');
          if (generation && containers.find(c => c.id === target)?.createdAt !== generation) return this.respond({ error: 'container_not_running' }, 409);
          if (target) {
            if (state.production?.[target]) { delete state.production[target]; await this.ctx.storage.put(KEY, state); }
            const stopped = await this.machine(state, target, 'DELETE', entitlement);
            this.settleLease(state, target, stopped.lastRun?.stoppedAt ?? this.now());
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
      await this.machine(state, slot, 'POST', entitlement, reservationId, reservation.selection);
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
      if (error.message === 'compute_allowance_exhausted') return this.respond({ error: error.message }, 429);
      if (error.message === 'subscription_required') return this.respond({ error: error.message }, 402);
      if (['billing_unavailable','billing_reconciliation_required','network_policy_unavailable','persistence_unavailable','production_unavailable'].includes(error.message)) return this.respond({ error: error.message }, 503);
      if (error.message === 'workspace_expired') return this.respond({error:error.message},410);
      if (error.message === 'workspace_not_found') return this.respond({error:error.message},404);
      if (['workspace_not_ready','workspace_policy_conflict','workspace_image_incompatible','workspace_restore_failed'].includes(error.message)) return this.respond({error:error.message},409);
      return this.respond({ error: 'containers_unavailable' }, 503);
    }
  }
  alarm() {
    return this.serialized(async () => {
      const state = await this.ctx.storage.get(KEY);
      if (!state) return;
      await this.workspaces.prune();
      await this.pruneCreations(state);
      let fresh = state.entitlement;
      if (Object.keys(state.production ?? {}).length && this.refreshEntitlement && (!validEntitlement(fresh, this.now()) || fresh.validUntil - this.now() < 60_000)) {
        try { fresh = await this.refreshEntitlement(state.userId); } catch { /* Existing paid deadlines remain authoritative during an outage. */ }
      }
      const entitlement = validEntitlement(fresh, this.now()) ? fresh : { active: false, plan: null, validUntil: null, checkedAt: state.entitlement.checkedAt };
      try { await this.reconcile(state, entitlement); } finally {
        await this.saveState(state, true);
      }
    });
  }
}
