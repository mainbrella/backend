import test from 'node:test';
import assert from 'node:assert/strict';
import { handleSubscriptionRequest } from './subscription';
import { PLAN_PRICES, billingSubscription, subscriptionPlan, type Plan, type BillingEnv } from '../lib/stripe';
import { billingFixture, billingRequest, paidSubscription, TEST_USAGE_PRICE, TEST_CUSTOMER, TEST_USER } from './billing-test-helpers';

const post = (path: string, body: unknown = {}) => billingRequest(path, body);

test('every account billing operation requires authentication, including checkout and completion', async t => {
  const f = await billingFixture(t);
  for (const [path, body] of [['/subscription', undefined], ['/subscription/checkout', { plan: 'pro' }], ['/subscription/complete', { session_id: 'cs_old', client_secret: 'anything' }],
    ['/subscription/portal', {}], ['/subscription/change', { plan: 'builder', confirm: true }], ['/subscription/cancel', { confirm: true }], ['/subscription/resume', {}]] as const) {
    assert.equal((await handleSubscriptionRequest(billingRequest(path, body, false), f.env)).status, 401);
  }
  assert.equal(f.calls.length, 0);
});

test('billing mutations reject missing/untrusted origins, unsupported methods and malformed plans before Stripe', async t => {
  const f = await billingFixture(t);
  for (const origin of [null, 'https://untrusted.example']) assert.equal((await handleSubscriptionRequest(billingRequest('/subscription/checkout', { plan: 'pro' }, true, origin), f.env)).status, 403);
  assert.equal((await handleSubscriptionRequest(billingRequest('/subscription/checkout'), f.env)).status, 405);
  for (const body of [{}, { plan: 'toString' }, { plan: '__proto__' }, { plan: 'enterprise' }, { plan: 1 }, { price_id: PLAN_PRICES.pro }]) {
    assert.equal((await handleSubscriptionRequest(post('/subscription/checkout', body), f.env)).status, 400);
  }
  assert.equal(f.calls.length, 0);
});

test('configuration publishes the authoritative plan policy without requiring authentication', async t => {
  const f = await billingFixture(t);
  const response = await handleSubscriptionRequest(billingRequest('/subscription/config', undefined, false), f.env);
  const body = await response.json() as any;
  assert.equal(body.plans.builder.limits.maxStartsPerMonth, 1000);
  assert.equal(body.plans.pro.limits.maxContainers, 100);
  assert.equal(body.plans.scale.limits.maxSessionMs, 72 * 3600000);
  assert.equal(body.plans.builder.price, 5);
  assert.equal(body.plans.pro.features.snapshots, false);
  assert.equal(f.calls.length, 0);
});

test('an unpaid account has no plan even when Stripe configuration is absent', async t => {
  const f = await billingFixture(t, 'builder', false);
  const response = await handleSubscriptionRequest(billingRequest(), { ...f.env, STRIPE_SECRET_KEY: undefined } as unknown as BillingEnv);
  assert.equal(response.status, 200);
  const body = await response.json() as any;
  assert.equal(body.plan, null); assert.equal(body.active, false); assert.equal(body.valid_until, null);
  assert.equal(f.calls.length, 0);
});

for (const plan of Object.keys(PLAN_PRICES) as (keyof typeof PLAN_PRICES)[]) {
  test(`legacy ${plan} plans cannot be purchased by new accounts`, async t => {
    const f = await billingFixture(t, plan, false); f.state.subscriptions = [];
    const response = await handleSubscriptionRequest(post('/subscription/checkout', { plan }), f.env);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'legacy_plan_unavailable' });
    assert.equal(f.calls.length, 0);
  });
  test(`verified ${plan} subscription is refreshed from live invoices and persisted`, async t => {
    const f = await billingFixture(t, plan);
    const response = await handleSubscriptionRequest(billingRequest(), f.env);
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(body.plan, plan); assert.equal(body.active, true);
    assert.ok(body.valid_until > Date.now());
    const record = f.sqlite.prepare('SELECT * FROM pro_billing').get() as any;
    assert.equal(record.plan, plan); assert.equal(record.subscription_status, 'active'); assert.equal(record.stripe_subscription_id, 'sub_paid');
  });
}

test('usage checkout reuses a compatible session and expires a legacy session', async t => {
  const f = await billingFixture(t, 'usage'); f.state.subscriptions = [];
  const reused = await handleSubscriptionRequest(post('/subscription/checkout', { plan: 'usage' }), f.env);
  assert.deepEqual(await reused.json(), { client_secret: 'cs_old_secret', publishable_key: 'pk_test' });
  f.state.checkout.metadata.plan = 'builder';
  const changed = await handleSubscriptionRequest(post('/subscription/checkout', { plan: 'usage' }), f.env);
  assert.equal(changed.status, 200);
  assert.ok(f.calls.some(c => c.url.pathname.endsWith('/cs_old/expire')));
  assert.equal(f.calls.at(-1)?.params.get('line_items[0][price]'), TEST_USAGE_PRICE);
});

for (const legacy of [{ ui_mode: 'embedded', allow_promotion_codes: true }, { ui_mode: 'custom', allow_promotion_codes: false },
  { payment_method_collection: 'if_required' }, { payment_method_collection: null }]) {
  test(`checkout replaces incompatible session ${JSON.stringify(legacy)}`, async t => {
    const f = await billingFixture(t, 'usage'); f.state.subscriptions = [];
    Object.assign(f.state.checkout, legacy);
    const response = await handleSubscriptionRequest(post('/subscription/checkout', { plan: 'usage' }), f.env);
    assert.equal(response.status, 200);
    assert.ok(f.calls.some(c => c.url.pathname.endsWith('/cs_old/expire')));
    assert.equal(f.calls.at(-1)?.params.get('ui_mode'), 'custom');
    assert.equal(f.calls.at(-1)?.params.get('allow_promotion_codes'), 'true');
    assert.equal(f.calls.at(-1)?.params.get('payment_method_collection'), 'always');
  });
}

test('live active, trialing, past_due, and unpaid subscriptions block duplicate purchases', async t => {
  const f = await billingFixture(t);
  for (const status of ['active', 'trialing', 'past_due', 'unpaid', 'paused', 'incomplete']) {
    f.state.subscriptions[0].status = status;
    assert.equal((await handleSubscriptionRequest(post('/subscription/checkout', { plan: 'usage' }), f.env)).status, 409);
  }
  assert.ok(f.calls.every(c => c.url.pathname === '/v1/subscriptions'));
});

test('checkout completion verifies account ownership then reconciles live payment, not the session snapshot', async t => {
  const f = await billingFixture(t);
  f.state.checkout.status = 'complete';
  f.state.checkout.client_reference_id = 'someone_else';
  assert.equal((await handleSubscriptionRequest(post('/subscription/complete', { session_id: 'cs_old' }), f.env)).status, 403);
  f.state.checkout.client_reference_id = TEST_USER;
  f.state.checkout.customer = 'cus_someone_else';
  assert.equal((await handleSubscriptionRequest(post('/subscription/complete', { session_id: 'cs_old' }), f.env)).status, 403);
  f.state.checkout.customer = TEST_CUSTOMER;
  f.state.checkout.status = 'open';
  assert.equal((await handleSubscriptionRequest(post('/subscription/complete', { session_id: 'cs_old' }), f.env)).status, 409);
  f.state.checkout.status = 'complete'; f.state.subscriptions[0].status = 'past_due';
  const response = await handleSubscriptionRequest(post('/subscription/complete', { session_id: 'cs_old' }), f.env);
  assert.equal(response.status, 200); assert.equal((await response.json() as any).active, false);
});

test('plan upgrades use hosted Stripe confirmation with invoiced prorations and locked target price', async t => {
  const f = await billingFixture(t, 'builder');
  const response = await handleSubscriptionRequest(post('/subscription/portal', { plan: 'pro' }), f.env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { url: 'https://billing.stripe.com/session_test' });
  const config = f.calls.find(c => c.url.pathname === '/v1/billing_portal/configurations')!;
  assert.equal(config.params.get('features[subscription_update][proration_behavior]'), 'always_invoice');
  assert.equal(config.params.get('features[subscription_update][default_allowed_updates][0]'), 'price');
  assert.equal(config.params.get('features[subscription_update][products][0][prices][0]'), PLAN_PRICES.pro);
  assert.equal(config.params.has('features[subscription_update][products][0][prices][1]'), false);
  const session = f.calls.at(-1)!;
  assert.equal(session.params.get('flow_data[type]'), 'subscription_update_confirm');
  assert.equal(session.params.get('flow_data[subscription_update_confirm][items][0][id]'), 'si_paid');
  assert.equal(session.params.get('flow_data[subscription_update_confirm][items][0][quantity]'), '1');
  assert.equal(f.state.subscriptions[0].items.data[0].price.id, PLAN_PRICES.builder);
});

test('payment recovery portal cannot change plan or cancel outside the app policy', async t => {
  const f = await billingFixture(t); f.state.subscriptions[0].status = 'past_due';
  assert.equal((await handleSubscriptionRequest(post('/subscription/portal'), f.env)).status, 200);
  const config = f.calls.find(c => c.url.pathname === '/v1/billing_portal/configurations')!;
  assert.equal(config.params.get('features[subscription_update][enabled]'), 'false');
  assert.equal(config.params.get('features[subscription_cancel][enabled]'), 'false');
  assert.equal((await handleSubscriptionRequest(post('/subscription/portal', { plan: 'pro' }), f.env)).status, 402);
});

test('downgrades keep the paid plan until period end and can be replaced, withdrawn, and scheduled again', async t => {
  const f = await billingFixture(t, 'scale');
  const periodEnd = f.state.subscriptions[0].items.data[0].current_period_end;
  assert.equal((await handleSubscriptionRequest(post('/subscription/change', { plan: 'pro' }), f.env)).status, 400);
  const first = await handleSubscriptionRequest(post('/subscription/change', { plan: 'pro', confirm: true }), f.env);
  assert.equal(first.status, 200);
  const body = await first.json() as any;
  assert.equal(body.plan, 'scale'); assert.equal(body.active, true); assert.equal(body.scheduled_plan, 'pro'); assert.equal(body.scheduled_change_at, periodEnd);
  const write = f.calls.find(c => c.params.has('phases[1][items][0][price]'))!;
  assert.equal(write.params.get('proration_behavior'), 'none');
  assert.equal(write.params.get('phases[0][end_date]'), String(periodEnd));
  assert.equal(write.params.get('phases[1][start_date]'), String(periodEnd));
  assert.equal(write.params.get('phases[0][items][0][price]'), PLAN_PRICES.scale);
  assert.equal(write.params.get('phases[1][items][0][price]'), PLAN_PRICES.pro);
  assert.equal(write.params.get('phases[1][iterations]'), '1');
  const second = await handleSubscriptionRequest(post('/subscription/change', { plan: 'builder', confirm: true }), f.env);
  assert.equal((await second.json() as any).scheduled_plan, 'builder');
  const withdrew = await handleSubscriptionRequest(post('/subscription/change', { plan: 'scale', confirm: true }), f.env);
  assert.equal((await withdrew.json() as any).scheduled_plan, null);
  const again = await handleSubscriptionRequest(post('/subscription/change', { plan: 'pro', confirm: true }), f.env);
  assert.equal(again.status, 200); assert.equal(f.state.schedules.size, 2);
  const creates = f.calls.filter(c => c.url.pathname === '/v1/subscription_schedules');
  assert.notEqual((creates[0].init!.headers as any)['Idempotency-Key'], (creates[1].init!.headers as any)['Idempotency-Key']);
});

test('canceling a scheduled downgrade releases phases and cancels at paid period end; resume restores renewal', async t => {
  const f = await billingFixture(t, 'pro');
  await handleSubscriptionRequest(post('/subscription/change', { plan: 'builder', confirm: true }), f.env);
  assert.equal((await handleSubscriptionRequest(post('/subscription/cancel'), f.env)).status, 400);
  const canceled = await handleSubscriptionRequest(post('/subscription/cancel', { confirm: true }), f.env);
  assert.equal(canceled.status, 200);
  const body = await canceled.json() as any;
  assert.equal(body.subscription.cancel_at_period_end, true); assert.equal(body.active, true); assert.equal(body.scheduled_plan, null);
  assert.ok(f.calls.some(c => c.url.pathname.endsWith('/release')));
  assert.ok(f.calls.every(c => !c.url.pathname.endsWith('/cancel')));
  assert.equal((await handleSubscriptionRequest(post('/subscription/portal', { plan: 'scale' }), f.env)).status, 409);
  const resumed = await handleSubscriptionRequest(post('/subscription/resume'), f.env);
  assert.equal((await resumed.json() as any).subscription.cancel_at_period_end, false);
  assert.equal((await handleSubscriptionRequest(post('/subscription/resume'), f.env)).status, 409);
});

test('an interrupted schedule conversion can be safely recovered for retry or cancellation', async t => {
  const f = await billingFixture(t, 'scale');
  t.mock.method(console, 'error', () => {});
  f.state.override = (url, init) => url.pathname.startsWith('/v1/subscription_schedules/') && init?.method === 'POST' ? new Response('failure', { status: 500 }) : undefined;
  assert.equal((await handleSubscriptionRequest(post('/subscription/change', { plan: 'builder', confirm: true }), f.env)).status, 503);
  assert.equal(f.state.schedules.size, 1); assert.equal(f.state.schedules.values().next().value!.metadata.app_user_id, undefined);
  f.state.override = null;
  assert.equal((await handleSubscriptionRequest(post('/subscription/change', { plan: 'pro', confirm: true }), f.env)).status, 200);
  assert.equal(f.state.schedules.size, 1);
  assert.equal((await handleSubscriptionRequest(post('/subscription/cancel', { confirm: true }), f.env)).status, 200);
});

test('foreign or ambiguous schedules are never changed or released', async t => {
  const f = await billingFixture(t, 'scale');
  f.state.subscriptions[0].schedule = 'sub_sched_foreign';
  f.state.schedules.set('sub_sched_foreign', { id: 'sub_sched_foreign', status: 'active', metadata: { app_user_id: 'someone_else' }, phases: [] });
  t.mock.method(console, 'error', () => {});
  assert.equal((await handleSubscriptionRequest(post('/subscription/cancel', { confirm: true }), f.env)).status, 409);
  assert.ok(f.calls.every(c => !c.url.pathname.endsWith('/release')));
});

test('competing checkout plans serialize so they cannot create duplicate subscriptions', async t => {
  const f = await billingFixture(t); f.state.subscriptions = [];
  let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  f.state.override = async url => { if (url.pathname === '/v1/subscriptions') { entered(); await pending; } return undefined; };
  const first = handleSubscriptionRequest(post('/subscription/checkout', { plan: 'usage' }), f.env);
  await started;
  const competing = await handleSubscriptionRequest(post('/subscription/checkout', { plan: 'usage' }), f.env);
  assert.equal(competing.status, 409); assert.deepEqual(await competing.json(), { error: 'billing_operation_pending' });
  release(); assert.equal((await first).status, 200);
  assert.equal(f.calls.filter(c => c.url.pathname === '/v1/checkout/sessions').length, 1);
  assert.equal((f.sqlite.prepare('SELECT count(*) AS n FROM billing_operation_locks').get() as any).n, 0);
});

test('Stripe outage preserves saved state and never authorizes cached paid access', async t => {
  const f = await billingFixture(t);
  f.sqlite.prepare("UPDATE pro_billing SET plan = 'pro', subscription_status = 'active'").run();
  f.state.override = () => new Response('outage', { status: 503 }); t.mock.method(console, 'error', () => {});
  assert.equal((await handleSubscriptionRequest(billingRequest(), f.env)).status, 503);
  assert.equal((f.sqlite.prepare('SELECT plan FROM pro_billing').get() as any).plan, 'pro');
});

test('subscription discovery paginates past ended subscriptions and rejects ambiguous live subscriptions', async t => {
  const f = await billingFixture(t);
  let page = 0;
  f.state.override = url => url.pathname === '/v1/subscriptions' ? Response.json(++page === 1 ?
    { data: [{ ...paidSubscription(), id: 'sub_old', status: 'canceled' }], has_more: true } : { data: [paidSubscription('scale')], has_more: false }) : undefined;
  assert.equal(subscriptionPlan(await billingSubscription(f.env, TEST_CUSTOMER)), 'scale'); assert.equal(page, 2);
  f.state.override = null; f.state.subscriptions.push({ ...paidSubscription('pro'), id: 'sub_second' });
  await assert.rejects(billingSubscription(f.env, TEST_CUSTOMER), /multiple_subscriptions/);
});

test('completed fully discounted checkout grants access without a card payment', async t => {
  const f = await billingFixture(t);
  f.state.checkout.status = 'complete';
  Object.assign(f.state.invoices[0], { amount_paid: 0, amount_due: 0, total: 0, total_discount_amounts: [{ amount: 500 }] });
  f.state.payments = [];
  const response = await handleSubscriptionRequest(post('/subscription/complete', { session_id: 'cs_old' }), f.env);
  assert.equal(response.status, 200);
  const body = await response.json() as any;
  assert.equal(body.active, true);
  assert.equal(body.plan, 'builder');
  assert.equal(body.valid_until, f.state.invoices[0].lines.data[0].period.end * 1000);
  assert.ok(!f.calls.some(call => call.url.pathname === '/v1/invoice_payments'));
});

const localPrices = {
  builder: 'price_1UNrymGgJdfq06ol4uXUV6Ao',
  pro: 'price_1UNs6DGgJdfq06olo5rl4TS7',
  scale: 'price_1UNs6sGgJdfq06olIK6KqNNf',
};
for (const plan of Object.keys(PLAN_PRICES) as (keyof typeof PLAN_PRICES)[]) {
  test(`local legacy ${plan} checkout is unavailable`, async t => {
    const f = await billingFixture(t, plan, false);
    f.env.LOCAL_DEV = 'true'; f.state.subscriptions = [];
    assert.equal((await handleSubscriptionRequest(post('/subscription/checkout', { plan }), f.env)).status, 409);
    assert.equal(f.calls.length, 0);
  });

  test(`local ${plan} subscription and invoices authorize paid access only in local mode`, async t => {
    const f = await billingFixture(t, plan);
    f.env.LOCAL_DEV = 'true';
    const subscription = f.state.subscriptions[0];
    subscription.items.data[0].price.id = localPrices[plan];
    f.state.invoices[0].lines.data[0].pricing.price_details.price = localPrices[plan];
    assert.equal(subscriptionPlan(subscription), null);
    const response = await handleSubscriptionRequest(billingRequest(), f.env);
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(body.plan, plan);
    assert.equal(body.active, true);
    assert.equal((f.sqlite.prepare('SELECT plan FROM pro_billing').get() as any).plan, plan);
  });
}

for (const plan of ['builder', 'pro'] as const) {
  test(`local downgrade schedules and recognizes the local ${plan} price`, async t => {
    const f = await billingFixture(t, 'scale');
    f.env.LOCAL_DEV = 'true';
    f.state.subscriptions[0].items.data[0].price.id = localPrices.scale;
    f.state.invoices[0].lines.data[0].pricing.price_details.price = localPrices.scale;
    const response = await handleSubscriptionRequest(post('/subscription/change', { plan, confirm: true }), f.env);
    assert.equal(response.status, 200);
    assert.equal((await response.json() as any).scheduled_plan, plan);
    const write = f.calls.find(c => c.params.has('phases[1][items][0][price]'))!;
    assert.equal(write.params.get('phases[1][items][0][price]'), localPrices[plan]);
  });
}

for (const plan of ['pro', 'scale'] as const) {
  test(`local upgrade portal selects the local ${plan} price`, async t => {
    const f = await billingFixture(t, 'builder');
    f.env.LOCAL_DEV = 'true';
    f.state.subscriptions[0].items.data[0].price.id = localPrices.builder;
    f.state.invoices[0].lines.data[0].pricing.price_details.price = localPrices.builder;
    const response = await handleSubscriptionRequest(post('/subscription/portal', { plan }), f.env);
    assert.equal(response.status, 200);
    assert.ok(f.calls.some(c => c.url.pathname === `/v1/prices/${localPrices[plan]}`));
    const portal = f.calls.find(c => c.url.pathname === '/v1/billing_portal/sessions')!;
    assert.equal(portal.params.get('flow_data[subscription_update_confirm][items][0][price]'), localPrices[plan]);
  });
}


test('usage checkout preserves one customer and one monthly recurring price, with a required card', async t => {
  const f = await billingFixture(t, 'usage', false); f.state.subscriptions = [];
  const response = await handleSubscriptionRequest(post('/subscription/checkout', { plan: 'usage' }), f.env);
  assert.equal(response.status, 200);
  const checkout = f.calls.find(call => call.url.pathname === '/v1/checkout/sessions')!;
  assert.equal(checkout.params.get('mode'), 'subscription');
  assert.equal(checkout.params.get('line_items[0][price]'), TEST_USAGE_PRICE);
  assert.equal(checkout.params.get('line_items[0][quantity]'), '1');
  assert.equal(checkout.params.has('line_items[1][price]'), false);
  assert.equal(checkout.params.get('payment_method_collection'), 'always');
  assert.equal(checkout.params.get('customer'), TEST_CUSTOMER);
});

test('legacy subscribers consent to usage at renewal without changing current paid access or creating a subscription', async t => {
  const f = await billingFixture(t, 'pro');
  const response = await handleSubscriptionRequest(post('/subscription/change', { plan: 'usage', confirm: true }), f.env);
  assert.equal(response.status, 200);
  const data = await response.json() as any;
  assert.equal(data.plan, 'pro'); assert.equal(data.scheduled_plan, 'usage'); assert.equal(data.active, true);
  const change = f.calls.find(call => call.params.has('phases[1][items][0][price]'))!;
  assert.equal(change.params.get('phases[1][items][0][price]'), TEST_USAGE_PRICE);
  assert.equal(change.params.get('phases[1][items][0][quantity]'), '1');
  assert.equal(change.params.has('phases[1][items][1][price]'), false);
  assert.ok(!f.calls.some(call => call.url.pathname === '/v1/checkout/sessions'));
});

test('usage subscriptions verify the paid minimum and cannot move to legacy plans', async t => {
  const f = await billingFixture(t, 'usage');
  const response = await handleSubscriptionRequest(billingRequest(), f.env);
  assert.equal(response.status, 200); assert.equal((await response.json() as any).plan, 'usage');
  assert.equal((f.sqlite.prepare('SELECT plan FROM pro_billing').get() as any).plan, 'usage');
  assert.equal((await handleSubscriptionRequest(post('/subscription/change', { plan: 'builder', confirm: true }), f.env)).status, 409);
});
