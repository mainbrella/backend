import { stripeRequest, type BillingEnv } from './stripe';

export const MIN_TOPUP_CENTS = 500;
export const MAX_TOPUP_CENTS = 100000;
export const prepaidBillingConfigured = (env: BillingEnv): boolean => Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_PREPAID_PRICE_ID);
export const validTopupAmount = (amount: unknown): amount is number => Number.isSafeInteger(amount) && Number(amount) >= MIN_TOPUP_CENTS && Number(amount) <= MAX_TOPUP_CENTS;
export const stripeID = (value: unknown, prefix: string): value is string => typeof value === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9_]+$`).test(value);
export interface PrepaidAccount { user_id: string; stripe_customer_id: string; payment_method_id: string | null; latest_payment_intent_id: string | null }
export interface Funding { id: string; customerId: string; amountCents: number; refundedCents: number; disputed: boolean; createdAt: number; kind: 'topup' }
export interface AutoRecharge { enabled: boolean; amountCents: number; monthlyLimitCents: number; spentCents: number; status: string }
export interface PrepaidBalance {
  balanceCents: number; availableBalanceCents: number; reservedBalanceCents: number; currency: 'usd';
  spendLimitCents: number; monthlyUsageCents: number; productionHourlyCents: number; fundedRuntimeMs: number | null;
  minimumProductionRuntimeMs: number; autoRecharge: AutoRecharge;
}
export interface PrepaidRechargeEntry { identifier: string; userId?: string; customerId: string; amountCents: number; paymentIntentId?: string; createdAt: number }
export interface RechargeResult { status: 'succeeded' | 'processing' | 'requires_action' | 'failed'; paymentIntentId?: string; funding?: Funding }
interface Charge {
  id: string; customer: string; payment_intent: string; paid: boolean; captured: boolean; status: string;
  amount: number; currency: string; amount_refunded: number; refunded: boolean; disputed: boolean;
  payment_method_details: { type: string };
}
interface PaymentIntent {
  id: string; customer: string; status: string; currency: string; amount: number; amount_received: number;
  created: number; payment_method: string | { id: string } | null; latest_charge: Charge | null;
  metadata: Record<string, string>;
}
export interface PrepaidCheckout {
  id: string; url: string | null; mode: string; status: string; payment_status: string; currency: string;
  amount_total: number; customer: string; client_reference_id: string; payment_intent: string | null;
  metadata: Record<string, string>;
}
interface Topup { request_id: string; user_id: string; stripe_customer_id: string; amount_cents: number; checkout_session_id: string | null; created_at: number }
interface ReferencePrice { id: string; active: boolean; type: string; currency: string; unit_amount: number; recurring: unknown; product: { id: string; active: boolean } }

async function prepaidReferencePrice(env: BillingEnv): Promise<ReferencePrice> {
  if (!stripeID(env.STRIPE_PREPAID_PRICE_ID, 'price')) throw new Error('billing_unavailable');
  const price = await stripeRequest<ReferencePrice>(env, `/prices/${encodeURIComponent(env.STRIPE_PREPAID_PRICE_ID)}?expand[]=product`);
  if (price.id !== env.STRIPE_PREPAID_PRICE_ID || price.active !== true || price.type !== 'one_time' || price.currency !== 'usd'
    || price.unit_amount !== MIN_TOPUP_CENTS || price.recurring != null || !stripeID(price.product?.id, 'prod') || price.product.active !== true) throw new Error('invalid_prepaid_price');
  return price;
}

export async function prepaidAccount(env: BillingEnv, userId: string): Promise<PrepaidAccount | null> {
  return env.DB.prepare('SELECT user_id, stripe_customer_id, payment_method_id, latest_payment_intent_id FROM prepaid_accounts WHERE user_id = ?').bind(userId).first<PrepaidAccount>();
}
export async function prepaidAccountByCustomer(env: BillingEnv, customerId: string): Promise<PrepaidAccount | null> {
  return env.DB.prepare('SELECT user_id, stripe_customer_id, payment_method_id, latest_payment_intent_id FROM prepaid_accounts WHERE stripe_customer_id = ?').bind(customerId).first<PrepaidAccount>();
}
export async function accountBillingRequest(env: BillingEnv, userId: string, path: string, body?: unknown): Promise<{ balance: PrepaidBalance }> {
  if (!env.CONTAINER_ACCOUNT) throw new Error('billing_unavailable');
  const account = env.CONTAINER_ACCOUNT.get(env.CONTAINER_ACCOUNT.idFromName(`account:${userId}`));
  const response = await account.fetch(new Request(`https://internal${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'x-mainbrella-user': userId, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const result = await response.json() as { balance: PrepaidBalance; error?: string };
  if (!response.ok) throw new Error(result.error ?? 'billing_unavailable');
  return result;
}

export async function ensurePrepaidAccount(env: BillingEnv, user: { id: string; email: string | null; name: string }): Promise<PrepaidAccount> {
  const existing = await prepaidAccount(env, user.id);
  if (existing) return existing;
  await env.DB.prepare('INSERT INTO prepaid_customer_requests (user_id,created_at) VALUES (?,?) ON CONFLICT(user_id) DO NOTHING').bind(user.id, Date.now()).run();
  const request = await env.DB.prepare('SELECT created_at FROM prepaid_customer_requests WHERE user_id = ?').bind(user.id).first<{ created_at: number }>();
  // Recover the Customer by metadata after a lost response or expired HTTP key.
  const query = new URLSearchParams({ query: `metadata['mainbrella_prepaid_user']:'${user.id.replace(/['\\]/g, '')}'`, limit: '100' });
  const found = await stripeRequest<{ data: { id: string; metadata?: Record<string, string> }[]; has_more: boolean }>(env, `/customers/search?${query}`);
  const matches = found.data.filter(customer => customer.metadata?.mainbrella_prepaid_user === user.id);
  if (matches.length > 1 || found.has_more) throw new Error('billing_reconciliation_required');
  if (!matches.length && (!request || Date.now() - request.created_at >= 23 * 3600000)) throw new Error('billing_reconciliation_required');
  const params = new URLSearchParams({ 'metadata[mainbrella_prepaid_user]': user.id });
  if (user.email) params.set('email', user.email);
  if (user.name) params.set('name', user.name);
  const customer = matches[0] ?? await stripeRequest<{ id: string }>(env, '/customers', params, `mainbrella-prepaid-customer-${user.id}`);
  if (!stripeID(customer.id, 'cus')) throw new Error('billing_unavailable');
  await env.DB.prepare('INSERT INTO prepaid_accounts (user_id,stripe_customer_id,created_at) VALUES (?,?,?) ON CONFLICT(user_id) DO NOTHING')
    .bind(user.id, customer.id, Date.now()).run();
  const record = await prepaidAccount(env, user.id);
  if (!record) throw new Error('billing_unavailable');
  return record;
}

function ownedIntent(intent: PaymentIntent, account: PrepaidAccount): boolean {
  return intent.customer === account.stripe_customer_id && intent.metadata?.mainbrella_user_id === account.user_id
    && ['prepaid_topup', 'prepaid_recharge'].includes(intent.metadata?.mainbrella_kind);
}
function fundingFromIntent(intent: PaymentIntent, account: PrepaidAccount): Funding | null {
  if (!ownedIntent(intent, account)) throw new Error('payment_not_owned');
  if (intent.status !== 'succeeded') return null;
  const charge = intent.latest_charge;
  if (intent.currency !== 'usd' || !validTopupAmount(intent.amount) || intent.amount_received !== intent.amount
    || !Number.isSafeInteger(intent.created) || !charge || charge.customer !== account.stripe_customer_id
    || charge.payment_intent !== intent.id || charge.currency !== 'usd' || charge.amount !== intent.amount
    || charge.payment_method_details?.type !== 'card'
    || charge.paid !== true || charge.captured !== true || charge.status !== 'succeeded'
    || !Number.isSafeInteger(charge.amount_refunded) || charge.amount_refunded < 0 || charge.amount_refunded > charge.amount
    || typeof charge.disputed !== 'boolean' || typeof charge.refunded !== 'boolean' || (charge.refunded && charge.amount_refunded !== charge.amount)) throw new Error('invalid_payment');
  return { id: intent.id, customerId: intent.customer, amountCents: intent.amount, refundedCents: charge.amount_refunded,
    disputed: charge.disputed, createdAt: intent.created * 1000, kind: 'topup' };
}
export async function verifyPrepaidPayment(env: BillingEnv, account: PrepaidAccount, paymentIntentId: string): Promise<{ funding: Funding | null; intent: PaymentIntent }> {
  if (!stripeID(paymentIntentId, 'pi')) throw new Error('invalid_payment');
  const intent = await stripeRequest<PaymentIntent>(env, `/payment_intents/${encodeURIComponent(paymentIntentId)}?expand[]=latest_charge`);
  if (intent.id !== paymentIntentId) throw new Error('invalid_payment');
  return { funding: fundingFromIntent(intent, account), intent };
}
export async function applyPrepaidPayment(env: BillingEnv, account: PrepaidAccount, paymentIntentId: string): Promise<{ balance: PrepaidBalance } | null> {
  const { funding, intent } = await verifyPrepaidPayment(env, account, paymentIntentId);
  if (!funding) return null;
  if (intent.metadata.mainbrella_kind === 'prepaid_topup') {
    const topup = await env.DB.prepare('SELECT request_id,user_id,stripe_customer_id,amount_cents,checkout_session_id,created_at FROM prepaid_topups WHERE request_id = ?')
      .bind(intent.metadata.mainbrella_request_id ?? '').first<Topup>();
    if (!topup || topup.user_id !== account.user_id || topup.stripe_customer_id !== account.stripe_customer_id || topup.amount_cents !== funding.amountCents) throw new Error('payment_not_owned');
  }
  const result = await accountBillingRequest(env, account.user_id, '/billing/funding', funding);
  if (!funding.refundedCents && !funding.disputed) {
    await env.DB.prepare('UPDATE prepaid_accounts SET latest_payment_intent_id = ? WHERE user_id = ?').bind(intent.id, account.user_id).run();
    if (result.balance.autoRecharge.enabled) await saveRechargePaymentMethod(env, account, intent);
  }
  return result;
}
async function saveRechargePaymentMethod(env: BillingEnv, account: PrepaidAccount, intent: PaymentIntent): Promise<void> {
  const method = typeof intent.payment_method === 'string' ? intent.payment_method : intent.payment_method?.id;
  if (!stripeID(method, 'pm')) return;
  const pm = await stripeRequest<{ id: string; customer: string | null; type: string }>(env, `/payment_methods/${encodeURIComponent(method)}`);
  if (pm.id !== method || pm.type !== 'card' || (pm.customer && pm.customer !== account.stripe_customer_id)) throw new Error('payment_not_owned');
  if (!pm.customer) await stripeRequest(env, `/payment_methods/${encodeURIComponent(method)}/attach`, new URLSearchParams({ customer: account.stripe_customer_id }), `mainbrella-prepaid-attach-${intent.id}`);
  await env.DB.prepare('UPDATE prepaid_accounts SET payment_method_id = ? WHERE user_id = ?').bind(method, account.user_id).run();
}
export async function enableRechargePaymentMethod(env: BillingEnv, account: PrepaidAccount): Promise<void> {
  if (!account.latest_payment_intent_id) return;
  const { intent, funding } = await verifyPrepaidPayment(env, account, account.latest_payment_intent_id);
  if (funding && !funding.refundedCents && !funding.disputed) await saveRechargePaymentMethod(env, account, intent);
}

export async function createPrepaidCheckout(env: BillingEnv, account: PrepaidAccount, amountCents: number, requestId: string, origin: string): Promise<{ url: string; sessionId: string }> {
  await env.DB.prepare('INSERT INTO prepaid_topups (request_id,user_id,stripe_customer_id,amount_cents,created_at) VALUES (?,?,?,?,?) ON CONFLICT(request_id) DO NOTHING')
    .bind(requestId, account.user_id, account.stripe_customer_id, amountCents, Date.now()).run();
  const entry = await env.DB.prepare('SELECT request_id,user_id,stripe_customer_id,amount_cents,checkout_session_id,created_at FROM prepaid_topups WHERE request_id = ?').bind(requestId).first<Topup>();
  if (!entry || entry.user_id !== account.user_id || entry.stripe_customer_id !== account.stripe_customer_id) throw new Error('request_not_owned');
  if (entry.amount_cents !== amountCents) throw new Error('topup_request_conflict');
  let session: PrepaidCheckout | undefined;
  if (entry.checkout_session_id) session = await stripeRequest<PrepaidCheckout>(env, `/checkout/sessions/${encodeURIComponent(entry.checkout_session_id)}`);
  else {
    const params = new URLSearchParams({ customer: account.stripe_customer_id, limit: '100' });
    while (true) {
      const page = await stripeRequest<{ data: PrepaidCheckout[]; has_more: boolean }>(env, `/checkout/sessions?${params}`);
      const matches = page.data.filter(value => value.metadata?.mainbrella_request_id === requestId);
      if (matches.length > 1 || (session && matches.length)) throw new Error('billing_reconciliation_required');
      session ??= matches[0];
      if (!page.has_more || !page.data.length) break;
      params.set('starting_after', page.data[page.data.length - 1].id);
    }
  }
  if (!session) {
    if (Date.now() - entry.created_at >= 23 * 3600000) throw new Error('billing_reconciliation_required');
    const { balance } = await accountBillingRequest(env, account.user_id, '/billing/balance');
    const price = await prepaidReferencePrice(env);
    const fields = new URLSearchParams({ mode: 'payment', customer: account.stripe_customer_id,
      client_reference_id: account.user_id, 'payment_method_types[0]': 'card',
      'line_items[0][quantity]': '1',
      'metadata[mainbrella_request_id]': requestId, 'metadata[mainbrella_user_id]': account.user_id,
      'payment_intent_data[metadata][mainbrella_request_id]': requestId, 'payment_intent_data[metadata][mainbrella_user_id]': account.user_id,
      'payment_intent_data[metadata][mainbrella_kind]': 'prepaid_topup',
      success_url: `${origin}/pricing/usage?topup_return=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/pricing/usage?topup_canceled=1`,
    });
    if (amountCents === MIN_TOPUP_CENTS) fields.set('line_items[0][price]', price.id);
    else {
      fields.set('line_items[0][price_data][currency]', 'usd');
      fields.set('line_items[0][price_data][product]', price.product.id);
      fields.set('line_items[0][price_data][unit_amount]', String(amountCents));
    }
    if (balance.autoRecharge.enabled) fields.set('payment_intent_data[setup_future_usage]', 'off_session');
    session = await stripeRequest<PrepaidCheckout>(env, '/checkout/sessions', fields, `mainbrella-prepaid-topup-${requestId}`);
  }
  if (!stripeID(session.id, 'cs') || session.customer !== account.stripe_customer_id || session.client_reference_id !== account.user_id
    || session.mode !== 'payment' || session.currency !== 'usd' || session.amount_total !== amountCents
    || session.metadata?.mainbrella_request_id !== requestId) throw new Error('checkout_not_owned');
  await env.DB.prepare('UPDATE prepaid_topups SET checkout_session_id = ? WHERE request_id = ?').bind(session.id, requestId).run();
  if (session.status === 'complete') throw new Error('topup_already_complete');
  if (session.status !== 'open' || !session.url || !session.url.startsWith('https://checkout.stripe.com/')) throw new Error('topup_expired');
  return { url: session.url, sessionId: session.id };
}
export async function completePrepaidCheckout(env: BillingEnv, account: PrepaidAccount, sessionId: string): Promise<{ balance: PrepaidBalance }> {
  const receipt = await env.DB.prepare('SELECT request_id,user_id,stripe_customer_id,amount_cents,checkout_session_id,created_at FROM prepaid_topups WHERE checkout_session_id = ?')
    .bind(sessionId).first<Topup>();
  const session = await stripeRequest<PrepaidCheckout>(env, `/checkout/sessions/${encodeURIComponent(sessionId)}`);
  // A webhook can recover the session ID when creation's Stripe response was lost.
  const request = receipt ?? await env.DB.prepare('SELECT request_id,user_id,stripe_customer_id,amount_cents,checkout_session_id,created_at FROM prepaid_topups WHERE request_id = ?')
    .bind(session.metadata?.mainbrella_request_id ?? '').first<Topup>();
  if (!request || request.user_id !== account.user_id || request.stripe_customer_id !== account.stripe_customer_id
    || session.id !== sessionId || session.mode !== 'payment' || session.customer !== account.stripe_customer_id
    || session.client_reference_id !== account.user_id || session.metadata?.mainbrella_request_id !== request.request_id
    || session.currency !== 'usd' || session.amount_total !== request.amount_cents) throw new Error('checkout_not_owned');
  if (session.status === 'expired') throw new Error('topup_expired');
  if (session.status !== 'complete' || session.payment_status !== 'paid' || !session.payment_intent) throw new Error('payment_pending');
  const verified = await verifyPrepaidPayment(env, account, session.payment_intent);
  if (verified.intent.metadata?.mainbrella_request_id !== request.request_id) throw new Error('payment_not_owned');
  const result = await applyPrepaidPayment(env, account, session.payment_intent);
  if (!result) throw new Error('payment_pending');
  await env.DB.prepare('UPDATE prepaid_topups SET checkout_session_id = ? WHERE request_id = ?').bind(session.id, request.request_id).run();
  return result;
}

export async function prepaidRecharge(env: BillingEnv, entry: PrepaidRechargeEntry): Promise<RechargeResult> {
  if (!prepaidBillingConfigured(env) || !validTopupAmount(entry.amountCents)) throw new Error('billing_unavailable');
  const account = await prepaidAccountByCustomer(env, entry.customerId);
  if (!account || (entry.userId && account.user_id !== entry.userId)) throw new Error('payment_not_owned');
  let intent: PaymentIntent | undefined;
  if (entry.paymentIntentId) intent = (await verifyPrepaidPayment(env, account, entry.paymentIntentId)).intent;
  else {
    const query = new URLSearchParams({ customer: entry.customerId, limit: '100' });
    while (true) {
      const page = await stripeRequest<{ data: PaymentIntent[]; has_more: boolean }>(env, `/payment_intents?${query}`);
      const matches = page.data.filter(value => value.metadata?.mainbrella_recharge_id === entry.identifier);
      if (matches.length > 1 || (intent && matches.length)) throw new Error('billing_reconciliation_required');
      intent ??= matches[0];
      if (!page.has_more || !page.data.length) break;
      query.set('starting_after', page.data[page.data.length - 1].id);
    }
    if (intent) intent = (await verifyPrepaidPayment(env, account, intent.id)).intent;
  }
  if (!intent) {
    if (Date.now() - entry.createdAt >= 23 * 3600000) throw new Error('billing_reconciliation_required');
    if (!account.payment_method_id) return { status: 'requires_action' };
    const params = new URLSearchParams({ amount: String(entry.amountCents), currency: 'usd', customer: entry.customerId,
      description: 'Mainbrella prepaid balance recharge',
      payment_method: account.payment_method_id, off_session: 'true', confirm: 'true', 'payment_method_types[0]': 'card',
      'metadata[mainbrella_kind]': 'prepaid_recharge', 'metadata[mainbrella_user_id]': account.user_id,
      'metadata[mainbrella_recharge_id]': entry.identifier, 'expand[0]': 'latest_charge',
    });
    intent = await stripeRequest<PaymentIntent>(env, '/payment_intents', params, entry.identifier);
  }
  if (!stripeID(intent.id, 'pi') || !ownedIntent(intent, account) || intent.metadata.mainbrella_kind !== 'prepaid_recharge'
    || intent.metadata.mainbrella_recharge_id !== entry.identifier || intent.amount !== entry.amountCents) throw new Error('payment_not_owned');
  let funding = fundingFromIntent(intent, account);
  if (funding) return { status: 'succeeded', paymentIntentId: intent.id, funding };
  if (intent.status === 'processing') return { status: 'processing', paymentIntentId: intent.id };
  if (intent.status !== 'canceled') {
    // There is no authentication flow for an off-session attempt. Cancel it
    // before releasing authorization, so it cannot later succeed behind a new
    // manual top-up or a replacement automatic charge.
    try { await stripeRequest(env, `/payment_intents/${encodeURIComponent(intent.id)}/cancel`, new URLSearchParams({ cancellation_reason: 'requested_by_customer' }), `cancel-${entry.identifier}`); }
    catch { /* A payment may win the cancellation race. Re-read its proof. */ }
    intent = (await verifyPrepaidPayment(env, account, intent.id)).intent;
    if (intent.metadata.mainbrella_kind !== 'prepaid_recharge' || intent.metadata.mainbrella_recharge_id !== entry.identifier || intent.amount !== entry.amountCents) throw new Error('payment_not_owned');
    funding = fundingFromIntent(intent, account);
    if (funding) return { status: 'succeeded', paymentIntentId: intent.id, funding };
    if (intent.status === 'processing') return { status: 'processing', paymentIntentId: intent.id };
  }
  if (intent.status !== 'canceled') throw new Error('billing_reconciliation_required');
  return { status: 'failed', paymentIntentId: intent.id };
}
