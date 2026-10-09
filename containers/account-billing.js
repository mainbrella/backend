import { USAGE_PRICING, billingPeriodKey, validBillingPeriod } from './usage-policy.js';
import { machineSize } from './plan-policy.js';

// Future storage, IP and email services add ledger charges in integer cents,
// with their own deduplication keys. Apply the included credit once to the sum.
export const resourceUsageCents = period => Math.round(Math.max(0, period.unitMs) / 3600000 * USAGE_PRICING.centsPerComputeUnitHour)
  + Object.values(period.resourceCharges ?? {}).reduce((sum, cents) => sum + cents, 0);
export class AccountBilling {
  constructor(account, invoiceUsage) { this.account = account; this.invoiceUsage = invoiceUsage; }
  period(state, billing = state.entitlement?.billing) {
    if (!validBillingPeriod(billing)) return null;
    state.billingPeriods ??= {};
    return state.billingPeriods[billingPeriodKey(billing)] ??= { ...billing, unitMs: 0, resourceCharges: {} };
  }
  attach(state, lease) {
    if (state.entitlement.plan !== 'usage') return;
    const period = this.period(state);
    if (!period || !this.invoiceUsage) throw new Error('billing_unavailable');
    lease.billing = { customerId: period.customerId, subscriptionId: period.subscriptionId,
      periodStart: period.periodStart, periodEnd: period.periodEnd };
    lease.meteredUntil = lease.startAt;
  }
  record(state, lease, stoppedAt) {
    if (!lease?.billing) return;
    const end = Math.max(lease.meteredUntil, Math.min(stoppedAt, lease.endAt, lease.billing.periodEnd));
    const period = this.period(state, lease.billing);
    period.unitMs += (end - lease.meteredUntil) * machineSize(lease.size).computeUnits;
    lease.meteredUntil = end;
  }
  committedUnitMs(state) {
    const period = this.period(state);
    if (!period) return 0;
    return period.unitMs + Object.values(state.leases).filter(lease => lease.billing
      && billingPeriodKey(lease.billing) === billingPeriodKey(period))
      .reduce((sum, lease) => sum + Math.max(0, lease.endAt - lease.meteredUntil) * machineSize(lease.size).computeUnits, 0);
  }
  remainingUnitMs(state) {
    const cap = state.spendLimitCents ?? USAGE_PRICING.defaultSpendLimitCents;
    return Math.max(0, (cap - Object.values(this.period(state)?.resourceCharges ?? {}).reduce((sum, cents) => sum + cents, 0)) / USAGE_PRICING.centsPerComputeUnitHour * 3600000 - this.committedUnitMs(state));
  }
  status(state) {
    if (state.entitlement.plan !== 'usage') return null;
    const period = this.period(state);
    if (!period) return null;
    const incurred = period.unitMs + Object.values(state.leases).filter(lease => lease.billing
      && billingPeriodKey(lease.billing) === billingPeriodKey(period))
      .reduce((sum, lease) => sum + Math.max(0, Math.min(this.account.now(), lease.endAt) - lease.meteredUntil) * machineSize(lease.size).computeUnits, 0);
    const estimatedCents = Math.max(USAGE_PRICING.minimumCents, resourceUsageCents({ ...period, unitMs: incurred }));
    const spendLimitCents = state.spendLimitCents ?? USAGE_PRICING.defaultSpendLimitCents;
    const percent = resourceUsageCents({ ...period, unitMs: incurred }) / spendLimitCents * 100;
    return { periodStart: period.periodStart, periodEnd: period.periodEnd, computeUnitHours: incurred / 3600000,
      estimatedCents, minimumCents: USAGE_PRICING.minimumCents, spendLimitCents,
      committedCents: Math.max(USAGE_PRICING.minimumCents, resourceUsageCents({ ...period, unitMs: this.committedUnitMs(state) })),
      alert: percent >= 100 ? 100 : percent >= 80 ? 80 : percent >= 50 ? 50 : null,
      overagesEnabled: Boolean(state.overageConsent),
      invoicingPending: Object.values(state.billingPeriods).some(entry => entry.pending) };
  }
  checkPending(state) {
    if (Object.values(state.billingPeriods ?? {}).some(period => period.pending
      && this.account.now() - period.pending.createdAt >= 23 * 3600000)) throw new Error('billing_reconciliation_required');
  }
  async invoice(state, context) {
    if (!/^in_[A-Za-z0-9_]+$/.test(context.invoiceId) || !Number.isSafeInteger(context.cutoff)) throw new Error('invalid_invoice');
    for (const period of Object.values(state.billingPeriods ?? {})) {
      if (period.customerId !== context.customerId || period.subscriptionId !== context.subscriptionId
        || (period.periodEnd > context.cutoff && !(context.final && period.periodStart < context.cutoff)) || period.invoiced) continue;
      // A pending boot can briefly outlive the paid deadline in account state.
      // Wait for a confirmed stop so its final elapsed usage is included.
      if (Object.values(state.leases ?? {}).some(lease => lease.billing
        && billingPeriodKey(lease.billing) === billingPeriodKey(period))) throw new Error('billing_reconciliation_required');
      const totalCents = resourceUsageCents(period);
      const amountCents = Math.max(0, totalCents - USAGE_PRICING.minimumCents);
      if (!amountCents) { period.invoiced = true; continue; }
      period.pending ??= { identifier: `mainbrella-usage-${period.subscriptionId}-${period.periodStart}`,
        invoiceId: context.invoiceId, customerId: period.customerId, subscriptionId: period.subscriptionId,
        amountCents, totalCents, periodStart: period.periodStart, periodEnd: period.periodEnd, createdAt: this.account.now() };
      // Freeze the amount and destination before the external write. A lost
      // response or worker eviction retries the identical durable invoice item.
      await this.account.ctx.storage.put('containerAccount', state);
      if (!this.invoiceUsage) throw new Error('billing_unavailable');
      period.invoiceItemId = await this.invoiceUsage(period.pending);
      period.invoiced = true;
      delete period.pending;
      await this.account.ctx.storage.put('containerAccount', state);
    }
  }
}
