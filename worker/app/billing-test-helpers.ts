import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import { hashToken } from './auth-core';
import { PLAN_PRICES, type BillingEnv, type Plan, type StripeSubscription } from '../lib/stripe';

export const TEST_USER = 'user_test';
export const TEST_CUSTOMER = 'cus_test';
export const TEST_SESSION = 'browser_token';
export function paidSubscription(plan: Plan = 'builder'): StripeSubscription {
  const now = Math.floor(Date.now() / 1000);
  return { id: 'sub_paid', customer: TEST_CUSTOMER, status: 'active', cancel_at_period_end: false,
    items: { data: [{ id: 'si_paid', quantity: 1, price: { id: PLAN_PRICES[plan] }, current_period_start: now - 3600, current_period_end: now + 86400 }] } };
}
export function paidInvoice(plan: Plan = 'builder') {
  const now = Math.floor(Date.now() / 1000);
  return { id: 'in_paid', status: 'paid', amount_paid: 500, paid_out_of_band: false,
    lines: { data: [{ id: 'il_paid', amount: 500, quantity: 1, pricing: { price_details: { price: PLAN_PRICES[plan] } },
      parent: { subscription_item_details: { subscription: 'sub_paid', subscription_item: 'si_paid' } },
      period: { start: now - 3600, end: now + 86400 } }], has_more: false } };
}
export function paidCharge() { return { id: 'ch_paid', paid: true, captured: true, amount: 500, status: 'succeeded', amount_refunded: 0, refunded: false, disputed: false }; }
export function billingRequest(path = '/subscription', body: unknown = undefined, authenticated = true, origin: string | null = 'https://mainbrella.com', method = body === undefined ? 'GET' : 'POST') {
  return new Request(`https://api.mainbrella.com${path}`, { method, headers: {
    ...(origin ? { Origin: origin } : {}), ...(authenticated ? { Cookie: `mainbrella_session=${TEST_SESSION}` } : {}),
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
  }, body: body === undefined ? undefined : JSON.stringify(body) });
}
export async function billingFixture(t: TestContext, plan: Plan = 'builder', record = true) {
  const sqlite = new DatabaseSync(':memory:');
  for (const migration of ['001_initial', '002_auth_sessions', '003_pro_billing', '004_subscription_details', '005_ssh_access', '009_trial_coupons', '006_billing_webhooks']) {
    sqlite.exec(readFileSync(fileURLToPath(new URL(`../../migrations/${migration}.sql`, import.meta.url)), 'utf8'));
  }
  sqlite.prepare('INSERT INTO users (id,email,name) VALUES (?,?,?)').run(TEST_USER, 'test@example.com', 'Test');
  sqlite.prepare('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)').run(await hashToken(TEST_SESSION), TEST_USER, '2099-01-01');
  if (record) sqlite.prepare('INSERT INTO pro_billing (user_id,stripe_customer_id,checkout_session_id) VALUES (?,?,?)').run(TEST_USER, TEST_CUSTOMER, 'cs_old');
  t.after(() => sqlite.close());
  const env = { STRIPE_SECRET_KEY: 'sk_test', STRIPE_PUBLISHABLE_KEY: 'pk_test', STRIPE_WEBHOOK_SECRET: 'whsec_test', DB: {
    prepare(sql: string) { let values: unknown[] = []; return {
      bind(...args: unknown[]) { values = args; return this; },
      async first<T>() { return (sqlite.prepare(sql).get(...values as never[]) as T) ?? null; },
      async run() { const result = sqlite.prepare(sql).run(...values as never[]); return { meta: { changes: Number(result.changes) } }; },
      async all<T>() { return { results: sqlite.prepare(sql).all(...values as never[]) as T[] }; },
    }; },
  } } as unknown as BillingEnv;
  const state = {
    subscriptions: [paidSubscription(plan)] as StripeSubscription[], invoices: [paidInvoice(plan)],
    payments: [{ id: 'inpay_paid', invoice: 'in_paid', status: 'paid', amount_paid: 500, payment: { type: 'payment_intent', payment_intent: 'pi_paid', charge: undefined as string | undefined } }],
    intent: { id: 'pi_paid', status: 'succeeded', amount_received: 500, latest_charge: paidCharge() },
    checkout: { id: 'cs_old', status: 'open', ui_mode: 'embedded', allow_promotion_codes: true, client_secret: 'cs_old_secret', customer: TEST_CUSTOMER, client_reference_id: TEST_USER, metadata: { plan } },
    schedules: new Map<string, Record<string, any>>(),
    override: null as null | ((url: URL, init: RequestInit | undefined) => Promise<Response | undefined> | Response | undefined),
  };
  const calls: { url: URL; init?: RequestInit; params: URLSearchParams }[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const params = new URLSearchParams(String(init?.body ?? ''));
    calls.push({ url, init, params });
    const override = await state.override?.(url, init); if (override) return override;
    if (url.pathname === '/v1/subscriptions') return Response.json({ data: state.subscriptions, has_more: false });
    if (url.pathname === '/v1/invoices') return Response.json({ data: state.invoices, has_more: false });
    if (url.pathname === '/v1/invoice_payments') return Response.json({ data: state.payments, has_more: false });
    if (url.pathname === '/v1/payment_intents/pi_paid') return Response.json(state.intent);
    if (url.pathname === '/v1/charges/ch_paid') return Response.json({ ...state.intent.latest_charge, customer: TEST_CUSTOMER });
    if (url.pathname === '/v1/customers') return Response.json({ id: TEST_CUSTOMER });
    if (url.pathname === '/v1/checkout/sessions/cs_old') return Response.json(state.checkout);
    if (url.pathname === '/v1/checkout/sessions/cs_old/expire') { state.checkout.status = 'expired'; return Response.json(state.checkout); }
    if (url.pathname === '/v1/checkout/sessions') return Response.json({ id: 'cs_new', client_secret: 'cs_new_secret' });
    if (url.pathname.startsWith('/v1/prices/')) return Response.json({ id: url.pathname.split('/').at(-1), product: `prod_${url.pathname.split('/').at(-1)}` });
    if (url.pathname === '/v1/billing_portal/configurations') return Response.json({ id: 'bpc_config' });
    if (url.pathname === '/v1/billing_portal/sessions') return Response.json({ url: 'https://billing.stripe.com/session_test' });
    if (url.pathname === '/v1/subscriptions/sub_paid' && init?.method === 'POST') {
      const sub = state.subscriptions[0];
      if (params.has('cancel_at_period_end')) sub.cancel_at_period_end = params.get('cancel_at_period_end') === 'true';
      return Response.json(sub);
    }
    if (url.pathname === '/v1/subscription_schedules') {
      const sub = state.subscriptions[0];
      const item = sub.items.data[0];
      const id = `sub_sched_${state.schedules.size + 1}`;
      const schedule = { id, status: 'active', customer: TEST_CUSTOMER, subscription: sub.id, metadata: {},
        phases: [{ start_date: item.current_period_start!, end_date: item.current_period_end!, items: [{ price: item.price.id, quantity: 1 }] }] };
      state.schedules.set(id, schedule); sub.schedule = id; return Response.json(schedule);
    }
    if (url.pathname.startsWith('/v1/subscription_schedules/')) {
      const id = url.pathname.split('/')[3];
      const schedule = state.schedules.get(id); if (!schedule) throw new Error(`Missing schedule ${id}`);
      if (url.pathname.endsWith('/release')) { schedule.status = 'released'; state.subscriptions[0].schedule = null; }
      else if (init?.method === 'POST') {
        if (schedule.status === 'released') return Response.json({ error: {} }, { status: 400 });
        if (params.has('metadata[app_user_id]')) schedule.metadata.app_user_id = params.get('metadata[app_user_id]');
        if (params.has('phases[1][items][0][price]')) schedule.phases = [
          { start_date: Number(params.get('phases[0][start_date]')), end_date: Number(params.get('phases[0][end_date]')), items: [{ price: params.get('phases[0][items][0][price]'), quantity: 1 }] },
          { start_date: Number(params.get('phases[1][start_date]')), end_date: Number(params.get('phases[1][start_date]')) + 30 * 86400, items: [{ price: params.get('phases[1][items][0][price]'), quantity: 1 }] },
        ];
      }
      return Response.json(schedule);
    }
    throw new Error(`Unexpected Stripe request: ${url}`);
  });
  return { env, sqlite, state, calls };
}
