import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from './router';
import { handlePrepaidBillingRequest } from './prepaid-billing';
import { billingFixture, billingRequest, TEST_CUSTOMER, TEST_USER } from './billing-test-helpers';
import { handleSubscriptionWebhook } from './subscription-webhook';
import { handleSubscriptionRequest } from './subscription';
import { ensurePrepaidAccount, prepaidRecharge, type PrepaidBalance, type Funding } from '../lib/prepaid-billing';
import { resolveEntitlement } from '../lib/entitlements';
import { ContainerAccountController } from '../../containers/container-account-core.js';

const requestId = 'a623dbd1-6341-4402-98ec-2657d8d479fa';
const blankBalance = (): PrepaidBalance => ({ balanceCents: 0, availableBalanceCents: 0, reservedBalanceCents: 0, currency: 'usd',
  spendLimitCents: 100000, monthlyUsageCents: 0, productionHourlyCents: 0, fundedRuntimeMs: null, minimumProductionRuntimeMs: 86400000,
  autoRecharge: { enabled: false, amountCents: 2000, monthlyLimitCents: 10000, spentCents: 0, status: 'disabled' } });

async function fixture(t: test.TestContext, owned = true) {
  const f = await billingFixture(t, 'usage', false);
  f.env.STRIPE_PREPAID_PRICE_ID = 'price_prepaid';
  if (owned) {
    f.sqlite.prepare('INSERT INTO prepaid_accounts (user_id,stripe_customer_id,created_at) VALUES (?,?,?)').run(TEST_USER, TEST_CUSTOMER, Date.now());
    f.sqlite.prepare('INSERT INTO prepaid_topups (request_id,user_id,stripe_customer_id,amount_cents,checkout_session_id,created_at) VALUES (?,?,?,?,?,?)')
      .run(requestId, TEST_USER, TEST_CUSTOMER, 2000, 'cs_prepaid', Date.now());
  }
  const balance = blankBalance();
  const funding = new Map<string, Funding>();
  const accountCalls: { path: string; body: any }[] = [];
  f.env.CONTAINER_ACCOUNT = { idFromName: (name: string) => name, get: (name: string) => ({ async fetch(request: Request) {
    assert.equal(name, `account:${TEST_USER}`); assert.equal(request.headers.get('x-mainbrella-user'), TEST_USER);
    const path = new URL(request.url).pathname;
    const body = request.method === 'POST' ? await request.json() as any : null;
    accountCalls.push({ path, body });
    if (path === '/billing/funding') funding.set(body.id, body);
    if (path === '/billing/settings') {
      if (body.spendLimitCents !== undefined) balance.spendLimitCents = body.spendLimitCents;
      if (body.autoRecharge) Object.assign(balance.autoRecharge, body.autoRecharge);
    }
    balance.balanceCents = [...funding.values()].reduce((sum, item) => sum + (item.disputed ? 0 : item.amountCents - item.refundedCents), 0);
    balance.availableBalanceCents = balance.balanceCents;
    return Response.json({ balance });
  } }) } as any;
  const intent = { id: 'pi_prepaid', customer: TEST_CUSTOMER, status: 'succeeded', currency: 'usd', amount: 2000, amount_received: 2000,
    created: Math.floor(Date.now() / 1000), payment_method: 'pm_card', metadata: { mainbrella_user_id: TEST_USER, mainbrella_kind: 'prepaid_topup', mainbrella_request_id: requestId },
    latest_charge: { id: 'ch_prepaid', customer: TEST_CUSTOMER, payment_intent: 'pi_prepaid', paid: true, captured: true, status: 'succeeded',
      amount: 2000, currency: 'usd', amount_refunded: 0, refunded: false, disputed: false, payment_method_details: { type: 'card' } } };
  const checkout = { id: 'cs_prepaid', url: 'https://checkout.stripe.com/c/pay/prepaid', mode: 'payment', status: 'complete', payment_status: 'paid', currency: 'usd',
    amount_total: 2000, customer: TEST_CUSTOMER, client_reference_id: TEST_USER, payment_intent: 'pi_prepaid', metadata: { mainbrella_request_id: requestId } };
  let rechargeIntent: any = null; let createRechargeStatus = 'succeeded';
  const price = { id: 'price_prepaid', active: true, type: 'one_time', currency: 'usd', unit_amount: 500, recurring: null as unknown, product: { id: 'prod_prepaid', active: true } };
  f.state.override = (url, init) => {
    if (url.pathname === '/v1/customers/search') return Response.json({ data: [], has_more: false });
    if (url.pathname === '/v1/prices/price_prepaid') return Response.json(price);
    if (url.pathname === '/v1/checkout/sessions/cs_prepaid') return Response.json(checkout);
    if (url.pathname === '/v1/payment_intents/pi_prepaid') return Response.json(intent);
    if (url.pathname === '/v1/payment_methods/pm_card') return Response.json({ id: 'pm_card', customer: TEST_CUSTOMER, type: 'card' });
    if (url.pathname === '/v1/charges/ch_prepaid') return Response.json(intent.latest_charge);
    if (url.pathname === '/v1/checkout/sessions' && init?.method === 'GET') return Response.json({ data: [], has_more: false });
    if (url.pathname === '/v1/checkout/sessions' && init?.method === 'POST') {
      const params = new URLSearchParams(String(init.body));
      return Response.json({ ...checkout, status: 'open', amount_total: params.has('line_items[0][price]') ? 500 : Number(params.get('line_items[0][price_data][unit_amount]')), metadata: { mainbrella_request_id: params.get('metadata[mainbrella_request_id]') } });
    }
    if (url.pathname === '/v1/payment_intents' && init?.method === 'GET') return Response.json({ data: rechargeIntent ? [rechargeIntent] : [], has_more: false });
    if (url.pathname === '/v1/payment_intents' && init?.method === 'POST') {
      const params = new URLSearchParams(String(init.body));
      rechargeIntent = { ...intent, id: 'pi_recharge', status: createRechargeStatus,
        amount: Number(params.get('amount')), amount_received: Number(params.get('amount')),
        metadata: { mainbrella_user_id: TEST_USER, mainbrella_kind: 'prepaid_recharge', mainbrella_recharge_id: params.get('metadata[mainbrella_recharge_id]') },
        latest_charge: { ...intent.latest_charge, payment_intent: 'pi_recharge', amount: Number(params.get('amount')) } };
      return Response.json(rechargeIntent);
    }
    if (url.pathname === '/v1/payment_intents/pi_recharge') return Response.json(rechargeIntent);
    if (url.pathname === '/v1/payment_intents/pi_recharge/cancel') { rechargeIntent.status = 'canceled'; return Response.json(rechargeIntent); }
    return undefined;
  };
  return { ...f, balance, funding, accountCalls, intent, checkout, price,
    setRechargeStatus(value: string) { createRechargeStatus = value; if (rechargeIntent) rechargeIntent.status = value; } };
}
async function webhook(type: string, object: unknown, id: string) {
  const body = JSON.stringify({ id, type, data: { object } }); const timestamp = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('whsec_test'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`)));
  return new Request('https://api.mainbrella.com/subscription/webhook', { method: 'POST', body,
    headers: { 'Stripe-Signature': `t=${timestamp},v1=${Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')}` } });
}

test('prepaid billing is routed, uses cookies, and requires trusted origins for mutation', async t => {
  const f = await fixture(t);
  const response = await handleRequest(billingRequest('/billing/config'), f.env);
  assert.deepEqual(await response.json(), { configured: true, minTopupCents: 500, maxTopupCents: 100000 });
  assert.equal((await handleRequest(billingRequest('/billing/balance'), f.env)).status, 200);
  assert.equal((await handlePrepaidBillingRequest(billingRequest('/billing/balance', undefined, false), f.env)).status, 401);
  assert.equal((await handlePrepaidBillingRequest(new Request('https://api.mainbrella.com/billing/balance', { headers: { Authorization: 'Bearer browser_token' } }), f.env)).status, 401);
  assert.equal((await handlePrepaidBillingRequest(billingRequest('/billing/topups', { amountCents: 2000, requestId }, true, null), f.env)).status, 403);
  assert.equal((await handlePrepaidBillingRequest(billingRequest('/billing/settings', {}, true, 'https://attacker.example'), f.env)).status, 403);
  assert.equal(f.calls.length, 0);
});

test('topups create payment Checkout with a single Product, validated amount and immutable request identity', async t => {
  const f = await fixture(t);
  f.sqlite.prepare('DELETE FROM prepaid_topups').run();
  const response = await handlePrepaidBillingRequest(billingRequest('/billing/topups', { amountCents: 2000, requestId }), f.env);
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { url: f.checkout.url, sessionId: 'cs_prepaid' });
  const write = f.calls.find(call => call.url.pathname === '/v1/checkout/sessions' && call.init?.method === 'POST')!;
  assert.equal(write.params.get('mode'), 'payment'); assert.equal(write.params.get('line_items[0][price_data][product]'), 'prod_prepaid');
  assert.equal(write.params.get('line_items[0][price_data][unit_amount]'), '2000');
  assert.equal(write.params.get('payment_intent_data[metadata][mainbrella_kind]'), 'prepaid_topup');
  assert.equal(write.params.has('payment_intent_data[setup_future_usage]'), false);
  assert.equal(f.funding.size, 0);
  assert.equal((await handlePrepaidBillingRequest(billingRequest('/billing/topups', { amountCents: 5000, requestId }), f.env)).status, 409);
  for (const amountCents of [499, 100001, 500.5, '2000']) assert.equal((await handlePrepaidBillingRequest(billingRequest('/billing/topups', { amountCents, requestId: crypto.randomUUID() }), f.env)).status, 400);
});

test('first prepaid purchase persists customer ownership without creating a subscription', async t => {
  const f = await fixture(t, false);
  const response = await handlePrepaidBillingRequest(billingRequest('/billing/topups', { amountCents: 2000, requestId }), f.env);
  assert.equal(response.status, 200);
  assert.equal((f.sqlite.prepare('SELECT stripe_customer_id FROM prepaid_accounts WHERE user_id = ?').get(TEST_USER) as any).stripe_customer_id, TEST_CUSTOMER);
  assert.equal((f.sqlite.prepare('SELECT count(*) AS n FROM pro_billing').get() as any).n, 0);
  assert.equal(f.calls.filter(call => call.url.pathname === '/v1/customers' && call.init?.method === 'POST').length, 1);
  assert.equal(f.calls.some(call => call.url.pathname === '/v1/subscriptions'), false);
  assert.equal(f.funding.size, 0);
});

test('lost Checkout response is recovered by persisted request metadata without a second purchase', async t => {
  const f = await fixture(t);
  f.sqlite.prepare('UPDATE prepaid_topups SET checkout_session_id=NULL,created_at=?').run(Date.now() - 48 * 3600000);
  const previous = f.state.override!;
  f.state.override = (url, init) => url.pathname === '/v1/checkout/sessions' && init?.method === 'GET'
    ? Response.json({ data: [{ ...f.checkout, status: 'open' }], has_more: false }) : previous(url, init);
  assert.equal((await handlePrepaidBillingRequest(billingRequest('/billing/topups', { amountCents: 2000, requestId }), f.env)).status, 200);
  assert.equal((f.sqlite.prepare('SELECT checkout_session_id FROM prepaid_topups').get() as any).checkout_session_id, 'cs_prepaid');
  assert.equal(f.calls.some(call => call.url.pathname === '/v1/checkout/sessions' && call.init?.method === 'POST'), false);
});

test('an old customer creation with an unknown outcome requires reconciliation instead of creating another customer', async t => {
  const f = await fixture(t, false);
  f.sqlite.prepare('INSERT INTO prepaid_customer_requests (user_id,created_at) VALUES (?,?)').run(TEST_USER, Date.now() - 48 * 3600000);
  await assert.rejects(ensurePrepaidAccount(f.env, { id: TEST_USER, name: 'Test', email: 'test@example.com' }), /billing_reconciliation_required/);
  assert.equal(f.calls.some(call => call.url.pathname === '/v1/customers' && call.init?.method === 'POST'), false);
});

test('completion and different signed success events converge on one verified payment identity', async t => {
  const f = await fixture(t);
  assert.equal((await handlePrepaidBillingRequest(billingRequest('/billing/topups/complete', { sessionId: 'cs_prepaid' }), f.env)).status, 200);
  for (const [type, id] of [['checkout.session.completed', 'evt_checkout'], ['payment_intent.succeeded', 'evt_intent']] as const) {
    assert.equal((await handleSubscriptionWebhook(await webhook(type, type.startsWith('checkout') ? { id: 'cs_prepaid', customer: TEST_CUSTOMER } : { id: 'pi_prepaid', customer: TEST_CUSTOMER }, id), f.env)).status, 200);
  }
  assert.equal(f.funding.size, 1); assert.equal(f.balance.balanceCents, 2000);
  assert.ok(f.accountCalls.filter(call => call.path === '/billing/funding').every(call => call.body.id === 'pi_prepaid'));
  const calls = f.calls.length;
  assert.equal((await handleSubscriptionWebhook(await webhook('payment_intent.succeeded', { id: 'pi_prepaid', customer: TEST_CUSTOMER }, 'evt_intent'), f.env)).status, 200);
  assert.equal(f.calls.length, calls);
  assert.equal((await resolveEntitlement(f.env, TEST_USER)).billing?.kind, 'prepaid');
  assert.equal(f.calls.some(call => call.url.pathname === '/v1/subscriptions'), false);
});

test('a completed client redirect or pending payment cannot fund compute', async t => {
  const f = await fixture(t); f.intent.status = 'processing';
  assert.equal((await handlePrepaidBillingRequest(billingRequest('/billing/topups/complete', { sessionId: 'cs_prepaid' }), f.env)).status, 409);
  assert.equal(f.funding.size, 0); assert.equal((await resolveEntitlement(f.env, TEST_USER)).active, false);
  assert.equal((await handleSubscriptionWebhook(await webhook('payment_intent.processing', { id: 'pi_prepaid', customer: TEST_CUSTOMER }, 'evt_pending'), f.env)).status, 200);
  assert.equal(f.funding.size, 0);
});

test('completion rejects a foreign Checkout, foreign payment, uncaptured card and altered currency or amount', async t => {
  const f = await fixture(t); t.mock.method(console, 'error', () => {});
  f.checkout.client_reference_id = 'other';
  assert.equal((await handlePrepaidBillingRequest(billingRequest('/billing/topups/complete', { sessionId: 'cs_prepaid' }), f.env)).status, 403);
  f.checkout.client_reference_id = TEST_USER; f.intent.customer = 'cus_other';
  assert.equal((await handlePrepaidBillingRequest(billingRequest('/billing/topups/complete', { sessionId: 'cs_prepaid' }), f.env)).status, 403);
  f.intent.customer = TEST_CUSTOMER;
  for (const mutate of [() => { f.intent.latest_charge.captured = false; }, () => { f.intent.currency = 'eur'; }, () => { f.intent.amount_received = 500; }]) {
    f.intent.latest_charge.captured = true; f.intent.currency = 'usd'; f.intent.amount_received = 2000; mutate();
    assert.equal((await handlePrepaidBillingRequest(billingRequest('/billing/topups/complete', { sessionId: 'cs_prepaid' }), f.env)).status, 503);
  }
  assert.equal(f.funding.size, 0);
});

test('refund and dispute events replace payment funding using live charge state and never double credit', async t => {
  const f = await fixture(t);
  await handlePrepaidBillingRequest(billingRequest('/billing/topups/complete', { sessionId: 'cs_prepaid' }), f.env);
  f.intent.latest_charge.amount_refunded = 1000;
  assert.equal((await handleSubscriptionWebhook(await webhook('charge.refunded', { id: 'ch_prepaid', customer: TEST_CUSTOMER }, 'evt_partial_refund'), f.env)).status, 200);
  assert.equal(f.balance.balanceCents, 1000);
  assert.equal((await handleSubscriptionWebhook(await webhook('payment_intent.succeeded', { id: 'pi_prepaid', customer: TEST_CUSTOMER }, 'evt_late_success'), f.env)).status, 200);
  assert.equal(f.balance.balanceCents, 1000);
  f.intent.latest_charge.disputed = true;
  assert.equal((await handleSubscriptionWebhook(await webhook('charge.dispute.created', { charge: 'ch_prepaid' }, 'evt_dispute_prepaid'), f.env)).status, 200);
  assert.equal(f.balance.balanceCents, 0); assert.equal((await resolveEntitlement(f.env, TEST_USER)).active, false);
});

test('verified large purchases cannot grant client-invented credit and refunds remove the paid cents', async t => {
  const f = await fixture(t);
  f.sqlite.prepare('UPDATE prepaid_topups SET amount_cents=99900').run();
  f.checkout.amount_total = 99900; f.intent.amount = 99900; f.intent.amount_received = 99900; f.intent.latest_charge.amount = 99900;
  const response = await handlePrepaidBillingRequest(billingRequest('/billing/topups/complete', { sessionId: 'cs_prepaid', creditCents: 999999999 }), f.env);
  assert.equal(response.status, 200); assert.equal(f.balance.balanceCents, 99900);
  assert.equal(f.funding.get('pi_prepaid')?.amountCents, 99900); assert.equal(Object.hasOwn(f.funding.get('pi_prepaid')!, 'creditCents'), false);
  f.intent.latest_charge.amount_refunded = 33300;
  assert.equal((await handleSubscriptionWebhook(await webhook('charge.refunded', { id: 'ch_prepaid', customer: TEST_CUSTOMER }, 'evt_large_refund'), f.env)).status, 200);
  assert.equal(f.balance.balanceCents, 66600);
  f.intent.latest_charge.amount_refunded = 99900; f.intent.latest_charge.refunded = true;
  assert.equal((await handleSubscriptionWebhook(await webhook('charge.refunded', { id: 'ch_prepaid', customer: TEST_CUSTOMER }, 'evt_large_full_refund'), f.env)).status, 200);
  assert.equal(f.balance.balanceCents, 0);
});

test('unconfigured purchase writes fail without Stripe calls and invalid settings are rejected', async t => {
  const f = await fixture(t);
  assert.equal((await handlePrepaidBillingRequest(billingRequest('/billing/settings', { autoRecharge: { enabled: true, amountCents: 2000, monthlyLimitCents: 500 } }), f.env)).status, 400);
  assert.equal((await handlePrepaidBillingRequest(billingRequest('/billing/settings', { balanceCents: 999999 }), f.env)).status, 400);
  assert.equal((await handlePrepaidBillingRequest(billingRequest('/billing/topups', { amountCents: 2000, requestId }), { ...f.env, STRIPE_PREPAID_PRICE_ID: undefined })).status, 503);
  assert.equal(f.calls.length, 0);
});

test('the $5 purchase uses the configured one-time reference Price', async t => {
  const f = await fixture(t); f.sqlite.prepare('DELETE FROM prepaid_topups').run();
  assert.equal((await handlePrepaidBillingRequest(billingRequest('/billing/topups', { amountCents: 500, requestId }), f.env)).status, 200);
  const write = f.calls.find(call => call.url.pathname === '/v1/checkout/sessions' && call.init?.method === 'POST')!;
  assert.equal(write.params.get('line_items[0][price]'), 'price_prepaid');
  assert.equal(write.params.has('line_items[0][price_data][product]'), false);
});

test('recurring, inactive, foreign-currency and non-$5 reference prices cannot create prepaid Checkout', async t => {
  const f = await fixture(t); f.sqlite.prepare('DELETE FROM prepaid_topups').run(); t.mock.method(console, 'error', () => {});
  const original = structuredClone(f.price);
  for (const mutate of [() => { f.price.type = 'recurring'; f.price.recurring = { interval: 'month' }; }, () => { f.price.active = false; },
    () => { f.price.currency = 'eur'; }, () => { f.price.unit_amount = 1000; }, () => { f.price.product.active = false; }]) {
    Object.assign(f.price, structuredClone(original)); mutate();
    assert.equal((await handlePrepaidBillingRequest(billingRequest('/billing/topups', { amountCents: 2000, requestId }), f.env)).status, 503);
  }
  assert.equal(f.calls.some(call => call.url.pathname === '/v1/checkout/sessions' && call.init?.method === 'POST'), false);
});

test('expired Checkout returns topup_expired and cannot fund compute', async t => {
  const f = await fixture(t); f.checkout.status = 'expired';
  const response = await handlePrepaidBillingRequest(billingRequest('/billing/topups/complete', { sessionId: 'cs_prepaid' }), f.env);
  assert.equal(response.status, 409); assert.deepEqual(await response.json(), { error: 'topup_expired' });
  assert.equal(f.funding.size, 0);
});

test('prepaid configuration disables new recurring purchases and plan changes while preserving legacy reads and cancellation', async t => {
  const f = await billingFixture(t); f.env.STRIPE_PREPAID_PRICE_ID = 'price_prepaid';
  for (const [path, body] of [['/subscription/checkout', { plan: 'usage' }], ['/subscription/change', { plan: 'usage', confirm: true }],
    ['/subscription/resume', {}], ['/subscription/portal', { plan: 'pro' }], ['/subscription/usage', { spendLimitCents: 5000, authorizeOverages: true }]] as const) {
    const response = await handleSubscriptionRequest(billingRequest(path, body), f.env);
    assert.equal(response.status, 409); assert.deepEqual(await response.json(), { error: 'prepaid_billing_required' });
  }
  assert.equal(f.calls.length, 0);
  assert.equal((await handleSubscriptionRequest(billingRequest('/subscription'), f.env)).status, 200);
  assert.equal((await handleSubscriptionRequest(billingRequest('/subscription/cancel', { confirm: true }), f.env)).status, 200);
  assert.equal(f.state.subscriptions[0].cancel_at_period_end, true);
});

test('creating a prepaid wallet never hides an existing monthly subscription from cancellation', async t => {
  const f = await fixture(t);
  f.sqlite.prepare('INSERT INTO pro_billing (user_id,stripe_customer_id,checkout_session_id) VALUES (?,?,?)').run(TEST_USER, TEST_CUSTOMER, 'cs_old');
  const response = await handleSubscriptionRequest(billingRequest('/subscription/cancel', { confirm: true }), f.env);
  assert.equal(response.status, 200); assert.equal(f.state.subscriptions[0].cancel_at_period_end, true);
  const body = await response.json() as any;
  assert.equal(body.subscription.id, 'sub_paid'); assert.equal(body.active, false);
  const calls = f.calls.length;
  assert.equal((await resolveEntitlement(f.env, TEST_USER)).active, false);
  assert.equal(f.calls.length, calls); // Compute entitlement never contacts Stripe.
});

test('a successful topup saves no automatic payment method until settings grants consent', async t => {
  const f = await fixture(t);
  await handlePrepaidBillingRequest(billingRequest('/billing/topups/complete', { sessionId: 'cs_prepaid' }), f.env);
  assert.equal((f.sqlite.prepare('SELECT payment_method_id FROM prepaid_accounts').get() as any).payment_method_id, null);
  const response = await handlePrepaidBillingRequest(billingRequest('/billing/settings', { autoRecharge: { enabled: true, amountCents: 2000, monthlyLimitCents: 10000 } }), f.env);
  assert.equal(response.status, 200);
  assert.equal((f.sqlite.prepare('SELECT payment_method_id FROM prepaid_accounts').get() as any).payment_method_id, 'pm_card');
  assert.equal(f.calls.some(call => call.url.pathname === '/v1/payment_intents' && call.init?.method === 'POST'), false);
});

test('enabling automatic recharge before a topup collects an off-session ready card without charging immediately', async t => {
  const f = await fixture(t); f.sqlite.prepare('DELETE FROM prepaid_topups').run();
  assert.equal((await handlePrepaidBillingRequest(billingRequest('/billing/settings', { autoRecharge: { enabled: true, amountCents: 2000, monthlyLimitCents: 10000 } }), f.env)).status, 200);
  assert.equal((await handlePrepaidBillingRequest(billingRequest('/billing/topups', { amountCents: 2000, requestId }), f.env)).status, 200);
  const write = f.calls.find(call => call.url.pathname === '/v1/checkout/sessions' && call.init?.method === 'POST')!;
  assert.equal(write.params.get('payment_intent_data[setup_future_usage]'), 'off_session');
  assert.equal(f.funding.size, 0);
});

test('a fresh account can save the spending cap before its first purchase', async t => {
  const f = await fixture(t, false);
  const response = await handlePrepaidBillingRequest(billingRequest('/billing/settings', { spendLimitCents: 5000 }), f.env);
  assert.equal(response.status, 200);
  const write = f.accountCalls.find(call => call.path === '/billing/settings')!;
  assert.equal(write.body.customerId, TEST_CUSTOMER);
  assert.equal(f.balance.spendLimitCents, 5000); assert.equal(f.balance.balanceCents, 0);
});

test('automatic recharge recovers a retained payment and never duplicates a charge after an old HTTP key', async t => {
  const f = await fixture(t); f.sqlite.prepare('UPDATE prepaid_accounts SET payment_method_id = ?').run('pm_card');
  const entry = { identifier: 'mainbrella-recharge-unique', customerId: TEST_CUSTOMER, amountCents: 2000, createdAt: Date.now() };
  const first = await prepaidRecharge(f.env, entry); assert.equal(first.status, 'succeeded'); assert.equal(first.funding?.amountCents, 2000);
  const recovered = await prepaidRecharge(f.env, { ...entry, createdAt: Date.now() - 48 * 3600000 });
  assert.equal(recovered.paymentIntentId, first.paymentIntentId);
  const retained = await prepaidRecharge(f.env, { ...entry, paymentIntentId: first.paymentIntentId, createdAt: Date.now() - 48 * 3600000 });
  assert.equal(retained.status, 'succeeded');
  assert.equal(f.calls.filter(call => call.url.pathname === '/v1/payment_intents' && call.init?.method === 'POST').length, 1);
});

for (const amountCents of [18000, 100000]) {
  test(`a $${amountCents / 100} manual payment adds exactly the paid amount`, async t => {
    const f = await fixture(t);
    f.sqlite.prepare('UPDATE prepaid_topups SET amount_cents=?').run(amountCents);
    f.checkout.amount_total = amountCents; f.intent.amount = amountCents; f.intent.amount_received = amountCents; f.intent.latest_charge.amount = amountCents;
    const response = await handlePrepaidBillingRequest(billingRequest('/billing/topups/complete', { sessionId: 'cs_prepaid' }), f.env);
    assert.equal(response.status, 200); assert.equal(f.balance.balanceCents, amountCents);
    assert.equal(f.funding.get('pi_prepaid')?.amountCents, amountCents);
  });
  test(`a $${amountCents / 100} automatic recharge confirms exactly the paid amount`, async t => {
    const f = await fixture(t); f.sqlite.prepare('UPDATE prepaid_accounts SET payment_method_id=?').run('pm_card');
    const result = await prepaidRecharge(f.env, { identifier: `mainbrella-recharge-${amountCents}`, customerId: TEST_CUSTOMER, amountCents, createdAt: Date.now() });
    assert.equal(result.status, 'succeeded'); assert.equal(result.funding?.amountCents, amountCents);
    assert.equal(Object.hasOwn(result.funding!, 'creditCents'), false);
  });
}

test('the real account ledger gives 36 and 200 separate $5 payments the same value as $180 and $1,000', async () => {
  for (const count of [36, 200]) {
    const stored = new Map<string, any>();
    const storage = { async get(key: string) { return structuredClone(stored.get(key)); }, async put(key: string, value: unknown) { stored.set(key, structuredClone(value)); },
      async getAlarm() { return null; }, async setAlarm() {}, async deleteAlarm() {} };
    const controller = new ContainerAccountController({ storage } as any, () => { throw new Error('funding_must_not_allocate_compute'); });
    const fundingRequest = (index: number) => new Request('https://internal/billing/funding', { method: 'POST', headers: { 'x-mainbrella-user': TEST_USER },
      body: JSON.stringify({ id: `pi_deposit_${index}`, customerId: TEST_CUSTOMER, amountCents: 500, refundedCents: 0, disputed: false, createdAt: 1800000000000, kind: 'topup' }) });
    for (let index = 0; index < count; index++) assert.equal((await controller.fetch(fundingRequest(index))).status, 200);
    const response = await controller.fetch(fundingRequest(0)); // Payment replay.
    assert.equal(response.status, 200);
    const { balance } = await response.json() as { balance: PrepaidBalance };
    assert.equal(balance.balanceCents, count * 500); assert.equal(balance.availableBalanceCents, count * 500);
    assert.equal(balance.reservedBalanceCents, 0);
  }
});

test('processing and failed automatic recharges add no funding, and an old unknown attempt fails closed', async t => {
  const f = await fixture(t); f.sqlite.prepare('UPDATE prepaid_accounts SET payment_method_id = ?').run('pm_card');
  f.setRechargeStatus('processing');
  const entry = { identifier: 'mainbrella-recharge-unique', customerId: TEST_CUSTOMER, amountCents: 2000, createdAt: Date.now() };
  assert.deepEqual(await prepaidRecharge(f.env, entry), { status: 'processing', paymentIntentId: 'pi_recharge' });
  f.setRechargeStatus('requires_payment_method');
  assert.deepEqual(await prepaidRecharge(f.env, entry), { status: 'failed', paymentIntentId: 'pi_recharge' });
  assert.equal(f.calls.filter(call => call.url.pathname === '/v1/payment_intents/pi_recharge/cancel').length, 1);
  await assert.rejects(prepaidRecharge(f.env, { ...entry, identifier: 'unknown', createdAt: Date.now() - 24 * 3600000 }), /billing_reconciliation_required/);
  assert.equal(f.calls.filter(call => call.url.pathname === '/v1/payment_intents' && call.init?.method === 'POST').length, 1);
});

test('an actionable off-session payment is canceled before its monthly authorization can be released', async t => {
  const f = await fixture(t); f.sqlite.prepare('UPDATE prepaid_accounts SET payment_method_id=?').run('pm_card');
  f.setRechargeStatus('requires_action');
  const result = await prepaidRecharge(f.env, { identifier: 'mainbrella-recharge-auth', customerId: TEST_CUSTOMER, amountCents: 2000, createdAt: Date.now() });
  assert.deepEqual(result, { status: 'failed', paymentIntentId: 'pi_recharge' });
  assert.equal(f.calls.filter(call => call.url.pathname === '/v1/payment_intents/pi_recharge/cancel').length, 1);
  assert.equal(f.funding.size, 0);
});

test('a payment that succeeds during cancellation is funded by live proof without a second charge', async t => {
  const f = await fixture(t); f.sqlite.prepare('UPDATE prepaid_accounts SET payment_method_id=?').run('pm_card');
  f.setRechargeStatus('requires_action'); t.mock.method(console, 'error', () => {});
  const previous = f.state.override!;
  f.state.override = (url, init) => {
    if (url.pathname === '/v1/payment_intents/pi_recharge/cancel') { f.setRechargeStatus('succeeded'); return Response.json({ error: {} }, { status: 400 }); }
    return previous(url, init);
  };
  const result = await prepaidRecharge(f.env, { identifier: 'mainbrella-recharge-race', customerId: TEST_CUSTOMER, amountCents: 2000, createdAt: Date.now() });
  assert.equal(result.status, 'succeeded'); assert.equal(result.funding?.id, 'pi_recharge');
  assert.equal(f.calls.filter(call => call.url.pathname === '/v1/payment_intents' && call.init?.method === 'POST').length, 1);
});

test('failed cancellation retains an unknown payment instead of declaring its authorization released', async t => {
  const f = await fixture(t); f.sqlite.prepare('UPDATE prepaid_accounts SET payment_method_id=?').run('pm_card');
  f.setRechargeStatus('requires_action'); t.mock.method(console, 'error', () => {});
  const previous = f.state.override!;
  f.state.override = (url, init) => url.pathname === '/v1/payment_intents/pi_recharge/cancel' ? new Response('unavailable', { status: 503 }) : previous(url, init);
  await assert.rejects(prepaidRecharge(f.env, { identifier: 'mainbrella-recharge-cancel', customerId: TEST_CUSTOMER, amountCents: 2000, createdAt: Date.now() }), /billing_reconciliation_required/);
  assert.equal(f.funding.size, 0);
});
