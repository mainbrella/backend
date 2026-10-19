import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reserveUsage, settleUsage, releaseUsage } from '../lib/wallet-billing.ts';
import { ContainerAccountController } from '../../containers/container-account-core.js';
import { appendAccountingEvent } from '../lib/accounting-ledger';
import { billingFixture, TEST_USER, TEST_CUSTOMER } from './billing-test-helpers';

test('product reservations use existing recharge consent and never recharge invalid or capped operations', async () => {
  const now = Date.UTC(2026, 9, 16), values = new Map<string, any>();
  const storage = { async get(key: string) { return structuredClone(values.get(key)); },
    async put(key: string | Record<string, unknown>, value?: unknown) {
      for (const [name, item] of Object.entries(typeof key === 'string' ? { [key]: value } : key)) values.set(name, structuredClone(item));
    }, async getAlarm() { return null; }, async setAlarm() {}, async deleteAlarm() {} };
  let recharges = 0;
  const funding = (id: string) => ({ id, customerId: TEST_CUSTOMER, amountCents: 500, refundedCents: 0,
    disputed: false, createdAt: now, kind: 'topup' });
  const controller = new ContainerAccountController({ storage } as any,
    () => { throw new Error('billing_must_not_provision_compute'); }, () => now, undefined, undefined,
    async () => { recharges++; return { status: 'succeeded', funding: funding('pi_auto') } as any; });
  const post = (path: string, body: unknown) => controller.fetch(new Request(`https://internal${path}`,
    { method: 'POST', headers: { 'x-mainbrella-user': TEST_USER }, body: JSON.stringify(body) }));
  assert.equal((await post('/billing/funding', funding('pi_initial'))).status, 200);
  assert.equal((await post('/billing/settings', { spendLimitCents: 1000,
    autoRecharge: { enabled: true, amountCents: 500, monthlyLimitCents: 500 } })).status, 200);
  const identity = { product: 'email', meter: 'send', id: 'batch_1' };
  assert.equal((await post('/billing/usage', { ...identity, action: 'reserve', createdAt: now, reservedMicroUsd: 5000000 })).status, 200);
  assert.equal(recharges, 0);
  assert.equal((await post('/billing/usage', { ...identity, action: 'settle', occurredAt: now, costMicroUsd: 5000000, evidence: { providerId: 'accepted' } })).status, 200);
  assert.equal((await post('/billing/usage', { ...identity, id: 'batch_2', action: 'reserve', createdAt: now, reservedMicroUsd: 1 })).status, 200);
  assert.equal(recharges, 1);
  const blocked = await post('/billing/usage', { ...identity, id: 'batch_3', action: 'reserve', createdAt: now, reservedMicroUsd: 6000000 });
  assert.equal(blocked.status, 402);
  assert.equal((await blocked.json() as any).error, 'spend_limit_exceeded');
  assert.equal((await post('/billing/usage', { ...identity, id: 'invalid', action: 'reserve', createdAt: now, reservedMicroUsd: -1 })).status, 400);
  assert.equal(recharges, 1);
});

test('the existing account binding atomically saves product receipts and recovers lost acknowledgements after eviction', async t => {
  const f = await billingFixture(t, 'usage', false);
  f.sqlite.exec(readFileSync(new URL('../../migrations/049_product_usage.sql', import.meta.url), 'utf8'));
  const now = Date.UTC(2026, 9, 16), values = new Map<string, any>();
  let loseAcknowledgement = false;
  const storage = {
    async get(key: string) { return structuredClone(values.get(key)); },
    async put(key: string | Record<string, unknown>, value?: unknown) {
      if (typeof key === 'string') values.set(key, structuredClone(value));
      else {
        for (const [name, item] of Object.entries(key)) values.set(name, structuredClone(item));
        if (loseAcknowledgement) { loseAcknowledgement = false; throw new Error('lost_ack'); }
      }
    },
    async getAlarm() { return null; }, async setAlarm() {}, async deleteAlarm() {},
  };
  const createController = () => new ContainerAccountController({ storage } as any,
    () => { throw new Error('billing_must_not_provision_compute'); }, () => now, undefined, undefined, undefined,
    event => appendAccountingEvent(f.env, event));
  let controller = createController();
  f.env.CONTAINER_ACCOUNT = { idFromName(name: string) { assert.equal(name, `account:${TEST_USER}`); return name; },
    get: () => ({ fetch: (request: Request) => controller.fetch(request) }) } as any;
  const funding = await controller.fetch(new Request('https://internal/billing/funding', { method: 'POST',
    headers: { 'x-mainbrella-user': TEST_USER }, body: JSON.stringify({ id: 'pi_product', customerId: TEST_CUSTOMER,
      amountCents: 500, refundedCents: 0, disputed: false, createdAt: now, kind: 'topup' }) }));
  assert.equal(funding.status, 200);
  const identity = { product: 'email', meter: 'send', id: 'message_1' };
  const reservation = { ...identity, reservedMicroUsd: 1000, createdAt: now };
  await reserveUsage(f.env, TEST_USER, reservation);
  const settlement = { ...identity, costMicroUsd: 125, occurredAt: now, evidence: { providerId: 'accepted_1' } };
  loseAcknowledgement = true;
  await assert.rejects(settleUsage(f.env, TEST_USER, settlement));
  controller = createController();
  const recovered = await settleUsage(f.env, TEST_USER, settlement);
  assert.equal(recovered.status, 'settled');
  assert.equal((await reserveUsage(f.env, TEST_USER, reservation)).status, 'settled');
  assert.equal(values.get('containerAccount').wallet.usedUsageMicroUsd, 125);
  assert.equal(values.get('containerAccount').wallet.usageReservedMicroUsd, 0);
  const ledger = f.sqlite.prepare("SELECT payload FROM accounting_ledger WHERE event_type='usage'").all();
  assert.equal(ledger.length, 1);
  assert.equal(JSON.parse(ledger[0].payload as string).product, 'email');
  await assert.rejects(settleUsage(f.env, TEST_USER, { ...settlement, costMicroUsd: 126 }), /usage_receipt_conflict/);
  await assert.rejects(releaseUsage(f.env, TEST_USER, { ...identity, occurredAt: now, reason: 'provider_rejected' }), /usage_receipt_conflict/);
});
