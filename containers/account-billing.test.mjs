import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountBilling } from './account-billing.js';

function fixture(cents, invoiceUsage) {
  const billing = { customerId: 'cus_owner', subscriptionId: 'sub_owner', periodStart: 1000, periodEnd: 2000 };
  const state = { entitlement: { active: true, plan: 'usage', billing }, leases: {}, billingPeriods: {
    'sub_owner:1000': { ...billing, unitMs: cents / 2 * 3600000, resourceCharges: {} },
  } };
  let persisted;
  const account = { now: () => 3000, ctx: { storage: { async put(_key, value) { persisted = structuredClone(value); } } } };
  return { state, ledger: new AccountBilling(account, invoiceUsage), persisted: () => persisted,
    context: { invoiceId: 'in_renewal', customerId: 'cus_owner', subscriptionId: 'sub_owner', cutoff: 3000 } };
}

for (const cents of [0, 300, 1200, 18000, 99900]) {
  test(`$${cents / 100} of monthly usage produces a $${Math.max(500, cents) / 100} total bill`, async () => {
    const entries = [];
    const f = fixture(cents, async entry => { entries.push(entry); return 'ii_usage'; });
    await f.ledger.invoice(f.state, f.context);
    assert.equal(500 + (entries[0]?.amountCents ?? 0), Math.max(500, cents));
    await f.ledger.invoice(f.state, f.context);
    assert.equal(entries.length, cents > 500 ? 1 : 0);
  });
}

test('the included $5 applies once across compute, IP, storage and email usage', async () => {
  const entries = [];
  const f = fixture(300, async entry => { entries.push(entry); return 'ii_usage'; });
  f.state.billingPeriods['sub_owner:1000'].resourceCharges = { 'ip:allocation': 400, 'storage:bytes': 300, 'email:batch': 200 };
  await f.ledger.invoice(f.state, f.context);
  assert.equal(entries[0].totalCents, 1200); assert.equal(entries[0].amountCents, 700);
});

test('an interrupted invoice write retries an immutable amount and identifier after eviction', async () => {
  let attempts = 0;
  const external = new Map();
  const f = fixture(1200, async entry => {
    external.set(entry.identifier, entry.amountCents);
    if (++attempts === 1) throw new Error('response_lost');
    return 'ii_usage';
  });
  await assert.rejects(f.ledger.invoice(f.state, f.context), /response_lost/);
  const restored = f.persisted();
  assert.equal(restored.billingPeriods['sub_owner:1000'].pending.amountCents, 700);
  await f.ledger.invoice(restored, f.context);
  assert.equal(external.size, 1);
  assert.equal(restored.billingPeriods['sub_owner:1000'].invoiceItemId, 'ii_usage');
});

test('open periods and other subscriptions are never charged on the wrong invoice', async () => {
  const f = fixture(1200, async () => { throw new Error('unexpected_charge'); });
  await f.ledger.invoice(f.state, { ...f.context, cutoff: 1999 });
  await f.ledger.invoice(f.state, { ...f.context, subscriptionId: 'sub_other' });
  assert.equal(f.state.billingPeriods['sub_owner:1000'].invoiced, undefined);
});

test('renewal waits for pending runtime to settle before freezing the final charge', async () => {
  const entries = [];
  const f = fixture(1200, async entry => { entries.push(entry); return 'ii_usage'; });
  f.state.leases.small = { billing: f.state.entitlement.billing };
  await assert.rejects(f.ledger.invoice(f.state, f.context), /billing_reconciliation_required/);
  assert.equal(entries.length, 0);
  delete f.state.leases.small;
  f.state.billingPeriods['sub_owner:1000'].unitMs += 300 / 2 * 3600000;
  await f.ledger.invoice(f.state, f.context);
  assert.equal(entries[0].amountCents, 1000);
});

test('cancellation bills the elapsed partial period once without another minimum', async () => {
  const entries = [];
  const f = fixture(1200, async entry => { entries.push(entry); return 'ii_usage'; });
  await f.ledger.invoice(f.state, { ...f.context, cutoff: 1500, final: true });
  await f.ledger.invoice(f.state, { ...f.context, cutoff: 1600, final: true });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].amountCents, 700);
});
