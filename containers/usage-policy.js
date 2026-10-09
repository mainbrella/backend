// Compute is measured as allocated size × elapsed time, including provisioning
// and idle time. Reservations protect the spending cap; they are never invoiced.
export const USAGE_PRICING = Object.freeze({
  minimumCents: 500, centsPerComputeUnitHour: 2,
  defaultSpendLimitCents: 500, maxSpendLimitCents: 100000,
});
export const validSpendLimit = value => Number.isSafeInteger(value)
  && value >= USAGE_PRICING.minimumCents && value <= USAGE_PRICING.maxSpendLimitCents;
export const validBillingPeriod = value => Boolean(value && /^cus_[A-Za-z0-9]+$/.test(value.customerId)
  && /^sub_[A-Za-z0-9]+$/.test(value.subscriptionId)
  && Number.isSafeInteger(value.periodStart) && Number.isSafeInteger(value.periodEnd)
  && value.periodStart > 0 && value.periodEnd > value.periodStart);
export const billingPeriodKey = period => `${period.subscriptionId}:${period.periodStart}`;
