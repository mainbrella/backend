import test from 'node:test';
import assert from 'node:assert/strict';
import { handleSubscriptionRequest } from './subscription';
import { handleSubscriptionWebhook, verifyStripeSignature } from './subscription-webhook';
import { billingFixture, TEST_CUSTOMER, TEST_USER } from './billing-test-helpers';
import type { BillingEnv } from '../lib/stripe';

async function signature(body: string, secret = 'whsec_test', timestamp = Math.floor(Date.now() / 1000)) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`)));
  return `t=${timestamp},v1=${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`;
}
function event(type = 'customer.subscription.updated', id = 'evt_test', customer: string | null = TEST_CUSTOMER) {
  return { id, type, data: { object: customer ? { customer } : {} } };
}
async function webhook(value: unknown = event(), options: { secret?: string; timestamp?: number; origin?: string; body?: string; signature?: string } = {}) {
  const body = options.body ?? JSON.stringify(value);
  return new Request('https://api.mainbrella.com/subscription/webhook', { method: 'POST',
    headers: { 'Stripe-Signature': options.signature ?? await signature(body, options.secret, options.timestamp),
      ...(options.origin ? { Origin: options.origin } : {}) }, body });
}

test('webhook signature verifies the exact raw body, allows rotated v1 signatures and rejects replay timestamps', async () => {
  const body = '{ "id": "evt_test", "spacing": true }';
  const valid = await signature(body);
  assert.equal(await verifyStripeSignature(body, valid, 'whsec_test'), true);
  assert.equal(await verifyStripeSignature(JSON.stringify(JSON.parse(body)), valid, 'whsec_test'), false);
  assert.equal(await verifyStripeSignature(body, `${valid},v1=${'0'.repeat(64)}`, 'whsec_test'), true);
  assert.equal(await verifyStripeSignature(body, await signature(body, 'wrong'), 'whsec_test'), false);
  assert.equal(await verifyStripeSignature(body, await signature(body, 'whsec_test', Math.floor(Date.now() / 1000) - 301), 'whsec_test'), false);
  assert.equal(await verifyStripeSignature(body, await signature(body, 'whsec_test', Math.floor(Date.now() / 1000) + 301), 'whsec_test'), false);
  assert.equal(await verifyStripeSignature(body, `${valid},t=123`, 'whsec_test'), false);
  assert.equal(await verifyStripeSignature(body, null, 'whsec_test'), false);
});

test('signed webhook bypasses browser CORS/login checks but reconciles live Stripe and calls account enforcement', async t => {
  const f = await billingFixture(t); const updates: unknown[] = [];
  const response = await handleSubscriptionRequest(await webhook(event(), { origin: 'https://stripe.com' }), f.env,
    async (userId, entitlement) => { updates.push([userId, entitlement]); });
  assert.equal(response.status, 200); assert.equal(updates.length, 1);
  const [userId, entitlement] = updates[0] as any;
  assert.equal(userId, TEST_USER); assert.equal(entitlement.active, true); assert.equal(entitlement.plan, 'builder');
  assert.ok(entitlement.checkedAt > 0);
  assert.equal((f.sqlite.prepare('SELECT count(*) AS n FROM billing_webhook_events').get() as any).n, 1);
});

test('processed webhook replay never re-fetches Stripe or repeats account enforcement', async t => {
  const f = await billingFixture(t); let updates = 0;
  const changed = async () => { updates++; };
  assert.equal((await handleSubscriptionWebhook(await webhook(), f.env, changed)).status, 200);
  const calls = f.calls.length;
  assert.equal((await handleSubscriptionWebhook(await webhook(), f.env, changed)).status, 200);
  assert.equal(f.calls.length, calls); assert.equal(updates, 1);
});

test('delayed active subscription events cannot restore currently unpaid access', async t => {
  const f = await billingFixture(t); f.state.subscriptions[0].status = 'past_due';
  const stale = { ...event(), data: { object: { customer: TEST_CUSTOMER, status: 'active' } } };
  let received: any;
  assert.equal((await handleSubscriptionWebhook(await webhook(stale), f.env, async (_id, value) => { received = value; })).status, 200);
  assert.equal(received.active, false); assert.equal(received.plan, null);
});

test('payment failure and failed account revocation remain retryable without saving a receipt', async t => {
  const f = await billingFixture(t); t.mock.method(console, 'error', () => {});
  f.state.override = () => new Response('unavailable', { status: 500 });
  assert.equal((await handleSubscriptionWebhook(await webhook(), f.env)).status, 503);
  assert.equal((f.sqlite.prepare('SELECT count(*) AS n FROM billing_webhook_events').get() as any).n, 0);
  f.state.override = null;
  assert.equal((await handleSubscriptionWebhook(await webhook(), f.env, async () => { throw new Error('Account unavailable'); })).status, 503);
  assert.equal((f.sqlite.prepare('SELECT count(*) AS n FROM billing_webhook_events').get() as any).n, 0);
  assert.equal((await handleSubscriptionWebhook(await webhook(), f.env, async () => {})).status, 200);
  assert.equal((f.sqlite.prepare('SELECT count(*) AS n FROM billing_webhook_events').get() as any).n, 1);
});

test('guest/unregistered customers never create accounts or attach purchases from event metadata', async t => {
  const f = await billingFixture(t); let changed = false;
  const guest = { ...event('checkout.session.completed', 'evt_guest', 'cus_guest'), data: { object: { customer: 'cus_guest', metadata: { app_user_id: TEST_USER }, client_reference_id: TEST_USER } } };
  assert.equal((await handleSubscriptionWebhook(await webhook(guest), f.env, async () => { changed = true; })).status, 200);
  assert.equal(changed, false); assert.equal(f.calls.length, 0);
  assert.equal((f.sqlite.prepare('SELECT count(*) AS n FROM pro_billing').get() as any).n, 1);
});

test('refund and dispute webhooks revoke based on current charge payment proof', async t => {
  const f = await billingFixture(t); f.state.intent.latest_charge.refunded = true; f.state.intent.latest_charge.amount_refunded = 500;
  let access: any;
  const changed = async (_id: string, value: unknown) => { access = value; };
  assert.equal((await handleSubscriptionWebhook(await webhook(event('charge.refunded', 'evt_refund')), f.env, changed)).status, 200);
  assert.equal(access.active, false);
  f.state.intent.latest_charge.refunded = false; f.state.intent.latest_charge.amount_refunded = 0; f.state.intent.latest_charge.disputed = true;
  const dispute = { id: 'evt_dispute', type: 'charge.dispute.created', data: { object: { charge: 'ch_paid' } } };
  assert.equal((await handleSubscriptionWebhook(await webhook(dispute), f.env, changed)).status, 200);
  assert.equal(access.active, false); assert.ok(f.calls.some(c => c.url.pathname === '/v1/charges/ch_paid'));
});

test('unsupported event types are acknowledged without account or Stripe reads', async t => {
  const f = await billingFixture(t);
  assert.equal((await handleSubscriptionWebhook(await webhook(event('customer.created')), f.env)).status, 200);
  assert.equal(f.calls.length, 0); assert.equal((f.sqlite.prepare('SELECT count(*) AS n FROM billing_webhook_events').get() as any).n, 0);
});

test('invalid signatures, malformed events and oversized payloads fail before Stripe', async t => {
  const f = await billingFixture(t);
  for (const request of [
    await webhook(event(), { secret: 'wrong_secret' }), await webhook(event(), { signature: 'not_valid' }),
    await webhook(event(), { body: 'not_json' }), await webhook({ id: 'evt_bad', type: 3, data: {} }),
    await webhook(event(), { body: ' '.repeat(262145) }),
  ]) assert.equal((await handleSubscriptionWebhook(request, f.env)).status, 400);
  assert.equal(f.calls.length, 0);
});

test('webhook requires POST and configured endpoint secret', async t => {
  const f = await billingFixture(t);
  assert.equal((await handleSubscriptionWebhook(new Request('https://api.mainbrella.com/subscription/webhook'), f.env)).status, 405);
  assert.equal((await handleSubscriptionWebhook(await webhook(), { ...f.env, STRIPE_WEBHOOK_SECRET: undefined } as unknown as BillingEnv)).status, 503);
});
