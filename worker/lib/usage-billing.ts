import { stripeRequest, subscriptionPlan, type BillingEnv, type StripeSubscription } from './stripe';
export interface UsageInvoice {
  identifier: string; invoiceId: string; customerId: string; subscriptionId: string;
  amountCents: number; totalCents: number; periodStart: number; periodEnd: number; createdAt: number;
}
interface StripeInvoice { id: string; customer: string; status: string; created: number;
  parent?: { subscription_details?: { subscription?: string } }; subscription?: string;
  metadata?: Record<string, string>; }
interface InvoiceItem { id: string; amount: number; invoice: string; customer: string; metadata?: Record<string, string> }
export const usageBillingConfigured = (env: BillingEnv): boolean => Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_USAGE_BASE_PRICE_ID);

export async function invoiceResourceUsage(env: BillingEnv, entry: UsageInvoice): Promise<string> {
  if (!usageBillingConfigured(env) || !Number.isSafeInteger(entry.amountCents) || entry.amountCents <= 0) throw new Error('billing_unavailable');
  // Invoice-item metadata is durable, unlike Stripe's time-limited HTTP keys.
  // Recover an accepted write even if its response or the local receipt was lost.
  const params = new URLSearchParams({ customer: entry.customerId, limit: '100' });
  while (true) {
    const page = await stripeRequest<{ data: InvoiceItem[]; has_more: boolean }>(env, `/invoiceitems?${params}`);
    const matches = page.data.filter(item => item.metadata?.mainbrella_ledger_id === entry.identifier);
    if (matches.length > 1) throw new Error('billing_reconciliation_required');
    if (matches[0]) {
      const item = matches[0];
      if (item.amount !== entry.amountCents || item.customer !== entry.customerId || item.invoice !== entry.invoiceId) throw new Error('billing_reconciliation_required');
      return item.id;
    }
    if (!page.has_more || !page.data.length) break;
    params.set('starting_after', page.data[page.data.length - 1].id);
  }
  if (Date.now() - entry.createdAt >= 23 * 3600000) throw new Error('billing_reconciliation_required');
  const invoice = await stripeRequest<StripeInvoice>(env, `/invoices/${encodeURIComponent(entry.invoiceId)}`);
  if (invoice.customer !== entry.customerId || invoice.status !== 'draft') throw new Error('billing_reconciliation_required');
  const item = await stripeRequest<InvoiceItem>(env, '/invoiceitems', new URLSearchParams({
    customer: entry.customerId, subscription: entry.subscriptionId, invoice: entry.invoiceId,
    amount: String(entry.amountCents), currency: 'usd', discountable: 'false',
    description: `Resource usage: $${(entry.totalCents / 100).toFixed(2)} less $5 included usage`,
    'period[start]': String(Math.floor(entry.periodStart / 1000)), 'period[end]': String(Math.floor(entry.periodEnd / 1000)),
    'metadata[mainbrella_ledger_id]': entry.identifier,
  }), entry.identifier);
  return item.id;
}

export async function invoiceAccountUsage(env: BillingEnv, userId: string, customerId: string, invoiceId: string): Promise<void> {
  const invoice = await stripeRequest<StripeInvoice>(env, `/invoices/${encodeURIComponent(invoiceId)}`);
  const subscriptionId = invoice.parent?.subscription_details?.subscription ?? invoice.subscription ?? invoice.metadata?.mainbrella_subscription_id;
  if (invoice.customer !== customerId || !subscriptionId) return;
  const subscription = await stripeRequest<StripeSubscription>(env, `/subscriptions/${encodeURIComponent(subscriptionId)}`);
  if (subscription.customer !== customerId || subscriptionPlan(subscription, env) !== 'usage') return;
  if (!env.CONTAINER_ACCOUNT) throw new Error('billing_unavailable');
  const account = env.CONTAINER_ACCOUNT.get(env.CONTAINER_ACCOUNT.idFromName(`account:${userId}`));
  const response = await account.fetch(new Request('https://internal/billing/invoice', { method: 'POST',
    headers: { 'x-mainbrella-user': userId }, body: JSON.stringify({ invoiceId, customerId, subscriptionId, cutoff: invoice.created * 1000, final: subscription.status === 'canceled',
      ...(subscription.status === 'canceled' ? { entitlement: { active: false, plan: null, validUntil: null, checkedAt: Date.now() } } : {}) }) }));
  if (!response.ok) throw new Error('billing_unavailable');
}

// Base fees are paid in advance. Cancellation has no next renewal invoice, so
// collect final overage on a subscription-linked invoice without another base fee.
export async function invoiceCanceledUsage(env: BillingEnv, userId: string, customerId: string, subscriptionId: string): Promise<void> {
  const subscription = await stripeRequest<StripeSubscription>(env, `/subscriptions/${encodeURIComponent(subscriptionId)}`);
  if (subscription.customer !== customerId || subscription.status !== 'canceled' || subscriptionPlan(subscription, env) !== 'usage') return;
  const params = new URLSearchParams({ customer: customerId, limit: '100' });
  let finalInvoice: StripeInvoice | undefined;
  while (true) {
    const page = await stripeRequest<{ data: StripeInvoice[]; has_more: boolean }>(env, `/invoices?${params}`);
    finalInvoice = page.data.find(invoice => invoice.metadata?.mainbrella_final_usage === 'true'
      && invoice.metadata.mainbrella_subscription_id === subscriptionId);
    if (finalInvoice || !page.has_more || !page.data.length) break;
    params.set('starting_after', page.data[page.data.length - 1].id);
  }
  if (finalInvoice && finalInvoice.status !== 'draft') return;
  const fields = new URLSearchParams({ customer: customerId, subscription: subscriptionId,
    auto_advance: 'false', collection_method: 'charge_automatically', pending_invoice_items_behavior: 'exclude',
    'metadata[mainbrella_subscription_id]': subscriptionId, 'metadata[mainbrella_final_usage]': 'true' });
  const paymentMethod = typeof subscription.default_payment_method === 'string'
    ? subscription.default_payment_method : subscription.default_payment_method?.id;
  if (paymentMethod) fields.set('default_payment_method', paymentMethod);
  const invoice = finalInvoice ?? await stripeRequest<StripeInvoice>(env, '/invoices', fields, `mainbrella-final-usage-${subscriptionId}`);
  await invoiceAccountUsage(env, userId, customerId, invoice.id);
  await stripeRequest(env, `/invoices/${encodeURIComponent(invoice.id)}`, new URLSearchParams({ auto_advance: 'true' }));
}
