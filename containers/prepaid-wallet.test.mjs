import test from 'node:test';
import assert from 'node:assert/strict';
import { PrepaidWallet, UNIT_MS_PER_CENT, utcPeriod } from './prepaid-wallet.js';
import { ContainerAccountController } from './container-account-core.js';

function fixture(recharge, accountingSink) {
  let now = Date.UTC(2026, 9, 31, 23, 59);
  const saved = [];
  const account = { now: () => now, accountingSink, ctx: { storage: { async put(key, value) { saved.push(structuredClone(value)); } } } };
  const wallet = new PrepaidWallet(account, recharge);
  const state = { userId: 'owner', leases: {}, production: {}, spendLimitCents: 5000 };
  const payment = { id: 'pi_paid', customerId: 'cus_owner', amountCents: 500, refundedCents: 0, disputed: false, createdAt: now, kind: 'topup' };
  wallet.applyFunding(state, payment);
  const lease = (duration, size = 'lite') => ({ size, startAt: now, meteredUntil: now, endAt: now + duration,
    billing: { kind: 'prepaid', customerId: 'cus_owner', ...utcPeriod(now) } });
  return { wallet, state, payment, lease, saved, now: () => now, advance(ms) { now += ms; } };
}

test('accounting outbox survives lost acknowledgements and retains all usage beyond wallet history compaction', async () => {
  const ledger = new Map(); let loseAcknowledgement = true;
  const f = fixture(undefined, async event => {
    const prior = ledger.get(event.key);
    if (prior) assert.deepEqual(event, prior);
    ledger.set(event.key, structuredClone(event));
    if (loseAcknowledgement) { loseAcknowledgement = false; throw new Error('lost_ack'); }
  });
  const lease = f.lease(120000); f.state.leases.small = lease; f.wallet.track(f.state, lease, 'small');
  f.advance(120000); f.wallet.record(f.state, lease, f.now()); f.wallet.finish(f.state, lease, f.now()); delete f.state.leases.small;
  await f.wallet.flushAccounting(f.state);
  assert.ok(Object.keys(f.state.wallet.accounting.pending).length > 0);
  assert.ok(Object.keys(f.saved[0].wallet.accounting.pending).length > 0);
  await f.wallet.flushAccounting(f.state);
  assert.deepEqual(f.state.wallet.accounting.pending, {});
  const boundaryRows = [...ledger.values()].filter(event => event.type === 'compute');
  assert.equal(boundaryRows.length, 2);
  assert.equal(boundaryRows[0].data.endAt, Date.UTC(2026, 10, 1));
  assert.equal(boundaryRows.reduce((sum, event) => sum + event.data.unitMs, 0), 120000);
  for (let i = 0; i < 260; i++) {
    const current = f.lease(1); f.state.leases.small = current; f.wallet.track(f.state, current, 'small');
    f.advance(1); f.wallet.record(f.state, current, f.now()); f.wallet.finish(f.state, current, f.now()); delete f.state.leases.small;
    await f.wallet.flushAccounting(f.state);
  }
  assert.equal(Object.keys(f.state.wallet.resources).length, 256);
  const usage = [...ledger.values()].filter(event => event.type === 'compute');
  assert.equal(usage.length, 262);
  assert.equal(usage.reduce((sum, event) => sum + event.data.unitMs, 0), f.state.wallet.usedUnitMs);
});

test('accounting activation preserves a labeled baseline without attributing old usage to new allocations', async () => {
  const f = fixture(); f.state.wallet.usedUnitMs = 500;
  const ledger = [];
  f.wallet.account.accountingSink = async event => ledger.push(event);
  const lease = f.lease(10); f.state.leases.small = lease; f.wallet.track(f.state, lease, 'small');
  f.advance(10); f.wallet.record(f.state, lease, f.now());
  f.wallet.checkpoint(f.state);
  await f.wallet.flushAccounting(f.state);
  assert.equal(ledger.find(event => event.type === 'legacy_usage').data.unitMs, 500);
  assert.equal(ledger.find(event => event.type === 'compute').data.unitMs, 10);
});

test('buffered compute remains separate from immutable retries after eviction and lost acknowledgements', async () => {
  const ledger = new Map(); let loseAcknowledgement = true;
  const f = fixture(undefined, async event => {
    if (ledger.has(event.key)) assert.deepEqual(event, ledger.get(event.key));
    ledger.set(event.key, structuredClone(event));
    if (event.type === 'compute' && loseAcknowledgement) { loseAcknowledgement = false; throw new Error('lost_ack'); }
  });
  f.advance(60000); // Start outside the month boundary.
  let lease = f.lease(3600000, 'small'); f.state.leases.small = lease;
  f.advance(900000); f.wallet.record(f.state, lease, f.now());
  await f.wallet.flushAccounting(f.state);
  const frozen = structuredClone(Object.values(f.state.wallet.accounting.pending));
  assert.equal(frozen.length, 1);
  assert.equal(frozen[0].data.unitMs, 900000 * 6);

  f.state = structuredClone(f.saved.at(-1));
  f.wallet = new PrepaidWallet(f.wallet.account);
  lease = f.state.leases.small;
  f.advance(30000); f.wallet.record(f.state, lease, f.now());
  assert.deepEqual(Object.values(f.state.wallet.accounting.pending), frozen);
  assert.equal(Object.values(f.state.wallet.accounting.computeIntervals)[0].unitMs, 30000 * 6);
  await f.wallet.flushAccounting(f.state);
  assert.deepEqual(f.state.wallet.accounting.pending, {});
  assert.equal([...ledger.values()].filter(event => event.type === 'compute').length, 1);
  f.wallet.finish(f.state, lease, f.now());
  await f.wallet.flushAccounting(f.state);
  const usage = [...ledger.values()].filter(event => event.type === 'compute');
  assert.equal(usage.length, 2);
  assert.equal(usage[0].data.endAt, usage[1].data.startAt);
  assert.equal(usage.reduce((sum, event) => sum + event.data.unitMs, 0), f.state.wallet.usedUnitMs);
});

for (const change of ['topup', 'refund', 'dispute']) {
  test(`an actual ${change} flushes buffered and live usage, while duplicate funding leaves intervals combined`, async () => {
    const ledger = [], f = fixture(undefined, async event => ledger.push(structuredClone(event)));
    f.advance(60000);
    const lease = f.lease(3600000); f.state.leases.small = lease;
    await f.wallet.flushAccounting(f.state);
    f.advance(20000); f.wallet.record(f.state, lease, f.now());
    await f.wallet.flushAccounting(f.state);
    assert.equal(ledger.filter(event => event.type === 'compute').length, 0);
    f.advance(10000); f.wallet.applyFunding(f.state, f.payment);
    await f.wallet.flushAccounting(f.state);
    assert.equal(ledger.filter(event => event.type === 'compute').length, 0);
    assert.equal(f.state.wallet.usedUnitMs, 20000);

    const changed = { ...f.payment, ...(change === 'topup' ? { id: 'pi_new', createdAt: f.now() }
      : change === 'refund' ? { refundedCents: 100 } : { disputed: true }) };
    f.wallet.applyFunding(f.state, changed);
    await f.wallet.flushAccounting(f.state);
    const usage = ledger.filter(event => event.type === 'compute');
    assert.equal(usage.length, 1);
    assert.equal(usage[0].data.unitMs, 30000);
    assert.equal(ledger.at(-1).type, 'funding_state');
    assert.equal(ledger.at(-1).occurredAt, usage[0].occurredAt);
    assert.deepEqual(f.state.wallet.accounting.computeIntervals, {});

    f.advance(30000); f.wallet.record(f.state, lease, f.now());
    f.wallet.applyFunding(f.state, changed);
    await f.wallet.flushAccounting(f.state);
    assert.equal(ledger.filter(event => event.type === 'compute').length, 1);
    assert.equal(Object.values(f.state.wallet.accounting.computeIntervals)[0].unitMs, 30000);
  });
}

test('a resource metadata change preserves both interval descriptions without merging them', async () => {
  const ledger = [], f = fixture(undefined, async event => ledger.push(structuredClone(event)));
  f.advance(60000);
  const lease = f.lease(3600000); lease.name = 'Original'; f.state.leases.small = lease;
  f.advance(30000); f.wallet.record(f.state, lease, f.now());
  lease.name = 'Renamed'; f.advance(30000); f.wallet.record(f.state, lease, f.now());
  f.wallet.checkpoint(f.state);
  await f.wallet.flushAccounting(f.state);
  const usage = ledger.filter(event => event.type === 'compute');
  assert.deepEqual(usage.map(event => event.data.name), ['Original', 'Renamed']);
  assert.equal(usage[0].data.resourceId, usage[1].data.resourceId);
  assert.equal(usage[0].data.endAt, usage[1].data.startAt);
  assert.equal(usage.reduce((sum, event) => sum + event.data.unitMs, 0), 60000);
});

test('existing short outbox events survive upgrade, and stopping one allocation leaves the other buffered', async () => {
  const ledger = [], f = fixture(undefined, async event => ledger.push(structuredClone(event)));
  f.advance(60000);
  const first = f.lease(3600000), second = f.lease(3600000, 'small');
  f.state.leases.small = first; f.state.leases.c1 = second;
  const resource = f.wallet.track(f.state, first, 'small');
  // Simulate an event and metering cursor already persisted by the old writer.
  const oldData = { resourceId: resource.id, containerId: 'small', name: null, lifecycle: 'ad_hoc', size: 'lite',
    startAt: f.now(), endAt: f.now() + 30000, unitMs: 30000, unitMsPerCent: UNIT_MS_PER_CENT };
  f.wallet.queue(f.state, { key: `compute:${resource.id}:${oldData.startAt}:${oldData.endAt}`, type: 'compute', occurredAt: oldData.endAt, data: oldData });
  first.meteredUntil = oldData.endAt; resource.runtimeMs = 30000; resource.unitMs = 30000;
  f.state.wallet.usedUnitMs = 30000; f.state.wallet.monthlyUnitMs['2026-11'] = 30000;
  const frozen = structuredClone(Object.values(f.state.wallet.accounting.pending).find(event => event.type === 'compute'));
  f.advance(60000);
  f.wallet.record(f.state, first, f.now()); f.wallet.record(f.state, second, f.now());
  f.wallet.finish(f.state, first, f.now()); delete f.state.leases.small;
  assert.equal(Object.keys(f.state.wallet.accounting.computeIntervals).length, 1);
  assert.equal(Object.values(f.state.wallet.accounting.computeIntervals)[0].resourceId, second.resourceHistoryId);
  await f.wallet.flushAccounting(f.state);
  const usage = ledger.filter(event => event.type === 'compute');
  assert.deepEqual(usage[0], frozen);
  assert.equal(usage.length, 2);
  assert.equal(usage[0].data.endAt, usage[1].data.startAt);
  f.wallet.checkpoint(f.state); await f.wallet.flushAccounting(f.state);
  assert.equal(ledger.filter(event => event.type === 'compute').reduce((sum, event) => sum + event.data.unitMs, 0), f.state.wallet.usedUnitMs);
});

test('revocation recovery cannot create credit and records disputes after a full refund as separate evidence', async () => {
  const ledger = [], f = fixture(undefined, async event => ledger.push(event));
  f.wallet.applyFunding(f.state, { ...f.payment, id: 'pi_unrecorded', refundedCents: 100, revokeOnly: true });
  assert.equal(f.state.wallet.fundings.pi_unrecorded, undefined);
  f.wallet.applyFunding(f.state, { ...f.payment, refundedCents: 500, revokeOnly: true });
  await f.wallet.flushAccounting(f.state);
  f.wallet.applyFunding(f.state, { ...f.payment, refundedCents: 500, disputed: true });
  await f.wallet.flushAccounting(f.state);
  const states = ledger.filter(event => event.type === 'funding_state');
  assert.equal(states.length, 3);
  assert.notEqual(states[1].key, states[2].key);
  assert.equal(states[1].data.disputed, false);
  assert.equal(states[2].data.disputed, true);
  assert.equal(f.wallet.status(f.state).balanceCents, 0);
});

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

test('history reconciles exact live runtime, renewals, settlement retries and reused slots', () => {
  const f = fixture(), first = f.lease(60000, 'small');
  first.name = 'Build machine'; first.lifecycle = 'production';
  f.state.leases.small = first; f.wallet.track(f.state, first, 'small');
  f.advance(10000); f.wallet.record(f.state, first, f.now());
  f.wallet.record(f.state, first, f.now());
  first.endAt += 60000; f.advance(5000);
  const before = structuredClone(f.state), live = f.wallet.history(f.state);
  assert.deepEqual(f.state, before); // A read does not settle or renew runtime.
  assert.equal(live.activeResources[0].runtimeMs, 15000);
  assert.equal(live.activeResources[0].usedCents, 15000 * 6 / UNIT_MS_PER_CENT);
  assert.equal(live.currentHourlyCents, 12);
  assert.equal(live.totals.unattributedUsedCents, 0);
  assert.equal(live.balance.balanceCents, Math.floor(live.totals.fundedCents - live.totals.revokedCents - live.totals.usedCents));
  f.wallet.record(f.state, first, f.now()); f.wallet.finish(f.state, first, f.now()); delete f.state.leases.small;
  const second = f.lease(10000); f.state.leases.small = second; f.wallet.track(f.state, second, 'small');
  f.advance(1000);
  const history = f.wallet.history(f.state);
  assert.notEqual(history.resources[0].id, history.activeResources[0].id);
  assert.equal(history.resources[0].runtimeMs, 15000);
  assert.equal(history.resources[0].endAt, first.startAt + 15000);
  assert.equal(history.resources[0].reservedCents, 0);
  assert.equal(history.activeResources[0].runtimeMs, 1000);
  assert.equal(history.totals.usedCents, (15000 * 6 + 1000) / UNIT_MS_PER_CENT);
});

test('history never fabricates pretracking usage and preserves lifetime consumption after compaction', () => {
  const f = fixture();
  f.state.wallet.usedUnitMs = 100000;
  const old = f.lease(10000); old.startAt -= 100000;
  f.state.leases.small = old; f.advance(1000);
  const legacy = f.wallet.history(f.state);
  assert.equal(legacy.totals.unattributedUsedCents, 100000 / UNIT_MS_PER_CENT);
  assert.equal(legacy.activeResources[0].startAt, old.meteredUntil);
  assert.equal(legacy.activeResources[0].runtimeMs, 1000);
  assert.equal(legacy.historyTruncated, true);
  f.wallet.record(f.state, old, f.now()); f.wallet.finish(f.state, old, f.now()); delete f.state.leases.small;
  for (let index = 0; index < 260; index++) {
    const lease = f.lease(1); f.state.leases.small = lease; f.wallet.track(f.state, lease, 'small');
    f.advance(1); f.wallet.record(f.state, lease, f.now()); f.wallet.finish(f.state, lease, f.now()); delete f.state.leases.small;
  }
  const history = f.wallet.history(f.state, { limit: 100 });
  assert.equal(Object.keys(f.state.wallet.resources).length, 256);
  assert.equal(history.resources.length, 100);
  assert.equal(history.totals.usedCents, 101260 / UNIT_MS_PER_CENT);
  assert.equal(history.totals.unattributedUsedCents, 101004 / UNIT_MS_PER_CENT);
  const next = f.wallet.history(f.state, { limit: 100, resourceCursor: history.nextResourceCursor });
  assert.equal(next.resources.length, 100);
  assert.equal(new Set([...history.resources, ...next.resources].map(row => row.id)).size, 200);
  assert.throws(() => f.wallet.history(f.state, { resourceCursor: 'missing' }), /invalid_history_cursor/);
});

test('funding history reports original credits and current deductions with purchase timestamps', () => {
  const f = fixture();
  f.wallet.applyFunding(f.state, { ...f.payment, refundedCents: 100 });
  f.wallet.applyFunding(f.state, { ...f.payment, id: 'cs_free', createdAt: f.now() + 1, disputed: true });
  const first = f.wallet.history(f.state, { limit: 1 });
  assert.deepEqual(first.totals, { fundedCents: 1000, revokedCents: 600, usedCents: 0, unattributedUsedCents: 0 });
  assert.deepEqual(first.fundings[0], { id: 'cs_free', createdAt: f.now() + 1, amountCents: 500, revokedCents: 500, reason: 'dispute' });
  const second = f.wallet.history(f.state, { limit: 1, fundingCursor: first.nextFundingCursor });
  assert.deepEqual(second.fundings[0], { id: 'pi_paid', createdAt: f.payment.createdAt, amountCents: 500, revokedCents: 100, reason: 'refund' });
  assert.equal(second.nextFundingCursor, null);
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
