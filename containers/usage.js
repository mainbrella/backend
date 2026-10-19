import { UNIT_MS_PER_CENT } from './wallet-policy.js';

const token = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const name = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value !== null && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);

export function usageReceiptKey(input) {
  if (!input || !name(input.product) || !name(input.meter) || !token(input.id)) throw new Error('invalid_request');
  return `walletUsage:${input.product}:${input.id}`;
}

// A receipt is stored separately from the account snapshot. Email volume must
// not grow the wallet's single KV value; only aggregate counters live there.
// The host atomically persists the returned receipt with the updated account.
export function applyUsage(wallet, state, input, previous) {
  usageReceiptKey(input);
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 16384) throw new Error('invalid_request');
  if (!state.wallet) throw new Error('insufficient_balance');
  if (previous && previous.meter !== input.meter) throw new Error('usage_receipt_conflict');
  const funds = state.wallet, now = wallet.account.now();
  if (input.action === 'reserve') {
    if (!integer(input.reservedMicroUsd) || input.reservedMicroUsd > 100000000 || !integer(input.createdAt)
      || input.resourceId !== undefined && !token(input.resourceId)) throw new Error('invalid_request');
    if (previous) {
      if (previous.reservedMicroUsd !== input.reservedMicroUsd || previous.createdAt !== input.createdAt
        || previous.resourceId !== input.resourceId) throw new Error('usage_receipt_conflict');
      return previous;
    }
    if (input.createdAt > now || now - input.createdAt > 23 * 3600000) throw new Error('usage_reconciliation_required');
    const metrics = wallet.metrics(state), required = input.reservedMicroUsd * UNIT_MS_PER_CENT / 10000;
    if ((state.spendLimitCents ?? 500) * UNIT_MS_PER_CENT - metrics.monthly - metrics.monthReserved < required) throw new Error('spend_limit_exceeded');
    if (funds.fundingRevoked || metrics.remaining < required) throw new Error('insufficient_balance');
    funds.usageReservedMicroUsd = (funds.usageReservedMicroUsd ?? 0) + input.reservedMicroUsd;
    return { product: input.product, id: input.id, meter: input.meter, resourceId: input.resourceId,
      reservedMicroUsd: input.reservedMicroUsd, createdAt: input.createdAt, status: 'reserved' };
  }
  if (!previous || !['settle', 'release'].includes(input.action) || !integer(input.occurredAt)
    || input.occurredAt < previous.createdAt || input.occurredAt > now) throw new Error('invalid_request');
  const release = input.action === 'release';
  if (release ? !['canceled_before_dispatch', 'provider_rejected'].includes(input.reason)
    : !integer(input.costMicroUsd) || input.costMicroUsd > 100000000 || !input.evidence || typeof input.evidence !== 'object' || Array.isArray(input.evidence)) throw new Error('invalid_request');
  const costMicroUsd = release ? 0 : input.costMicroUsd;
  const evidence = release ? { reason: input.reason } : input.evidence;
  const status = release ? 'released' : 'settled';
  if (previous.status !== 'reserved') {
    if (previous.status !== status || previous.costMicroUsd !== costMicroUsd || previous.occurredAt !== input.occurredAt
      || canonical(previous.evidence) !== canonical(evidence)) throw new Error('usage_receipt_conflict');
    return previous;
  }
  funds.usageReservedMicroUsd -= previous.reservedMicroUsd;
  funds.usedUsageMicroUsd = (funds.usedUsageMicroUsd ?? 0) + costMicroUsd;
  const month = new Date(input.occurredAt).toISOString().slice(0, 7);
  funds.monthlyUsageMicroUsd ??= {};
  funds.monthlyUsageMicroUsd[month] = (funds.monthlyUsageMicroUsd[month] ?? 0) + costMicroUsd;
  funds.productUsageMicroUsd ??= {};
  const productUsed = Object.hasOwn(funds.productUsageMicroUsd, input.product) ? funds.productUsageMicroUsd[input.product] : 0;
  funds.productUsageMicroUsd[input.product] = productUsed + costMicroUsd;
  if (!release) wallet.queue(state, { key: `usage:${input.product}:${input.id}`, type: 'usage', occurredAt: input.occurredAt,
    data: { product: input.product, meter: previous.meter, id: input.id, resourceId: previous.resourceId ?? null, costMicroUsd, evidence } });
  return { ...previous, status, costMicroUsd, occurredAt: input.occurredAt, evidence };
}
