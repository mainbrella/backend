import test from 'node:test';
import assert from 'node:assert/strict';
import { PrepaidWallet } from './wallet.js';
import { applyUsage, usageReceiptKey } from './usage.js';

function fixture() {
  const now = Date.UTC(2026, 9, 16), events = [];
  const wallet = new PrepaidWallet({ now: () => now, accountingSink: async event => events.push(event) }, undefined,
    { machineSize: () => ({ computeUnits: 1 }), centsPerComputeUnitHour: 2 });
  const state = { userId: 'owner', leases: {}, spendLimitCents: 500 };
  wallet.applyFunding(state, { id: 'pi_funds', customerId: 'cus_owner', amountCents: 1000,
    refundedCents: 0, disputed: false, createdAt: now, kind: 'topup' });
  const receipts = new Map();
  const apply = input => {
    const key = usageReceiptKey(input), receipt = applyUsage(wallet, state, input, receipts.get(key));
    receipts.set(key, structuredClone(receipt));
    return receipt;
  };
  const reserve = { action: 'reserve', product: 'email', meter: 'send', id: 'message_1', reservedMicroUsd: 20, createdAt: now };
  const settle = { action: 'settle', product: 'email', meter: 'send', id: 'message_1', costMicroUsd: 7,
    occurredAt: now, evidence: { providerId: 'accepted_1', recipients: 1 } };
  return { wallet, state, receipts, apply, reserve, settle, now };
}

test('fractional charges, holds, product attribution and immutable settlement survive retries', () => {
  const f = fixture();
  f.apply(f.reserve); f.apply(f.reserve);
  assert.equal(f.state.wallet.usageReservedMicroUsd, 20);
  f.apply(f.settle); f.apply({ ...f.settle, evidence: { recipients: 1, providerId: 'accepted_1' } });
  assert.equal(f.state.wallet.usageReservedMicroUsd, 0);
  assert.equal(f.state.wallet.usedUsageMicroUsd, 7);
  assert.equal(f.wallet.history(f.state).totals.usageUsedCents, 0.0007);
  assert.deepEqual(f.wallet.history(f.state).productUsage, [{ product: 'email', usedCents: 0.0007 }]);
  assert.equal(f.state.wallet.accounting.pending['usage:email:message_1'].data.costMicroUsd, 7);
  assert.throws(() => f.apply({ ...f.settle, costMicroUsd: 8 }), /usage_receipt_conflict/);
  assert.throws(() => f.apply({ ...f.settle, evidence: { providerId: 'different' } }), /usage_receipt_conflict/);
  assert.throws(() => f.apply({ ...f.reserve, meter: 'different' }), /usage_receipt_conflict/);
  assert.equal(f.state.wallet.usedUsageMicroUsd, 7);
});

test('Email shares the cap with legacy inference and Linux compute reservations', () => {
  const f = fixture();
  f.wallet.inference(f.state, { action: 'reserve', id: `${crypto.randomUUID()}:operation`, model: 'llm', appId: 'agent',
    turnId: 'call', reservedMicroUsd: 3000000, createdAt: f.now });
  f.state.leases.small = { size: 'lite', meteredUntil: f.now, endAt: f.now + 90000000, billing: { kind: 'prepaid' } };
  assert.throws(() => f.apply({ ...f.reserve, reservedMicroUsd: 1500001 }), /spend_limit_exceeded/);
  f.apply({ ...f.reserve, reservedMicroUsd: 1500000 });
  assert.throws(() => f.apply({ ...f.reserve, id: 'message_2', reservedMicroUsd: 1 }), /spend_limit_exceeded/);
});

test('releases require a known non-send outcome and cannot erase a settled receipt', () => {
  const f = fixture(); f.apply(f.reserve);
  const release = { action: 'release', product: 'email', meter: 'send', id: 'message_1', occurredAt: f.now, reason: 'provider_rejected' };
  assert.throws(() => f.apply({ ...release, reason: 'timeout' }), /invalid_request/);
  assert.equal(f.state.wallet.usageReservedMicroUsd, 20);
  f.apply(release); f.apply(release);
  assert.equal(f.state.wallet.usageReservedMicroUsd, 0);
  assert.throws(() => f.apply(f.settle), /usage_receipt_conflict/);
  assert.equal(f.state.wallet.usedUsageMicroUsd, 0);
});

test('product keys isolate receipts and per-message records do not grow the account snapshot', () => {
  const f = fixture();
  for (let index = 0; index < 1000; index++) {
    const id = `message_${index}`;
    f.apply({ ...f.reserve, id }); f.apply({ ...f.settle, id });
    // Simulate the host draining its persistent accounting outbox.
    f.state.wallet.accounting.pending = {};
  }
  f.apply({ ...f.reserve, product: 'jobs' });
  f.apply({ ...f.reserve, product: 'constructor' });
  f.apply({ ...f.settle, product: 'constructor' });
  assert.equal(f.receipts.size, 1002);
  assert.ok(JSON.stringify(f.state).length < 2000);
  assert.equal(f.state.wallet.usedUsageMicroUsd, 7007);
  assert.throws(() => f.apply({ ...f.reserve, id: '../other' }), /invalid_request/);
  assert.throws(() => f.apply({ ...f.reserve, id: 'oversized', reservedMicroUsd: Number.MAX_SAFE_INTEGER }), /invalid_request/);
  f.state.wallet.fundingRevoked = true;
  assert.throws(() => f.apply({ ...f.reserve, id: 'new' }), /insufficient_balance/);
});
