import { machineSize } from './plan-policy.js';
import { USAGE_PRICING, validSpendLimit } from './usage-policy.js';

// Keep exact weighted milliseconds for the lifetime of the wallet. Rounding
// only happens when presenting cents, never when reserving or settling funds.
export const UNIT_MS_PER_CENT = 3600000 / USAGE_PRICING.centsPerComputeUnitHour;
export const MINIMUM_PRODUCTION_RUNTIME_MS = 86400000;
export const RETAINED_RESOURCE_LIMIT = 256;
export const prepaidState = state => Boolean(state.wallet || state.entitlement?.billing?.kind === 'prepaid');
export function utcPeriod(at) {
  const date = new Date(at);
  return { periodStart: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1),
    periodEnd: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) };
}
const prepaidLeases = state => Object.values(state.leases ?? {}).filter(lease => lease.billing?.kind === 'prepaid');
const unitsBetween = (lease, start, end) => Math.max(0, Math.min(end, lease.endAt) - Math.max(start, lease.meteredUntil)) * machineSize(lease.size).computeUnits;

export class PrepaidWallet {
  constructor(account, recharge) { this.account = account; this.recharge = recharge; }
  ensure(state, customerId) {
    if (!/^cus_[A-Za-z0-9_]+$/.test(customerId)) throw new Error('invalid_customer');
    if (state.wallet?.customerId && state.wallet.customerId !== customerId) throw new Error('account_mismatch');
    if (!state.wallet) {
      state.wallet = { customerId, fundings: {}, usedUnitMs: 0, monthlyUnitMs: {},
        autoRecharge: { enabled: false, amountCents: 500, monthlyLimitCents: 500, status: 'disabled' }, rechargeSpending: {} };
      // A legacy lease cannot be extended under wallet access without first
      // being stopped and replaced by a reservation charged to this wallet.
      if (Object.values(state.leases ?? {}).some(lease => lease.billing?.kind !== 'prepaid')) state.wallet.fundingRevoked = true;
    }
    return state.wallet;
  }
  metrics(state, now = this.account.now()) {
    const wallet = state.wallet;
    const { periodStart, periodEnd } = utcPeriod(now);
    const leases = prepaidLeases(state);
    const funded = Object.values(wallet?.fundings ?? {}).reduce((sum, funding) => sum + (funding.disputed ? 0 : funding.amountCents - funding.refundedCents), 0) * UNIT_MS_PER_CENT;
    const live = leases.reduce((sum, lease) => sum + unitsBetween(lease, lease.meteredUntil, now), 0);
    const reserved = leases.reduce((sum, lease) => sum + unitsBetween(lease, now, Infinity), 0);
    const month = new Date(now).toISOString().slice(0, 7);
    const monthly = (wallet?.monthlyUnitMs?.[month] ?? 0) + leases.reduce((sum, lease) => sum + unitsBetween(lease, periodStart, now), 0);
    const monthReserved = leases.reduce((sum, lease) => sum + unitsBetween(lease, Math.max(now, periodStart), periodEnd), 0);
    const balance = funded - (wallet?.usedUnitMs ?? 0) - live;
    return { funded, live, reserved, balance, remaining: balance - reserved, monthly, monthReserved, month, periodStart, periodEnd };
  }
  remainingUnitMs(state) {
    if (state.wallet?.fundingRevoked) return 0;
    const m = this.metrics(state);
    return Math.max(0, Math.min(m.remaining, (state.spendLimitCents ?? 500) * UNIT_MS_PER_CENT - m.monthly - m.monthReserved));
  }
  record(state, lease, stoppedAt) {
    const wallet = this.ensure(state, lease.billing.customerId);
    const end = Math.max(lease.meteredUntil, Math.min(stoppedAt, lease.endAt));
    const runtimeMs = end - lease.meteredUntil;
    const containerId = Object.entries(state.leases ?? {}).find(([, value]) => value === lease)?.[0];
    const resource = this.track(state, lease, containerId);
    if (resource) {
      resource.runtimeMs += runtimeMs;
      resource.unitMs += runtimeMs * machineSize(lease.size).computeUnits;
      resource.name = lease.name ?? null;
      resource.lifecycle = lease.lifecycle ?? 'ad_hoc';
    }
    wallet.usedUnitMs += runtimeMs * machineSize(lease.size).computeUnits;
    for (let at = lease.meteredUntil; at < end;) {
      const until = Math.min(end, utcPeriod(at).periodEnd), month = new Date(at).toISOString().slice(0, 7);
      wallet.monthlyUnitMs[month] = (wallet.monthlyUnitMs[month] ?? 0) + (until - at) * machineSize(lease.size).computeUnits;
      at = until;
    }
    lease.meteredUntil = end;
  }
  track(state, lease, containerId) {
    if (!containerId || lease.billing?.kind !== 'prepaid') return null;
    const wallet = this.ensure(state, lease.billing.customerId);
    wallet.resources ??= {};
    lease.resourceHistoryId ??= crypto.randomUUID();
    // Never attribute previously settled wallet usage to a reconstructed lease.
    return wallet.resources[lease.resourceHistoryId] ??= { id: lease.resourceHistoryId, containerId,
      name: lease.name ?? null, lifecycle: lease.lifecycle ?? 'ad_hoc', size: lease.size,
      startAt: lease.meteredUntil, endAt: null, runtimeMs: 0, unitMs: 0 };
  }
  finish(state, lease, stoppedAt) {
    const resource = state.wallet?.resources?.[lease.resourceHistoryId];
    if (!resource) return;
    resource.endAt = Math.max(resource.startAt, lease.meteredUntil, Math.min(stoppedAt, lease.endAt));
    const completed = Object.values(state.wallet.resources).filter(row => row.endAt !== null)
      .sort((a, b) => b.startAt - a.startAt || b.id.localeCompare(a.id));
    for (const row of completed.slice(RETAINED_RESOURCE_LIMIT)) {
      delete state.wallet.resources[row.id];
      state.wallet.resourceHistoryCompacted = true;
    }
  }
  history(state, { limit = 50, resourceCursor = null, fundingCursor = null } = {}) {
    const asOf = this.account.now(), m = this.metrics(state, asOf);
    const leases = Object.entries(state.leases ?? {}).filter(([, lease]) => lease.billing?.kind === 'prepaid');
    const toResource = (row, lease = null) => {
      const size = machineSize(row.size), live = lease ? unitsBetween(lease, lease.meteredUntil, asOf) : 0;
      return { id: row.id, containerId: row.containerId, name: lease?.name ?? row.name,
        lifecycle: lease?.lifecycle ?? row.lifecycle, size: row.size, startAt: row.startAt, endAt: row.endAt,
        runtimeMs: row.runtimeMs + live / size.computeUnits, computeUnitHours: (row.unitMs + live) / 3600000,
        usedCents: (row.unitMs + live) / UNIT_MS_PER_CENT,
        reservedCents: lease ? unitsBetween(lease, asOf, Infinity) / UNIT_MS_PER_CENT : 0,
        hourlyCents: size.computeUnits * USAGE_PRICING.centsPerComputeUnitHour,
        active: Boolean(lease && lease.endAt > asOf) };
    };
    const activeResources = leases.map(([containerId, lease]) => toResource(state.wallet?.resources?.[lease.resourceHistoryId]
      ?? { id: `untracked:${containerId}:${lease.startAt}`, containerId, name: lease.name ?? null,
        lifecycle: lease.lifecycle ?? 'ad_hoc', size: lease.size, startAt: lease.meteredUntil, endAt: null, runtimeMs: 0, unitMs: 0 }, lease));
    const completed = Object.values(state.wallet?.resources ?? {}).filter(row => row.endAt !== null)
      .sort((a, b) => b.startAt - a.startAt || b.id.localeCompare(a.id));
    const fundings = Object.values(state.wallet?.fundings ?? {}).sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
      .map(row => ({ id: row.id, createdAt: row.createdAt, amountCents: row.amountCents,
        revokedCents: row.disputed ? row.amountCents : row.refundedCents,
        reason: row.disputed ? 'dispute' : row.refundedCents ? 'refund' : null }));
    const page = (rows, cursor) => {
      const start = cursor === null ? 0 : rows.findIndex(row => row.id === cursor) + 1;
      if (cursor !== null && start === 0) throw new Error('invalid_history_cursor');
      const values = rows.slice(start, start + limit);
      return { values, next: start + limit < rows.length ? values.at(-1).id : null };
    };
    const resources = page(completed, resourceCursor), fundingPage = page(fundings, fundingCursor);
    const usedCents = ((state.wallet?.usedUnitMs ?? 0) + m.live) / UNIT_MS_PER_CENT;
    const attributedUnitMs = Object.values(state.wallet?.resources ?? {}).reduce((sum, row) => sum + row.unitMs, 0);
    const unattributedUsedCents = Math.max(0, (state.wallet?.usedUnitMs ?? 0) - attributedUnitMs) / UNIT_MS_PER_CENT;
    return { asOf, balance: this.status(state, asOf), totals: {
      fundedCents: fundings.reduce((sum, row) => sum + row.amountCents, 0),
      revokedCents: fundings.reduce((sum, row) => sum + row.revokedCents, 0), usedCents, unattributedUsedCents },
      currentHourlyCents: activeResources.filter(row => row.active).reduce((sum, row) => sum + row.hourlyCents, 0),
      activeResources, resources: resources.values.map(row => toResource(row)), fundings: fundingPage.values,
      nextResourceCursor: resources.next, nextFundingCursor: fundingPage.next,
      historyTruncated: Boolean(state.wallet?.resourceHistoryCompacted || unattributedUsedCents > 0), retainedResourceLimit: RETAINED_RESOURCE_LIMIT };
  }
  applyFunding(state, funding) {
    if (!funding || !/^(?:pi|cs)_[A-Za-z0-9_]+$/.test(funding.id) || funding.kind !== 'topup'
      || !Number.isSafeInteger(funding.amountCents) || funding.amountCents < 500 || funding.amountCents > 100000
      || !Number.isSafeInteger(funding.refundedCents) || funding.refundedCents < 0 || funding.refundedCents > funding.amountCents
      || typeof funding.disputed !== 'boolean' || !Number.isSafeInteger(funding.createdAt) || funding.createdAt <= 0) throw new Error('invalid_payment');
    const wallet = this.ensure(state, funding.customerId), previous = wallet.fundings[funding.id];
    if (previous && (previous.amountCents !== funding.amountCents || previous.customerId !== funding.customerId || previous.createdAt !== funding.createdAt)) throw new Error('payment_conflict');
    // Older success webhooks cannot restore money already refunded or disputed.
    wallet.fundings[funding.id] = { ...funding, refundedCents: Math.max(previous?.refundedCents ?? 0, funding.refundedCents), disputed: Boolean(previous?.disputed || funding.disputed) };
    return this.metrics(state).remaining < 0;
  }
  productionUnits(state) {
    return Object.values(state.production ?? {}).reduce((sum, desired) => sum + machineSize(desired.selection.size).computeUnits, 0);
  }
  productionFunding(state, now = this.account.now()) {
    const m = this.metrics(state, now);
    const productionReserved = prepaidLeases(state).filter(lease => lease.lifecycle === 'production')
      .reduce((sum, lease) => sum + unitsBetween(lease, now, Infinity), 0);
    return Math.max(0, m.remaining + productionReserved);
  }
  canLaunchProduction(state, size) {
    const units = this.productionUnits(state) + size.computeUnits;
    const needed = units * MINIMUM_PRODUCTION_RUNTIME_MS;
    const m = this.metrics(state);
    const adHocReserved = prepaidLeases(state).filter(lease => lease.lifecycle !== 'production')
      .reduce((sum, lease) => sum + unitsBetween(lease, this.account.now(), Infinity), 0);
    return !state.wallet?.fundingRevoked && this.productionFunding(state) >= needed
      && (state.spendLimitCents ?? 500) * UNIT_MS_PER_CENT - m.monthly - adHocReserved >= needed;
  }
  status(state, now = this.account.now()) {
    const m = this.metrics(state, now), settings = state.wallet?.autoRecharge ?? { enabled: false, amountCents: 500, monthlyLimitCents: 500, status: 'disabled' };
    const units = this.productionUnits(state);
    return { balanceCents: Math.floor(m.balance / UNIT_MS_PER_CENT), availableBalanceCents: Math.floor(Math.max(0, m.remaining) / UNIT_MS_PER_CENT),
      reservedBalanceCents: Math.ceil(m.reserved / UNIT_MS_PER_CENT), currency: 'usd', spendLimitCents: state.spendLimitCents ?? 500,
      monthlyUsageCents: Math.ceil(m.monthly / UNIT_MS_PER_CENT), productionHourlyCents: units * USAGE_PRICING.centsPerComputeUnitHour,
      fundedRuntimeMs: units ? Math.floor(this.productionFunding(state, now) / units) : null,
      minimumProductionRuntimeMs: MINIMUM_PRODUCTION_RUNTIME_MS,
      autoRecharge: { ...settings, spentCents: state.wallet?.rechargeSpending?.[m.month] ?? 0 } };
  }
  settings(state, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || (input.spendLimitCents === undefined && input.autoRecharge === undefined)) throw new Error('invalid_request');
    const wallet = this.ensure(state, input.customerId ?? state.wallet?.customerId);
    if (input.spendLimitCents !== undefined) {
      if (!validSpendLimit(input.spendLimitCents)) throw new Error('invalid_spend_limit');
      const m = this.metrics(state);
      if (input.spendLimitCents * UNIT_MS_PER_CENT < m.monthly + m.monthReserved) throw new Error('spend_limit_below_committed_usage');
      for (const lease of prepaidLeases(state)) {
        for (let at = Math.max(this.account.now(), lease.meteredUntil); at < lease.endAt;) {
          const period = utcPeriod(at), month = new Date(at).toISOString().slice(0, 7);
          const committed = (wallet.monthlyUnitMs[month] ?? 0) + prepaidLeases(state).reduce((sum, other) => sum + unitsBetween(other, period.periodStart, period.periodEnd), 0);
          if (committed > input.spendLimitCents * UNIT_MS_PER_CENT) throw new Error('spend_limit_below_committed_usage');
          at = period.periodEnd;
        }
      }
    }
    if (input.autoRecharge !== undefined) {
      const value = input.autoRecharge;
      if (!value || typeof value.enabled !== 'boolean' || !validSpendLimit(value.amountCents)
        || !validSpendLimit(value.monthlyLimitCents) || value.amountCents > value.monthlyLimitCents) throw new Error('invalid_auto_recharge');
      wallet.autoRecharge = { ...value, status: value.enabled ? 'ready' : 'disabled', ...(value.enabled ? { authorizedAt: this.account.now() } : {}) };
    }
    if (input.spendLimitCents !== undefined) state.spendLimitCents = input.spendLimitCents;
  }
  async maybeRecharge(state, requestedProductionUnits = 0) {
    const wallet = state.wallet, settings = wallet?.autoRecharge;
    if (!wallet || wallet.fundingRevoked || !this.recharge || (!settings.enabled && !wallet.pendingRecharge)) return;
    const m = this.metrics(state), units = this.productionUnits(state) + requestedProductionUnits;
    if (!wallet.pendingRecharge) {
      if (settings.status === 'monthly_limit_reached' && (wallet.rechargeSpending[m.month] ?? 0) + settings.amountCents <= settings.monthlyLimitCents) settings.status = 'ready';
      if (settings.status !== 'ready' && settings.status !== 'succeeded') return;
      if (units ? this.productionFunding(state) >= units * MINIMUM_PRODUCTION_RUNTIME_MS : m.remaining >= 500 * UNIT_MS_PER_CENT) return;
      // The cap is separate from the wallet: don't charge when compute is capped.
      if (m.monthly + m.monthReserved >= (state.spendLimitCents ?? 500) * UNIT_MS_PER_CENT) return;
      if ((wallet.rechargeSpending[m.month] ?? 0) + settings.amountCents > settings.monthlyLimitCents) { settings.status = 'monthly_limit_reached'; return; }
      wallet.pendingRecharge = { identifier: `mainbrella-recharge-${crypto.randomUUID()}`, userId: state.userId, customerId: wallet.customerId,
        amountCents: settings.amountCents, createdAt: this.account.now(), month: m.month };
    }
    const pending = wallet.pendingRecharge;
    if (pending.retryAt > this.account.now()) return;
    // Persist the exact charge before touching Stripe. Unknown outcomes retain
    // this identity across evictions and cannot consume a second authorization.
    pending.retryAt = this.account.now() + 60000;
    await this.account.ctx.storage.put('containerAccount', state);
    try {
      const result = await this.recharge(pending);
      if (result.paymentIntentId) pending.paymentIntentId = result.paymentIntentId;
      settings.status = result.status;
      if (result.status === 'succeeded') {
        if (!result.funding || result.funding.amountCents !== pending.amountCents || result.funding.customerId !== pending.customerId) throw new Error('invalid_payment');
        if (this.applyFunding(state, result.funding)) wallet.fundingRevoked = true;
        wallet.rechargeSpending[pending.month] = (wallet.rechargeSpending[pending.month] ?? 0) + pending.amountCents;
        delete wallet.pendingRecharge;
      } else if (result.status === 'failed' || result.status !== 'processing' && !result.paymentIntentId) delete wallet.pendingRecharge;
    } catch { settings.status = 'reconciliation_required'; }
    await this.account.ctx.storage.put('containerAccount', state);
  }
}
