import { PRODUCTION_LEASE_MS, PRODUCTION_POLL_MS } from './production-policy.js';
import { machineSize } from './plan-policy.js';

// Desired service identity survives provider stops and paid billing-period
// boundaries. Explicit deletion removes it before any asynchronous cleanup.
export class AccountProduction {
  constructor(account) { this.account = account; }
  remember(state, id, selection) {
    state.production ??= {};
    state.production[id] = { createdAt: new Date(this.account.now()).toISOString(), selection: { ...selection, lifecycle: 'production' }, retryAt: 0, failures: 0 };
  }
  renew(state, id) {
    const lease = state.leases[id];
    if (!state.production?.[id] || !lease || lease.endAt <= this.account.now() || state.entitlement.plan !== 'usage') return;
    const size = machineSize(lease.size);
    const endAt = Math.min(this.account.now() + PRODUCTION_LEASE_MS, state.entitlement.validUntil, lease.billing.periodEnd,
      lease.endAt + Math.floor(this.account.billing.remainingUnitMs(state) / size.computeUnits));
    if (endAt <= lease.endAt) return;
    const extra = (endAt - lease.endAt) * size.computeUnits;
    state.computeUsage[lease.month] = (state.computeUsage[lease.month] ?? 0) + extra;
    lease.unitMs += extra;
    lease.endAt = endAt;
  }
  stopped(state, id, reason) {
    const desired = state.production[id], selection = desired.selection, size = machineSize(selection.size);
    return { id, name: selection.name ?? id, size: size.id, instance: size.instance, computeUnits: size.computeUnits,
      lifecycle: 'production', internet: selection.internet ?? true, status: 'stopped', stopReason: reason,
      createdAt: desired.createdAt ?? new Date(this.account.now()).toISOString(), expiresAt: new Date(this.account.now()).toISOString(),
      ...(selection.imageName ? { imageName: selection.imageName } : {}) };
  }
  async recover(state, id, lastRun) {
    const a = this.account, desired = state.production[id];
    a.settleLease(state, id, lastRun?.stoppedAt ?? a.now());
    if (state.entitlement.plan !== 'usage') return this.stopped(state, id, 'subscription_required');
    if (desired.retryAt > a.now()) return this.stopped(state, id, 'runtime_unavailable');
    a.billing.checkPending(state);
    const size = machineSize(desired.selection.size);
    const endAt = a.reserveLease(state, id, size, Math.min(a.now() + PRODUCTION_LEASE_MS, state.entitlement.validUntil));
    if (endAt - a.now() < 1000) {
      a.settleLease(state, id, a.now());
      return this.stopped(state, id, 'spend_limit_reached');
    }
    Object.assign(state.leases[id], { lifecycle: 'production', name: desired.selection.name, internet: desired.selection.internet ?? true });
    state.reservations[id] = ++state.nextReservationId;
    desired.failures += 1;
    desired.retryAt = a.now() + Math.min(300_000, PRODUCTION_POLL_MS * 2 ** Math.min(desired.failures - 1, 4));
    await a.ctx.storage.put('containerAccount', state);
    try {
      const result = await a.machine(state, id, 'POST', state.entitlement, state.reservations[id],
        { ...desired.selection, recover: lastRun?.lifecycle === 'production' && lastRun.reservationId >= desired.initialReservationId, computeExpiresAt: endAt });
      const container = result.containers?.[0];
      if (!container) return this.stopped(state, id, 'runtime_unavailable');
      desired.createdAt = container.createdAt;
      desired.failures = 0; desired.retryAt = 0;
      return { ...container, id, name: desired.selection.name ?? id };
    } catch {
      // Keep the reservation on ambiguous boot failures. The next confirmed
      // status/stop settles it before another recovery attempt.
      return this.stopped(state, id, 'runtime_unavailable');
    }
  }
}
