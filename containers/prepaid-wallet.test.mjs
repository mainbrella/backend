import test from 'node:test';
import assert from 'node:assert/strict';
import { PrepaidWallet, UNIT_MS_PER_CENT, utcPeriod } from './prepaid-wallet.js';
import { ContainerAccountController } from './container-account-core.js';

function fixture(recharge) {
  let now = Date.UTC(2026, 9, 31, 23, 59);
  const saved = [];
  const account = { now: () => now, ctx: { storage: { async put(key, value) { saved.push(structuredClone(value)); } } } };
  const wallet = new PrepaidWallet(account, recharge);
  const state = { userId: 'owner', leases: {}, production: {}, spendLimitCents: 5000 };
  const payment = { id: 'pi_paid', customerId: 'cus_owner', amountCents: 500, refundedCents: 0, disputed: false, createdAt: now, kind: 'topup' };
  wallet.applyFunding(state, payment);
  const lease = (duration, size = 'lite') => ({ size, startAt: now, meteredUntil: now, endAt: now + duration,
    billing: { kind: 'prepaid', customerId: 'cus_owner', ...utcPeriod(now) } });
  return { wallet, state, payment, lease, saved, now: () => now, advance(ms) { now += ms; } };
}

test('short allocations accumulate exact lifetime cost without per-start or per-period rounding', () => {
  const f = fixture();
  for (let i = 0; i < 100; i++) {
    const lease = f.lease(1);
    f.advance(1);
    f.wallet.record(f.state, lease, f.now());
    f.wallet.record(f.state, lease, f.now()); // repeated settlement cannot charge twice
  }
  assert.equal(f.state.wallet.usedUnitMs, 100);
  assert.equal(f.wallet.metrics(f.state).remaining, 500 * UNIT_MS_PER_CENT - 100);
  f.advance(86400000);
  assert.equal(f.wallet.metrics(f.state).remaining, 500 * UNIT_MS_PER_CENT - 100);
});

test('out-of-order refund and dispute observations cannot restore reversed money', () => {
  const f = fixture();
  f.wallet.applyFunding(f.state, { ...f.payment, refundedCents: 250 });
  f.wallet.applyFunding(f.state, f.payment);
  assert.equal(f.wallet.status(f.state).balanceCents, 250);
  f.wallet.applyFunding(f.state, { ...f.payment, disputed: true });
  f.wallet.applyFunding(f.state, f.payment);
  assert.equal(f.wallet.status(f.state).balanceCents, 0);
});

test('a zero-cost Checkout session is a durable idempotent funding identity', async () => {
  const stored = new Map();
  const storage = {
    async get(key) { return structuredClone(stored.get(key)); },
    async put(key, value) { stored.set(key, structuredClone(value)); },
    async getAlarm() { return null; }, async setAlarm() {}, async deleteAlarm() {},
  };
  const controller = new ContainerAccountController({ storage }, () => { throw new Error('funding_must_not_allocate_compute'); });
  const freeFunding = { id: 'cs_free_topup', customerId: 'cus_owner', amountCents: 500, refundedCents: 0,
    disputed: false, createdAt: 1800000000000, kind: 'topup' };
  const postFunding = funding => controller.fetch(new Request('https://internal/billing/funding', {
    method: 'POST', headers: { 'x-mainbrella-user': 'owner' }, body: JSON.stringify(funding),
  }));
  const balance = async () => {
    const response = await controller.fetch(new Request('https://internal/billing/balance', { headers: { 'x-mainbrella-user': 'owner' } }));
    assert.equal(response.status, 200);
    return (await response.json()).balance;
  };

  assert.equal((await postFunding(freeFunding)).status, 200);
  assert.equal((await postFunding(freeFunding)).status, 200); // Browser and webhook share the cs identity.
  assert.equal((await balance()).balanceCents, 500);
  assert.equal((await postFunding({ ...freeFunding, refundedCents: 250 })).status, 200);
  assert.equal((await postFunding(freeFunding)).status, 200); // A delayed success cannot undo a refund.
  assert.equal((await balance()).balanceCents, 250);
  assert.equal((await postFunding({ ...freeFunding, disputed: true })).status, 200);
  assert.equal((await postFunding({ ...freeFunding, refundedCents: 0 })).status, 200);
  assert.equal((await balance()).balanceCents, 0);
});

test('a lowered monthly cap also protects already funded next-month runtime', () => {
  const f = fixture();
  f.state.leases.small = f.lease(86400000, 'xl');
  assert.throws(() => f.wallet.settings(f.state, { spendLimitCents: 500 }), /spend_limit_below_committed_usage/);
  assert.equal(f.state.spendLimitCents, 5000);
});

test('automatic recharge resumes under a new month allowance and persists before charging', async () => {
  let f;
  const attempts = [];
  f = fixture(async entry => {
    assert.equal(f.saved.at(-1).wallet.pendingRecharge.identifier, entry.identifier);
    attempts.push(entry);
    return { status: 'succeeded', paymentIntentId: 'pi_recharge', funding: { ...f.payment, id: 'pi_recharge', createdAt: f.now() } };
  });
  f.wallet.settings(f.state, { autoRecharge: { enabled: true, amountCents: 500, monthlyLimitCents: 500 } });
  f.state.wallet.usedUnitMs = 500 * UNIT_MS_PER_CENT;
  f.state.wallet.rechargeSpending['2026-10'] = 500;
  await f.wallet.maybeRecharge(f.state);
  assert.equal(attempts.length, 0);
  assert.equal(f.state.wallet.autoRecharge.status, 'monthly_limit_reached');
  f.advance(120000);
  await f.wallet.maybeRecharge(f.state);
  assert.equal(attempts.length, 1);
  assert.equal(f.wallet.status(f.state).autoRecharge.spentCents, 500);
  assert.equal(f.wallet.status(f.state).balanceCents, 500);
});
