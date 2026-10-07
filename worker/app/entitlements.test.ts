import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveEntitlement, subscriptionEntitlement } from '../lib/entitlements';
import { PLAN_PRICES, subscriptionPlan, type BillingEnv } from '../lib/stripe';
import { billingFixture, paidInvoice, paidSubscription, TEST_USER } from './billing-test-helpers';

for (const status of ['trialing', 'incomplete', 'incomplete_expired', 'past_due', 'unpaid', 'paused', 'canceled']) {
  test(`${status} never grants container access despite saved paid status`, async t => {
    const f = await billingFixture(t); f.state.subscriptions[0].status = status;
    const access = await resolveEntitlement(f.env, TEST_USER);
    assert.equal(access.active, false); assert.equal(access.plan, null); assert.equal(access.validUntil, null);
    assert.ok(Number.isInteger(access.checkedAt));
    assert.equal(f.calls.filter(c => c.url.pathname === '/v1/invoices').length, 0);
  });
}

test('unregistered accounts are unpaid without Stripe requests, keys, or Builder fallback', async t => {
  const f = await billingFixture(t, 'builder', false);
  const access = await resolveEntitlement({ ...f.env, STRIPE_SECRET_KEY: undefined } as unknown as BillingEnv, TEST_USER);
  assert.equal(access.active, false); assert.equal(access.plan, null); assert.equal(f.calls.length, 0);
});

test('active status alone, zero invoices, manually paid invoices and noncurrent payments never grant access', async t => {
  const f = await billingFixture(t);
  const invoice = f.state.invoices[0];
  for (const modify of [
    () => { invoice.amount_paid = 0; },
    () => { invoice.paid_out_of_band = true; },
    () => { invoice.status = 'open'; },
    () => { invoice.lines.data[0].period.end = Math.floor(Date.now() / 1000) - 1; },
    () => { invoice.lines.data[0].period.start = Math.floor(Date.now() / 1000) + 3600; },
    () => { invoice.lines.data[0].pricing.price_details.price = PLAN_PRICES.pro; },
    () => { invoice.lines.data[0].parent.subscription_item_details.subscription = 'sub_someone_else'; },
    () => { invoice.lines.data[0].quantity = 2; },
    () => { invoice.lines.data[0].amount = -500; },
  ]) {
    f.state.invoices = [paidInvoice()]; const fresh = f.state.invoices[0]; Object.assign(invoice, fresh); f.state.invoices = [invoice];
    modify(); assert.equal((await resolveEntitlement(f.env, TEST_USER)).active, false);
  }
  f.state.invoices = [];
  assert.equal((await resolveEntitlement(f.env, TEST_USER)).active, false);
});

test('invoice paid flags cannot replace a real Stripe payment', async t => {
  const f = await billingFixture(t);
  for (const type of ['payment_record', 'unknown']) {
    f.state.payments[0].payment.type = type;
    assert.equal((await resolveEntitlement(f.env, TEST_USER)).active, false);
  }
  f.state.payments[0].payment.type = 'payment_intent'; f.state.intent.status = 'requires_payment_method';
  assert.equal((await resolveEntitlement(f.env, TEST_USER)).active, false);
  f.state.intent.status = 'succeeded'; f.state.intent.amount_received = 0;
  assert.equal((await resolveEntitlement(f.env, TEST_USER)).active, false);
  f.state.intent.amount_received = 500; f.state.payments[0].invoice = 'in_someone_else';
  assert.equal((await resolveEntitlement(f.env, TEST_USER)).active, false);
  f.state.payments[0].invoice = 'in_paid'; f.state.payments[0].amount_paid = 1;
  assert.equal((await resolveEntitlement(f.env, TEST_USER)).active, false);
  f.state.payments = [];
  assert.equal((await resolveEntitlement(f.env, TEST_USER)).active, false);
});

test('refunded, partially refunded, disputed, unpaid and failed charges revoke access', async t => {
  const f = await billingFixture(t); const charge = f.state.intent.latest_charge;
  for (const patch of [{ refunded: true }, { amount_refunded: 1 }, { disputed: true }, { paid: false }, { status: 'failed' }, { amount: 0 }]) {
    const old = { ...charge }; Object.assign(charge, patch);
    assert.equal((await resolveEntitlement(f.env, TEST_USER)).active, false);
    Object.assign(charge, old);
  }
  assert.equal((await resolveEntitlement(f.env, TEST_USER)).active, true);
});

test('subscription quantities, mixed items, pause_collection and expired periods fail closed', async t => {
  const f = await billingFixture(t); const sub = f.state.subscriptions[0];
  for (const quantity of [undefined, 0, 2, 1.5]) {
    sub.items.data[0].quantity = quantity; assert.equal(subscriptionPlan(sub), null);
    assert.equal((await subscriptionEntitlement(f.env, sub)).active, false);
  }
  sub.items.data[0].quantity = 1; sub.items.data.push({ quantity: 1, price: { id: 'price_extra' } });
  assert.equal((await subscriptionEntitlement(f.env, sub)).active, false);
  sub.items.data.pop(); sub.pause_collection = { behavior: 'keep_as_draft' };
  assert.equal((await subscriptionEntitlement(f.env, sub)).active, false);
  sub.pause_collection = null; sub.items.has_more = true;
  assert.equal((await subscriptionEntitlement(f.env, sub)).active, false);
  sub.items.has_more = false;
  sub.pause_collection = null; sub.items.data[0].current_period_end = Math.floor(Date.now() / 1000);
  assert.equal((await subscriptionEntitlement(f.env, sub)).active, false);
});

test('paid prorations authorize the upgraded price only through its covered period', async t => {
  const f = await billingFixture(t, 'pro');
  const end = Math.floor(Date.now() / 1000) + 600;
  f.state.invoices[0].lines.data[0].period.end = end;
  f.state.invoices[0].lines.data[0].period.start = Math.floor(Date.now() / 1000) - 1;
  const access = await resolveEntitlement(f.env, TEST_USER);
  assert.equal(access.plan, 'pro'); assert.equal(access.validUntil, end * 1000);
  f.state.subscriptions[0].cancel_at = end - 100;
  assert.equal((await resolveEntitlement(f.env, TEST_USER)).validUntil, (end - 100) * 1000);
});

test('an unpaid pending upgrade keeps only the last live paid plan', async t => {
  const f = await billingFixture(t, 'builder');
  f.state.invoices.unshift({ ...paidInvoice('pro'), id: 'in_upgrade', status: 'open', amount_paid: 0 });
  const access = await resolveEntitlement(f.env, TEST_USER);
  assert.equal(access.active, true); assert.equal(access.plan, 'builder');
});

test('invoice, line and invoice-payment pagination cannot hide paid proof', async t => {
  const f = await billingFixture(t);
  const original = paidInvoice();
  f.state.override = url => {
    if (url.pathname === '/v1/invoices') {
      if (!url.searchParams.has('starting_after')) return Response.json({ data: [{ ...original, id: 'in_old', amount_paid: 0 }], has_more: true });
      assert.equal(url.searchParams.get('starting_after'), 'in_old');
      return Response.json({ data: [{ ...original, lines: { data: [{ ...original.lines.data[0], id: 'il_old', amount: -500 }], has_more: true } }], has_more: false });
    }
    if (url.pathname === '/v1/invoices/in_paid/lines') {
      assert.equal(url.searchParams.get('starting_after'), 'il_old');
      return Response.json({ data: original.lines.data, has_more: false });
    }
    if (url.pathname === '/v1/invoice_payments' && !url.searchParams.has('starting_after')) return Response.json({ data: [{ ...f.state.payments[0], id: 'inpay_bad', status: 'open' }], has_more: true });
    return undefined;
  };
  assert.equal((await resolveEntitlement(f.env, TEST_USER)).active, true);
});

test('legacy paid charge invoice payments are verified as successful unrefunded charges', async t => {
  const f = await billingFixture(t); f.state.payments[0].payment.type = 'charge'; f.state.payments[0].payment.charge = 'ch_paid';
  assert.equal((await resolveEntitlement(f.env, TEST_USER)).active, true);
  f.state.intent.latest_charge.captured = false;
  assert.equal((await resolveEntitlement(f.env, TEST_USER)).active, false);
});

test('payment failures never overwrite stored billing state or return a cached entitlement', async t => {
  const f = await billingFixture(t);
  f.sqlite.prepare("UPDATE pro_billing SET plan='scale', subscription_status='active'").run();
  f.state.override = url => url.pathname === '/v1/invoice_payments' ? new Response('offline', { status: 503 }) : undefined;
  t.mock.method(console, 'error', () => {});
  await assert.rejects(resolveEntitlement(f.env, TEST_USER), /billing_unavailable/);
  assert.equal((f.sqlite.prepare('SELECT plan FROM pro_billing').get() as any).plan, 'scale');
});

test('checkedAt records lookup start even when Stripe returns much later', async t => {
  const f = await billingFixture(t);
  const initial = Date.now();
  let delay = 0;
  t.mock.method(Date, 'now', () => initial + delay);
  f.state.override = () => { delay = 1000; return undefined; };
  const result = await resolveEntitlement(f.env, TEST_USER);
  assert.equal(result.checkedAt, initial); assert.equal(Date.now(), initial + 1000);
});

test('discounted zero invoices still require a settled total and current matching plan coverage', async t => {
  const f = await billingFixture(t);
  const discounted = () => ({ ...paidInvoice(), amount_paid: 0, amount_due: 0, total: 0,
    total_discount_amounts: [{ amount: 500 }] });
  for (const patch of [
    { status: 'open' }, { paid_out_of_band: true }, { amount_due: 1 }, { total: 1 },
    { subtotal: 0 }, { total_discount_amounts: [] }, { total_discount_amounts: [{ amount: 499 }] },
    { total_discount_amounts: [{ amount: 501 }, { amount: -1 }] },
  ]) {
    f.state.invoices = [Object.assign(discounted(), patch)];
    assert.equal((await resolveEntitlement(f.env, TEST_USER)).active, false);
  }
  f.state.invoices = [discounted()];
  f.state.invoices[0].lines.data[0].parent.subscription_item_details.subscription = 'sub_other';
  assert.equal((await resolveEntitlement(f.env, TEST_USER)).active, false);
  f.state.invoices = [discounted()];
  const periodEnd = f.state.invoices[0].lines.data[0].period.end;
  assert.equal((await resolveEntitlement(f.env, TEST_USER)).active, true);
  // Once the discount's period expires, an unpaid renewal cannot extend access.
  t.mock.method(Date, 'now', () => (periodEnd + 1) * 1000);
  f.state.subscriptions[0].items.data[0].current_period_end = periodEnd + 86400;
  f.state.invoices.unshift({ ...paidInvoice(), status: 'open', amount_paid: 0 });
  assert.equal((await resolveEntitlement(f.env, TEST_USER)).active, false);
});
