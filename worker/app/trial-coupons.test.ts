import test from 'node:test';
import assert from 'node:assert/strict';
import { billingFixture, billingRequest, TEST_USER } from './billing-test-helpers';
import { hashToken } from './auth-core';
import { handleSubscriptionRequest } from './subscription';
import { resolveEntitlement } from '../lib/entitlements';
import { redeemTrial } from '../lib/trial-coupons';

async function fixture(t: Parameters<typeof billingFixture>[0], options: { plan?: string; days?: number; uses?: number; expiry?: number; enabled?: number } = {}) {
  const f = await billingFixture(t, 'builder', false);
  f.state.subscriptions = [];
  const hash = await hashToken('WELCOME123');
  f.sqlite.prepare('INSERT INTO trial_coupons (code_hash,plan,trial_days,max_redemptions,expires_at,enabled) VALUES (?,?,?,?,?,?)')
    .run(hash, options.plan ?? 'builder', options.days ?? 14, options.uses ?? 1, options.expiry ?? Date.now() + 86400000, options.enabled ?? 1);
  return f;
}
const post = (body: unknown) => billingRequest('/subscription/trial', body);

test('trial endpoint requires session, browser origin, method, plan and code', async t => {
  const f = await fixture(t);
  for (const request of [billingRequest('/subscription/trial', {plan:'builder',code:'WELCOME123'}, false),
    billingRequest('/subscription/trial', {plan:'builder',code:'WELCOME123'}, true, null),
    billingRequest('/subscription/trial', {plan:'builder',code:'WELCOME123'}, true, 'https://evil.example'),
    billingRequest('/subscription/trial'), post({plan:'unknown',code:'WELCOME123'}), post({plan:'builder'}), post({plan:'builder',code:{}})]) {
    const response = await handleSubscriptionRequest(request, f.env);
    assert.ok(response.status >= 400);
  }
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM trial_redemptions').get()!.n, 0);
});

test('valid case-insensitive code grants card-free entitlement; retry preserves deadline and redemption count', async t => {
  const f = await fixture(t);
  let changed = false;
  const response = await handleSubscriptionRequest(post({plan:'builder',code:' welcome123 '}), f.env, async (_, entitlement) => { changed = entitlement.active; });
  assert.equal(response.status, 200);
  const state = await response.json() as any;
  assert.equal(state.active, true); assert.equal(state.plan, 'builder'); assert.equal(state.subscription, null);
  assert.ok(Math.abs(state.valid_until - Date.now() - 14 * 86400000) < 2000);
  assert.equal(state.trial.expires_at, state.valid_until); assert.equal(changed, true);
  assert.equal(f.calls.length, 0, 'trial does not create a Stripe subscription or payment');
  const repeated = await handleSubscriptionRequest(post({plan:'builder',code:'WELCOME123'}), f.env);
  assert.equal((await repeated.json() as any).valid_until, state.valid_until);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM trial_redemptions').get()!.n, 1);
  assert.equal((await resolveEntitlement(f.env, TEST_USER)).validUntil, state.valid_until);
  f.sqlite.prepare('UPDATE trial_redemptions SET expires_at = ?').run(Date.now() - 1);
  assert.equal((await resolveEntitlement(f.env, TEST_USER)).active, false);
  const reuse = await handleSubscriptionRequest(post({plan:'builder',code:'WELCOME123'}), f.env);
  assert.equal(reuse.status, 409); assert.equal((await reuse.json() as any).error, 'trial_already_used');
});

for (const [name, options, code, plan] of [
  ['unknown', {}, 'UNKNOWN123', 'builder'], ['expired', {expiry:Date.now()-1000}, 'WELCOME123', 'builder'],
  ['disabled', {enabled:0}, 'WELCOME123', 'builder'], ['wrong plan', {}, 'WELCOME123', 'pro'],
] as const) test(`${name} code never grants access`, async t => {
  const f = await fixture(t, options);
  const response = await handleSubscriptionRequest(post({plan,code}), f.env);
  assert.equal(response.status, 400); assert.equal((await response.json() as any).error, 'invalid_promo_code');
  assert.equal((await resolveEntitlement(f.env, TEST_USER)).active, false);
});

test('global redemption cap and one trial per account hold for competing redemptions', async t => {
  const f = await fixture(t);
  f.sqlite.prepare('INSERT INTO users (id,email,name) VALUES (?,?,?)').run('second', 'second@example.com', 'Second');
  const results = await Promise.allSettled([redeemTrial(f.env, TEST_USER, 'builder', 'WELCOME123'), redeemTrial(f.env, 'second', 'builder', 'WELCOME123')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM trial_redemptions').get()!.n, 1);
});

test('live subscriptions block coupons and paid access supersedes an existing trial', async t => {
  const f = await billingFixture(t);
  const response = await handleSubscriptionRequest(post({plan:'builder',code:'WELCOME123'}), f.env);
  assert.equal(response.status, 409);
  const hash = await hashToken('WELCOME123');
  f.sqlite.prepare('INSERT INTO trial_coupons (code_hash,plan,trial_days,max_redemptions,expires_at) VALUES (?,?,?,?,?)').run(hash,'scale',14,1,Date.now()+86400000);
  await redeemTrial(f.env, TEST_USER, 'scale', 'WELCOME123');
  assert.equal((await resolveEntitlement(f.env, TEST_USER)).plan, 'builder');
});


test('competing different codes can grant only one trial to the same account', async t => {
  const f = await fixture(t, {uses:10});
  const hash = await hashToken('SECOND123');
  f.sqlite.prepare('INSERT INTO trial_coupons (code_hash,plan,trial_days,max_redemptions,expires_at) VALUES (?,?,?,?,?)').run(hash, 'pro', 30, 10, Date.now()+86400000);
  const results = await Promise.allSettled([redeemTrial(f.env, TEST_USER, 'builder', 'WELCOME123'), redeemTrial(f.env, TEST_USER, 'pro', 'SECOND123')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM trial_redemptions').get()!.n, 1);
});


test('deleting a redeemed account does not refund a coupon use', async t => {
  const f = await fixture(t);
  await redeemTrial(f.env, TEST_USER, 'builder', 'WELCOME123');
  f.sqlite.prepare('DELETE FROM trial_redemptions WHERE user_id = ?').run(TEST_USER);
  await assert.rejects(redeemTrial(f.env, TEST_USER, 'builder', 'WELCOME123'), /invalid_promo_code/);
  assert.equal(f.sqlite.prepare('SELECT redeemed_count FROM trial_coupons').get()!.redeemed_count, 1);
});
