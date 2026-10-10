import { stripeRequest, type BillingEnv } from './stripe';
import { appendAccountingEvent, type TaxLocation } from './accounting-ledger';

export interface BalanceTransaction { id: string; amount: number; fee: number; net: number; currency: string; created: number; available_on: number; source: string | { id: string } | null; type: string }
export interface AccountingCharge {
  id: string; created?: number; amount_refunded: number; disputed: boolean;
  balance_transaction?: string | BalanceTransaction | null;
  billing_details?: { address?: Address | null };
}
interface Address { country?: string | null; state?: string | null; postal_code?: string | null; city?: string | null }
interface Refund { id: string; charge: string; amount: number; currency: string; created: number; status: string; balance_transaction: string | BalanceTransaction | null }
interface Dispute { id: string; charge: string; currency: string; balance_transactions: BalanceTransaction[] }

function location(address: Address | null | undefined, source: TaxLocation['source']): TaxLocation {
  return { country: address?.country ?? null, state: address?.state ?? null, postalCode: address?.postal_code ?? null, city: address?.city ?? null, source: address ? source : 'unknown' };
}
export async function recordStripeBalance(env: BillingEnv, userId: string, fundingId: string, category: 'payment' | 'refund' | 'chargeback', sourceId: string, value: string | BalanceTransaction | null | undefined): Promise<void> {
  if (!value) return; // Missing fees remain explicitly unreconciled at close.
  const txn = typeof value === 'string' ? await stripeRequest<BalanceTransaction>(env, `/balance_transactions/${encodeURIComponent(value)}`) : value;
  const source = typeof txn.source === 'string' ? txn.source : txn.source?.id;
  if (!/^txn_[A-Za-z0-9_]+$/.test(txn.id) || txn.currency !== 'usd' || source !== sourceId
    || ![txn.amount, txn.fee, txn.net, txn.created, txn.available_on].every(Number.isSafeInteger)
    || txn.net !== txn.amount - txn.fee) throw new Error('invalid_accounting_balance_transaction');
  await appendAccountingEvent(env, { key: `stripe_balance:${txn.id}`, userId, type: 'stripe_balance', occurredAt: txn.created * 1000,
    data: { fundingId, sourceId, category, transactionId: txn.id, amountCents: txn.amount, processingFeeCents: txn.fee, netCents: txn.net,
      availableAt: txn.available_on * 1000, currency: 'usd', stripeType: txn.type } });
}

export async function recordFunding(env: BillingEnv, value: {
  userId: string; fundingId: string; customerId: string; creditCents: number; paidCents: number; taxCents: number;
  receiptAt: number; receiptDateSource: string; checkoutId?: string; charge?: AccountingCharge | null; checkoutAddress?: Address | null;
  reconcileDisputes?: boolean;
}): Promise<void> {
  const { userId, fundingId, charge } = value;
  const key = `funding:${fundingId}`;
  // A location/fee becoming available later must not rewrite receipt evidence.
  const existing = await env.DB.prepare('SELECT user_id,payload FROM accounting_ledger WHERE event_key = ?').bind(key).first<{ user_id: string; payload: string }>();
  const data = { fundingId, customerId: value.customerId, creditCents: value.creditCents,
    amountPaidCents: value.paidCents, considerationCents: value.paidCents - value.taxCents,
    promotionalCreditCents: value.creditCents - (value.paidCents - value.taxCents), taxCollectedCents: value.taxCents,
    currency: 'usd', chargeId: charge?.id ?? null, checkoutId: value.checkoutId ?? null,
    receiptDateSource: value.receiptDateSource, taxLocation: location(value.checkoutAddress ?? charge?.billing_details?.address, value.checkoutAddress ? 'checkout' : 'charge') };
  if (existing) {
    if (existing.user_id !== userId) throw new Error('accounting_event_conflict');
    const prior = JSON.parse(existing.payload);
    for (const field of ['fundingId', 'customerId', 'creditCents', 'amountPaidCents', 'taxCollectedCents', 'chargeId']) {
      if (prior[field] !== data[field as keyof typeof data]) throw new Error('accounting_event_conflict');
    }
  } else await appendAccountingEvent(env, { key, userId, type: 'funding', occurredAt: value.receiptAt, data });
  if (!charge) return;
  await recordStripeBalance(env, userId, fundingId, 'payment', charge.id, charge.balance_transaction);
  if (charge.amount_refunded > 0) {
    const query = new URLSearchParams({ charge: charge.id, limit: '100', 'expand[]': 'data.balance_transaction' });
    let refunded = 0;
    while (true) {
      const page = await stripeRequest<{ data: Refund[]; has_more: boolean }>(env, `/refunds?${query}`);
      for (const refund of page.data) {
        if (refund.status !== 'succeeded') continue;
        if (refund.charge !== charge.id || refund.currency !== 'usd' || !Number.isSafeInteger(refund.amount) || refund.amount <= 0) throw new Error('invalid_accounting_refund');
        refunded += refund.amount;
        // Stripe's plain Refund does not specify a partial sales-tax allocation.
        // Preserve that uncertainty instead of silently treating tax as revenue.
        const refundedTaxCents = value.taxCents === 0 ? 0 : refund.amount === value.paidCents ? value.taxCents : null;
        await appendAccountingEvent(env, { key: `refund:${refund.id}`, userId, type: 'refund', occurredAt: refund.created * 1000,
          data: { fundingId, refundId: refund.id, amountCents: refund.amount, taxRefundedCents: refundedTaxCents, currency: 'usd' } });
        await recordStripeBalance(env, userId, fundingId, 'refund', refund.id, refund.balance_transaction);
      }
      if (!page.has_more) break;
      if (!page.data.length) throw new Error('billing_reconciliation_required');
      query.set('starting_after', page.data.at(-1)!.id);
    }
    if (refunded !== charge.amount_refunded) throw new Error('billing_reconciliation_required');
  }
  // Read even won/closed disputes: money can be reinstated while wallet credit
  // remains revoked. Neither a charge.disputed flag nor face credit is cash.
  const hadDispute = await env.DB.prepare("SELECT sequence FROM accounting_ledger WHERE user_id = ? AND event_type = 'stripe_balance' AND json_extract(payload,'$.fundingId') = ? AND json_extract(payload,'$.category') = 'chargeback' LIMIT 1").bind(userId, fundingId).first();
  if (charge.disputed || hadDispute || value.reconcileDisputes) {
    const query = new URLSearchParams({ charge: charge.id, limit: '100' });
    while (true) {
      const page = await stripeRequest<{ data: Dispute[]; has_more: boolean }>(env, `/disputes?${query}`);
      for (const dispute of page.data) {
        if (dispute.charge !== charge.id || dispute.currency !== 'usd') throw new Error('invalid_accounting_dispute');
        for (const txn of dispute.balance_transactions) await recordStripeBalance(env, userId, fundingId, 'chargeback', dispute.id, txn);
      }
      if (!page.has_more) break;
      if (!page.data.length) throw new Error('billing_reconciliation_required');
      query.set('starting_after', page.data.at(-1)!.id);
    }
  }
}
