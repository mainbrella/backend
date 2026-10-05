import { activeTrial, type Trial } from './trial-coupons';
import { billingSubscription, PLAN_PRICES, stripeRequest, subscriptionPlan, type BillingEnv, type Plan, type StripeSubscription } from "./stripe";

export interface Entitlement { plan: Plan | null; active: boolean; validUntil: number | null; checkedAt?: number }
export interface BillingRecord { stripe_customer_id: string; checkout_session_id: string | null }
export interface BillingState { record: BillingRecord | null; subscription: StripeSubscription | null; entitlement: Entitlement; trial?: Trial | null }
const unpaid = (): Entitlement => ({ plan: null, active: false, validUntil: null });

interface InvoiceLine {
  id: string; amount: number; quantity?: number; period: { start: number; end: number };
  price?: { id: string };
  pricing?: { price_details?: { price: string } };
  parent?: { subscription_item_details?: { subscription?: string; subscription_item?: string } };
}
interface Invoice { id: string; status: string; amount_paid: number; paid_out_of_band?: boolean; lines: { data: InvoiceLine[]; has_more?: boolean } }

interface Charge { id: string; paid: boolean; captured?: boolean; status: string; amount: number; amount_refunded: number; refunded: boolean; disputed: boolean }
interface InvoicePayment { id: string; invoice: string; status: string; amount_paid: number; payment: { type: string; payment_intent?: string; charge?: string } }

async function actualStripePayment(env: BillingEnv, invoice: Invoice): Promise<boolean> {
  const params = new URLSearchParams({ invoice: invoice.id, status: "paid", limit: "100" });
  let paid = 0;
  while (true) {
    const page = await stripeRequest<{ data: InvoicePayment[]; has_more: boolean }>(env, `/invoice_payments?${params}`);
    for (const payment of page.data) {
      if (payment.invoice !== invoice.id || payment.status !== "paid" || !Number.isSafeInteger(payment.amount_paid) || payment.amount_paid <= 0) continue;
      let charge: Charge | null = null;
      if (payment.payment.type === "payment_intent" && payment.payment.payment_intent) {
        const intent = await stripeRequest<{ id: string; status: string; amount_received: number; latest_charge: Charge | null }>(env,
          `/payment_intents/${encodeURIComponent(payment.payment.payment_intent)}?expand[]=latest_charge`);
        if (intent.id !== payment.payment.payment_intent || intent.status !== "succeeded"
          || !Number.isSafeInteger(intent.amount_received) || intent.amount_received < payment.amount_paid) continue;
        charge = intent.latest_charge;
      } else if (payment.payment.type === "charge" && payment.payment.charge) {
        charge = await stripeRequest<Charge>(env, `/charges/${encodeURIComponent(payment.payment.charge)}`);
        if (charge.id !== payment.payment.charge || charge.captured !== true) continue;
      }
      if (charge?.paid === true && charge.status === "succeeded" && Number.isSafeInteger(charge.amount) && charge.amount >= payment.amount_paid
        && charge.amount_refunded === 0 && charge.refunded === false && charge.disputed === false) paid += payment.amount_paid;
      if (paid >= invoice.amount_paid) return true;
    }
    if (!page.has_more || !page.data.length) return false;
    params.set("starting_after", page.data[page.data.length - 1].id);
  }
}

async function paidThrough(env: BillingEnv, subscription: StripeSubscription, plan: Plan, now: number): Promise<number | null> {
  const params = new URLSearchParams({ subscription: subscription.id, status: "paid", limit: "100" });
  while (true) {
    const page = await stripeRequest<{ data: Invoice[]; has_more: boolean }>(env, `/invoices?${params}`);
    for (const invoice of page.data) {
      if (invoice.status !== "paid" || !(invoice.amount_paid > 0) || invoice.paid_out_of_band) continue;
      const lines = [...invoice.lines.data];
      let hasMore = invoice.lines.has_more;
      while (hasMore && lines.length) {
        const lineParams = new URLSearchParams({ limit: "100", starting_after: lines[lines.length - 1].id });
        const more = await stripeRequest<{ data: InvoiceLine[]; has_more: boolean }>(env, `/invoices/${encodeURIComponent(invoice.id)}/lines?${lineParams}`);
        lines.push(...more.data);
        hasMore = more.has_more && more.data.length > 0;
      }
      const proof = lines.find((line) => {
        const details = line.parent?.subscription_item_details;
        return (line.pricing?.price_details?.price ?? line.price?.id) === PLAN_PRICES[plan]
          && line.amount > 0 && line.quantity === 1
          && details?.subscription === subscription.id
          && line.period.start <= now && line.period.end > now;
      });
      if (proof && await actualStripePayment(env, invoice)) return proof.period.end;
    }
    if (!page.has_more || !page.data.length) return null;
    params.set("starting_after", page.data[page.data.length - 1].id);
  }
}

export async function subscriptionEntitlement(env: BillingEnv, subscription: StripeSubscription | null): Promise<Entitlement> {
  const plan = subscriptionPlan(subscription);
  const now = Date.now() / 1000;
  const periodEnd = subscription?.items.data[0]?.current_period_end;
  if (!plan || !subscription || subscription.status !== "active" || subscription.pause_collection
    || !Number.isFinite(periodEnd) || periodEnd! <= now) return unpaid();
  const proofEnd = await paidThrough(env, subscription, plan, now);
  if (!proofEnd) return unpaid();
  const validUntil = Math.min(periodEnd!, proofEnd, subscription.cancel_at ?? Infinity) * 1000;
  return validUntil > Date.now() ? { plan, active: true, validUntil } : unpaid();
}

export async function syncSubscriptionRecord(env: BillingEnv, userId: string, subscription: StripeSubscription | null): Promise<void> {
  const plan = subscriptionPlan(subscription);
  await env.DB.prepare(`UPDATE pro_billing SET plan = ?, stripe_subscription_id = ?,
    subscription_status = ?, cancel_at_period_end = ?, current_period_end = ?,
    synced_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE user_id = ?`)
    .bind(plan, subscription?.id || null, subscription?.status || null,
      subscription?.cancel_at_period_end ? 1 : 0, subscription?.items.data[0]?.current_period_end ?? null, userId).run();
}

export async function resolveBillingState(env: BillingEnv, userId: string): Promise<BillingState> {
  const checkedAt = Date.now();
  const record = await env.DB.prepare("SELECT stripe_customer_id, checkout_session_id FROM pro_billing WHERE user_id = ?")
    .bind(userId).first<BillingRecord>();
  const subscription = record ? await billingSubscription(env, record.stripe_customer_id) : null;
  const entitlement = await subscriptionEntitlement(env, subscription);
  const trial = !subscription ? await activeTrial(env, userId) : null;
  if (trial) Object.assign(entitlement, { plan: trial.plan, active: true, validUntil: trial.expires_at });
  entitlement.checkedAt = checkedAt;
  if (record) await syncSubscriptionRecord(env, userId, subscription);
  return { record, subscription, entitlement, trial };
}

// Stripe outages deliberately throw: callers must fail closed, never trust stale D1 status.
export async function resolveEntitlement(env: BillingEnv, userId: string): Promise<Entitlement> {
  return (await resolveBillingState(env, userId)).entitlement;
}
