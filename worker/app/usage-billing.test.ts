import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { billingFixture, billingRequest, TEST_CUSTOMER, TEST_USER } from './billing-test-helpers';
import { invoiceAccountUsage, invoiceCanceledUsage, invoiceResourceUsage, type UsageInvoice } from '../lib/usage-billing';
import { resolveEntitlement } from '../lib/entitlements';
import { subscriptionPlan } from '../lib/stripe';
import { handleSubscriptionRequest } from './subscription';

const entry = (): UsageInvoice => ({ identifier: 'mainbrella-usage-sub_paid-1000', invoiceId: 'in_renewal',
  customerId: TEST_CUSTOMER, subscriptionId: 'sub_paid', amountCents: 700, totalCents: 1200,
  periodStart: 1000, periodEnd: 2000, createdAt: Date.now() });
const renewal = () => ({ id: 'in_renewal', status: 'draft', customer: TEST_CUSTOMER, created: Math.floor(Date.now() / 1000),
  parent: { subscription_details: { subscription: 'sub_paid' } } });

test('a lost invoice-item response is recovered by durable metadata without another charge, even after 24 hours', async t => {
  const f = await billingFixture(t, 'usage'); const items: any[] = [];
  f.state.override = (url, init) => {
    if (url.pathname === '/v1/invoiceitems' && init?.method === 'GET') return Response.json({ data: items, has_more: false });
    if (url.pathname === '/v1/invoices/in_renewal') return Response.json(renewal());
    if (url.pathname === '/v1/invoiceitems' && init?.method === 'POST') {
      const params = new URLSearchParams(String(init.body));
      assert.equal(params.get('invoice'), 'in_renewal'); assert.equal(params.get('subscription'), 'sub_paid');
      assert.equal(params.get('amount'), '700'); assert.equal(params.get('discountable'), 'false');
      assert.equal((init.headers as any)['Idempotency-Key'], entry().identifier);
      items.push({ id: 'ii_usage', customer: TEST_CUSTOMER, amount: 700, invoice: 'in_renewal',
        metadata: { mainbrella_ledger_id: params.get('metadata[mainbrella_ledger_id]') } });
      throw new Error('response_lost');
    }
  };
  await assert.rejects(invoiceResourceUsage(f.env, entry()), /response_lost/);
  assert.equal(await invoiceResourceUsage(f.env, { ...entry(), createdAt: Date.now() - 25 * 3600000 }), 'ii_usage');
  assert.equal(items.length, 1);
});

test('ambiguous old writes, finalized invoices and mismatched customer invoices require reconciliation', async t => {
  const f = await billingFixture(t, 'usage'); let invoice = renewal();
  f.state.override = url => url.pathname === '/v1/invoiceitems' ? Response.json({ data: [], has_more: false })
    : url.pathname === '/v1/invoices/in_renewal' ? Response.json(invoice) : undefined;
  await assert.rejects(invoiceResourceUsage(f.env, { ...entry(), createdAt: Date.now() - 24 * 3600000 }), /reconciliation_required/);
  invoice = { ...invoice, status: 'paid' };
  await assert.rejects(invoiceResourceUsage(f.env, entry()), /reconciliation_required/);
  invoice = { ...renewal(), customer: 'cus_other' };
  await assert.rejects(invoiceResourceUsage(f.env, entry()), /reconciliation_required/);
  assert.equal(f.calls.filter(call => call.url.pathname === '/v1/invoiceitems' && call.init?.method === 'POST').length, 0);
});

test('renewal invoicing binds live Stripe ownership to the account and never accepts a foreign customer', async t => {
  const f = await billingFixture(t, 'usage'); const contexts: any[] = [];
  f.env.CONTAINER_ACCOUNT = { idFromName: (name: string) => name, get: () => ({ async fetch(request: Request) {
    assert.equal(request.headers.get('x-mainbrella-user'), TEST_USER);
    contexts.push(await request.json()); return Response.json({ invoiced: true });
  } }) } as any;
  f.state.override = url => url.pathname === '/v1/invoices/in_renewal' ? Response.json(renewal())
    : url.pathname === '/v1/subscriptions/sub_paid' ? Response.json(f.state.subscriptions[0]) : undefined;
  await invoiceAccountUsage(f.env, TEST_USER, TEST_CUSTOMER, 'in_renewal');
  assert.equal(contexts[0].invoiceId, 'in_renewal'); assert.equal(contexts[0].subscriptionId, 'sub_paid');
  await invoiceAccountUsage(f.env, TEST_USER, 'cus_other', 'in_renewal');
  assert.equal(contexts.length, 1);
});

test('cancellation recovers the same final usage invoice and uses the subscription payment method without a base fee', async t => {
  const f = await billingFixture(t, 'usage'); let final: any; const contexts: any[] = [];
  f.state.subscriptions[0].status = 'canceled'; f.state.subscriptions[0].default_payment_method = 'pm_owned';
  f.env.CONTAINER_ACCOUNT = { idFromName: (name: string) => name, get: () => ({ async fetch(request: Request) {
    contexts.push(await request.json()); return Response.json({ invoiced: true });
  } }) } as any;
  f.state.override = (url, init) => {
    if (url.pathname === '/v1/subscriptions/sub_paid') return Response.json(f.state.subscriptions[0]);
    if (url.pathname === '/v1/invoices' && init?.method === 'GET') return Response.json({ data: final ? [final] : [], has_more: false });
    if (url.pathname === '/v1/invoices' && init?.method === 'POST') {
      const params = new URLSearchParams(String(init.body));
      assert.equal(params.get('default_payment_method'), 'pm_owned'); assert.equal(params.get('auto_advance'), 'false');
      assert.equal(params.get('subscription'), 'sub_paid');
      assert.equal(params.has('price'), false);
      final = { ...renewal(), id: 'in_final', metadata: { mainbrella_subscription_id: 'sub_paid', mainbrella_final_usage: 'true' } };
      return Response.json(final);
    }
    if (url.pathname === '/v1/invoices/in_final') return Response.json(final);
  };
  await invoiceCanceledUsage(f.env, TEST_USER, TEST_CUSTOMER, 'sub_paid');
  await invoiceCanceledUsage(f.env, TEST_USER, TEST_CUSTOMER, 'sub_paid');
  assert.equal(f.calls.filter(call => call.url.pathname === '/v1/invoices' && call.init?.method === 'POST').length, 1);
  assert.equal(contexts[0].final, true); assert.equal(contexts[0].entitlement.active, false);
});

test('usage access proves payment against the base fee even when allowlisted metered items precede it', async t => {
  const f = await billingFixture(t, 'usage'); const subscription = f.state.subscriptions[0];
  f.env.STRIPE_USAGE_METERED_PRICE_IDS = 'price_compute';
  subscription.items.data.unshift({ id: 'si_meter', price: { id: 'price_compute' }, current_period_end: 1 });
  assert.equal(subscriptionPlan(subscription, f.env), 'usage');
  const entitlement = await resolveEntitlement(f.env, TEST_USER);
  assert.equal(entitlement.active, true); assert.equal(entitlement.billing?.subscriptionId, 'sub_paid');
  assert.ok(entitlement.validUntil! > Date.now());
  subscription.items.data[0].quantity = null;
  assert.equal(subscriptionPlan(subscription, f.env), 'usage');
  subscription.items.data[0].price.id = 'price_unknown';
  assert.equal((await resolveEntitlement(f.env, TEST_USER)).active, false);
});

test('spending cap changes remain cookie-authenticated and require a trusted browser Origin', async t => {
  const f = await billingFixture(t, 'usage');
  assert.equal((await handleSubscriptionRequest(billingRequest('/subscription/usage', { spendLimitCents: 5000 }, false), f.env)).status, 401);
  assert.equal((await handleSubscriptionRequest(billingRequest('/subscription/usage', { spendLimitCents: 5000 }, true, null), f.env)).status, 403);
  assert.equal(f.calls.length, 0);
});

test('the usage migration preserves every existing subscriber field and ownership constraints', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec('PRAGMA foreign_keys = ON');
  for (const migration of ['001_initial', '003_pro_billing', '004_subscription_details']) {
    db.exec(readFileSync(new URL(`../../migrations/${migration}.sql`, import.meta.url), 'utf8'));
  }
  for (const [index, plan] of ['builder', 'pro', 'scale'].entries()) {
    db.prepare('INSERT INTO users (id) VALUES (?)').run(`owner_${index}`);
    db.prepare(`INSERT INTO pro_billing (user_id, stripe_customer_id, checkout_session_id, plan,
      stripe_subscription_id, subscription_status, cancel_at_period_end, current_period_end, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(`owner_${index}`, `cus_${index}`, `cs_${index}`, plan,
        `sub_${index}`, 'active', 1, 1800000000, '2026-10-09T00:00:00Z');
  }
  const before = db.prepare('SELECT * FROM pro_billing ORDER BY user_id').all();
  db.exec(readFileSync(new URL('../../migrations/018_usage_billing.sql', import.meta.url), 'utf8'));
  assert.deepEqual(db.prepare('SELECT * FROM pro_billing ORDER BY user_id').all(), before);
  db.prepare("UPDATE pro_billing SET plan = 'usage' WHERE user_id = 'owner_0'").run();
  assert.throws(() => db.prepare("UPDATE pro_billing SET plan = 'unknown' WHERE user_id = 'owner_0'").run());
  assert.throws(() => db.prepare("UPDATE pro_billing SET stripe_customer_id = 'cus_1' WHERE user_id = 'owner_0'").run());
  db.prepare("DELETE FROM users WHERE id = 'owner_0'").run();
  assert.equal((db.prepare("SELECT count(*) AS n FROM pro_billing WHERE user_id = 'owner_0'").get() as any).n, 0);
});
