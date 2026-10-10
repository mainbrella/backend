import test from 'node:test';
import assert from 'node:assert/strict';
import { appendAccountingEvent, ledgerRows, ledgerWatermark, type AccountingEvent, type LedgerRow } from '../lib/accounting-ledger';
import { buildAccountingClose, type AccountingPolicy } from '../lib/accounting-close';
import { handleRequest } from './router';
import { billingFixture, billingRequest, TEST_USER } from './billing-test-helpers';

const received = Date.UTC(2026, 11, 20), checkpointAt = Date.UTC(2027, 1, 2);
const unitsPerCent = 1800000;
const policy: AccountingPolicy = { id: 'approved', method: 'cash_receipts', receipt_timezone: 'UTC', approved_by: 'CPA', evidence_reference: 'signed-review' };
function row(sequence: number, type: AccountingEvent['type'], at: number, data: Record<string, unknown>, userId = TEST_USER): LedgerRow {
  return { sequence, event_key: `event:${sequence}`, user_id: userId, event_type: type, occurred_at: at, recorded_at: checkpointAt, payload: JSON.stringify(data) };
}
function evidence({ credit = 2000, paid = 1100, tax = 100, used = 1000 }: { credit?: number; paid?: number; tax?: number; used?: number } = {}): LedgerRow[] {
  const fundingId = 'pi_paid';
  return [
    row(1, 'funding', received, { fundingId, customerId: 'cus_paid', creditCents: credit, amountPaidCents: paid, taxCollectedCents: tax,
      considerationCents: paid - tax, promotionalCreditCents: credit - (paid - tax), chargeId: paid ? 'ch_paid' : null,
      receiptDateSource: paid ? 'charge_created' : 'observed_completed_checkout', taxLocation: { country: 'US', state: 'CA', postalCode: '90232', source: 'checkout' } }),
    ...(paid ? [row(2, 'stripe_balance', received, { fundingId, transactionId: 'txn_paid', sourceId: 'ch_paid', category: 'payment', amountCents: paid, processingFeeCents: 59, netCents: paid - 59 })] : []),
    row(3, 'funding_state', received, { fundingId, creditCents: credit, revokedCents: 0, refundedCreditCents: 0, disputed: false }),
    ...(used ? [row(4, 'compute', Date.UTC(2026, 11, 31), { resourceId: 'resource', startAt: received + 1, endAt: Date.UTC(2026, 11, 31), unitMs: used * unitsPerCent, unitMsPerCent: unitsPerCent })] : []),
    row(5, 'wallet_checkpoint', checkpointAt, { asOf: checkpointAt, usedUnitMs: used * unitsPerCent, fundings: [{ id: fundingId, creditCents: credit, revokedCents: 0 }] }),
  ];
}

test('discounted credits, deferred revenue, taxable receipts, sales tax and net Stripe funds reconcile separately', () => {
  const report = buildAccountingClose('2026-12', evidence(), policy);
  assert.deepEqual(report.issues, []);
  assert.equal(report.status, 'reconciled');
  assert.equal(report.customerComputeCredits.outstandingCreditCents, 1000);
  assert.equal(report.deferredRevenue.outstandingMicroUsd, '5000000');
  assert.equal(report.deferredRevenue.earnedMicroUsd, '5000000');
  assert.equal(report.taxableAdvancePaymentsByReceiptYear[0].grossIncludedThroughCloseMicroUsd, '10000000');
  assert.equal(report.cash.grossReceiptsMicroUsd, '11000000');
  assert.equal(report.cash.salesTaxCollectedMicroUsd, '1000000');
  assert.equal(report.cash.processingFeesMicroUsd, '590000');
  assert.equal(report.cash.stripeNetMicroUsd, '10410000');
  assert.equal(report.deferredRevenue.reconciliationDifferenceMicroUsd, '0');
  assert.equal(report.taxReceiptReconciliationDifferenceMicroUsd, '0');
});

test('a free promotion creates compute rights with no consideration or liability', () => {
  const report = buildAccountingClose('2026-12', evidence({ paid: 0, tax: 0, used: 0 }), policy);
  assert.deepEqual(report.issues, []);
  assert.equal(report.customerComputeCredits.outstandingCreditCents, 2000);
  assert.equal(report.deferredRevenue.outstandingMicroUsd, '0');
  assert.equal(report.cash.grossReceiptsMicroUsd, '0');
  assert.equal(report.taxableAdvancePaymentsByReceiptYear[0].considerationMicroUsd, '0');
});

test('storage nano-USD and negative invoice adjustments reconcile exact wallet credit and deferred revenue', () => {
  const rows = evidence({ used: 0 });
  rows.splice(rows.length - 1, 0,
    row(4, 'storage', received + 1000, { costNanoUsd: 1000000432 }),
    row(6, 'storage_adjustment', received + 2000, { costNanoUsd: -432 }));
  const checkpoint = rows.at(-1)!;
  checkpoint.sequence = 7;
  checkpoint.payload = JSON.stringify({ ...JSON.parse(checkpoint.payload), usedStorageNanoUsd: 1000000000 });
  const report = buildAccountingClose('2026-12', rows, policy);
  assert.deepEqual(report.issues, []);
  assert.equal(report.customerComputeCredits.outstandingCreditCents, 1900);
  assert.equal(report.customerComputeCredits.consumedUnitMs, '180000000');
  assert.equal(report.deferredRevenue.earnedMicroUsd, '500000');
  checkpoint.payload = JSON.stringify({ ...JSON.parse(checkpoint.payload), usedStorageNanoUsd: 999999999 });
  assert.ok(buildAccountingClose('2026-12', rows, policy).issues.includes(`wallet_storage_usage_mismatch:${TEST_USER}`));
});

test('tax inclusion stays unconfirmed until a CPA policy is selected; 451(c) includes the remainder in the next year', () => {
  const rows = evidence();
  const unconfirmed = buildAccountingClose('2026-12', rows, null);
  assert.equal(unconfirmed.status, 'needs_review');
  assert.equal(unconfirmed.taxableAdvancePaymentsByReceiptYear[0].grossIncludedThroughCloseMicroUsd, null);
  const deferredPolicy: AccountingPolicy = { ...policy, method: 'section_451c' };
  const december = buildAccountingClose('2026-12', rows, deferredPolicy);
  assert.equal(december.taxableAdvancePaymentsByReceiptYear[0].grossIncludedThroughCloseMicroUsd, '5000000');
  assert.equal(december.taxableAdvancePaymentsByReceiptYear[0].notYetIncludedMicroUsd, '5000000');
  const january = buildAccountingClose('2027-01', rows, deferredPolicy);
  assert.equal(january.taxableAdvancePaymentsByReceiptYear[0].grossIncludedThroughCloseMicroUsd, '10000000');
  assert.equal(january.taxableAdvancePaymentsByReceiptYear[0].notYetIncludedMicroUsd, '0');
  assert.equal(january.deferredRevenue.outstandingMicroUsd, '5000000');
});

test('cross-year refunds preserve gross receipt-year inclusion and expose refund-year adjustments and contra revenue', () => {
  const rows = evidence({ paid: 1000, tax: 0, used: 1800 });
  rows.pop();
  rows.push(row(5, 'refund', Date.UTC(2027, 0, 5), { fundingId: 'pi_paid', refundId: 're_partial', amountCents: 500, taxRefundedCents: 0 }));
  rows.push(row(6, 'stripe_balance', Date.UTC(2027, 0, 5), { fundingId: 'pi_paid', sourceId: 're_partial', category: 'refund', amountCents: -500, processingFeeCents: 0, netCents: -500 }));
  rows.push(row(7, 'funding_state', Date.UTC(2027, 0, 5), { fundingId: 'pi_paid', creditCents: 2000, revokedCents: 1000, refundedCreditCents: 1000, disputed: false }));
  rows.push(row(8, 'wallet_checkpoint', checkpointAt, { asOf: checkpointAt, usedUnitMs: 1800 * unitsPerCent, fundings: [{ id: 'pi_paid', creditCents: 2000, revokedCents: 1000 }] }));
  const report = buildAccountingClose('2027-01', rows, policy);
  assert.deepEqual(report.issues, []);
  assert.equal(report.customerComputeCredits.outstandingCreditCents, -800);
  assert.equal(report.deferredRevenue.outstandingMicroUsd, '0');
  assert.equal(report.deferredRevenue.contraRevenueMicroUsd, '4000000');
  assert.equal(report.deferredRevenue.reconciliationDifferenceMicroUsd, '0');
  assert.equal(report.taxableAdvancePaymentsByReceiptYear[0].grossIncludedThroughCloseMicroUsd, '10000000');
  assert.deepEqual(report.refundTaxAdjustmentsByPaymentYear, [{ paymentYear: '2027', amountMicroUsd: '5000000', treatment: 'CPA review required; separate from original gross inclusion' }]);
});

test('a reinstated chargeback restores cash independently of sticky wallet credit revocation', () => {
  const rows = evidence({ paid: 1000, tax: 0, used: 0 }); rows.pop();
  rows.push(row(5, 'funding_state', received + 1000, { fundingId: 'pi_paid', creditCents: 2000, revokedCents: 2000, refundedCreditCents: 0, disputed: true }));
  rows.push(row(6, 'stripe_balance', received + 1000, { fundingId: 'pi_paid', sourceId: 'du_paid', category: 'chargeback', amountCents: -1000, processingFeeCents: 1500, netCents: -2500 }));
  rows.push(row(7, 'stripe_balance', received + 2000, { fundingId: 'pi_paid', sourceId: 'du_paid', category: 'chargeback', amountCents: 1000, processingFeeCents: 0, netCents: 1000 }));
  rows.push(row(8, 'wallet_checkpoint', checkpointAt, { asOf: checkpointAt, usedUnitMs: 0, fundings: [{ id: 'pi_paid', creditCents: 2000, revokedCents: 2000 }] }));
  const report = buildAccountingClose('2026-12', rows, policy);
  assert.equal(report.customerComputeCredits.outstandingCreditCents, 0);
  assert.equal(report.deferredRevenue.outstandingMicroUsd, '10000000');
  assert.equal(report.cash.processingFeesMicroUsd, '15590000');
  assert.equal(report.cash.stripeBalanceDifferenceMicroUsd, '0');
  assert.ok(report.issues.includes('consideration_without_compute_rights_requires_review:pi_paid'));
});

test('missing fees, location, unknown refund tax, legacy usage and source mismatches prevent an unqualified close', () => {
  const rows = evidence(); rows.splice(1, 1);
  const funding = JSON.parse(rows[0].payload); funding.taxLocation.country = null; rows[0].payload = JSON.stringify(funding);
  rows.push(row(6, 'legacy_usage', checkpointAt - 1, { unitMs: 1, monthlyUnitMs: {} }));
  rows.push(row(7, 'refund', received + 2000, { fundingId: 'pi_paid', refundId: 're_tax', amountCents: 100, taxRefundedCents: null }));
  rows.push(row(8, 'wallet_checkpoint', checkpointAt, { asOf: checkpointAt, usedUnitMs: 1000 * unitsPerCent, fundings: [{ id: 'pi_paid', creditCents: 2000, revokedCents: 0 }] }));
  const report = buildAccountingClose('2026-12', rows, policy);
  assert.equal(report.status, 'needs_review');
  for (const issue of ['payment_cash_or_fee_missing:pi_paid', 'tax_location_missing:pi_paid', 'historical_usage_requires_backfill:user_test', 'wallet_usage_mismatch:user_test', 'refund_tax_allocation_unknown:re_tax']) assert.ok(report.issues.includes(issue), issue);
  assert.equal(report.taxReceiptReconciliationDifferenceMicroUsd, '-11000000');
});

test('exact cumulative proportional recognition does not round each short allocation', () => {
  const rows = evidence({ paid: 1000, tax: 0, used: 0 }); rows.pop();
  for (let i = 0; i < 400; i++) rows.push(row(i + 4, 'compute', received + i + 2, { startAt: received + i + 1, endAt: received + i + 2, unitMs: 1, unitMsPerCent: unitsPerCent }));
  rows.push(row(404, 'wallet_checkpoint', checkpointAt, { asOf: checkpointAt, usedUnitMs: 400, fundings: [{ id: 'pi_paid', creditCents: 2000, revokedCents: 0 }] }));
  const report = buildAccountingClose('2026-12', rows, policy);
  assert.equal(report.deferredRevenue.earnedMicroUsd, '1');
  assert.equal(report.customerComputeCredits.consumedUnitMs, '400');
  assert.equal(report.customerComputeCredits.outstandingUnitMs, String(2000 * unitsPerCent - 400));
});

test('receipt-year earned revenue splits local year boundaries and UTC cutoff intervals', () => {
  const receipt = Date.UTC(2026, 11, 31, 6), begins = Date.UTC(2027, 0, 1, 7), ends = begins + 7200000;
  const rows = evidence({ paid: 1000, tax: 0, used: 0 });
  rows[0].occurred_at = receipt; rows[1].occurred_at = receipt; rows[2].occurred_at = receipt; rows.pop();
  rows.push(row(4, 'compute', ends, { startAt: begins, endAt: ends, unitMs: 7200000, unitMsPerCent: unitsPerCent }));
  rows.push(row(5, 'wallet_checkpoint', checkpointAt, { asOf: checkpointAt, usedUnitMs: 7200000, fundings: [{ id: 'pi_paid', creditCents: 2000, revokedCents: 0 }] }));
  const report = buildAccountingClose('2027-01', rows, { ...policy, method: 'section_451c', receipt_timezone: 'America/Los_Angeles' });
  assert.equal(report.taxableAdvancePaymentsByReceiptYear[0].receiptYear, '2026');
  assert.equal(report.taxableAdvancePaymentsByReceiptYear[0].earnedInReceiptYearMicroUsd, '10000');
  assert.equal(report.deferredRevenue.monthlyEarnedMicroUsd, '20000');
  const cutoffRows = evidence({ paid: 1000, tax: 0, used: 0 }); cutoffRows.pop();
  cutoffRows.push(row(4, 'compute', Date.UTC(2027, 0, 1, 1), { startAt: Date.UTC(2026, 11, 31, 23), endAt: Date.UTC(2027, 0, 1, 1), unitMs: 7200000, unitMsPerCent: unitsPerCent }));
  cutoffRows.push(row(5, 'wallet_checkpoint', checkpointAt, { asOf: checkpointAt, usedUnitMs: 7200000, fundings: [{ id: 'pi_paid', creditCents: 2000, revokedCents: 0 }] }));
  assert.equal(buildAccountingClose('2026-12', cutoffRows, policy).customerComputeCredits.consumedUnitMs, '3600000');
});

test('ledger retries validate immutable evidence; updates and deletes fail and account deletion preserves evidence', async t => {
  const f = await billingFixture(t, 'usage', false);
  const event: AccountingEvent = { key: 'funding:pi_test', userId: TEST_USER, type: 'funding', occurredAt: received, data: { amountPaidCents: 1000, nested: { country: 'US', state: 'CA' } } };
  await appendAccountingEvent(f.env, event);
  await appendAccountingEvent(f.env, { ...event, data: { nested: { state: 'CA', country: 'US' }, amountPaidCents: 1000 } });
  assert.equal(await ledgerWatermark(f.env), 1);
  await assert.rejects(appendAccountingEvent(f.env, { ...event, data: { ...event.data, amountPaidCents: 2000 } }), /accounting_event_conflict/);
  assert.throws(() => f.sqlite.exec("UPDATE accounting_ledger SET payload = '{}'"), /append_only/);
  assert.throws(() => f.sqlite.exec('DELETE FROM accounting_ledger'), /append_only/);
  f.sqlite.prepare('DELETE FROM users WHERE id = ?').run(TEST_USER);
  assert.equal((await ledgerRows(f.env, 1)).length, 1);
});

test('admin exports use cookies, stable sequence pages and downloadable exact evidence', async t => {
  const f = await billingFixture(t, 'usage', false);
  assert.equal((await handleRequest(billingRequest('/admin/accounting/ledger', undefined, false), f.env)).status, 401);
  assert.equal((await handleRequest(billingRequest('/admin/accounting/ledger'), f.env)).status, 403);
  f.sqlite.prepare('UPDATE users SET email = ? WHERE id = ?').run('oneone@gmail.com', TEST_USER);
  for (const value of evidence()) await appendAccountingEvent(f.env, { key: value.event_key, userId: value.user_id, type: value.event_type, occurredAt: value.occurred_at, data: JSON.parse(value.payload) });
  const first = await handleRequest(billingRequest('/admin/accounting/ledger?limit=2'), f.env);
  assert.equal(first.status, 200);
  const page = await first.json() as any;
  assert.equal(page.entries.length, 2); assert.equal(page.nextCursor, 2); assert.equal(page.throughSequence, 5);
  await appendAccountingEvent(f.env, { key: 'late', userId: TEST_USER, type: 'refund', occurredAt: received, data: { refundId: 're_late' } });
  const second = await handleRequest(billingRequest('/admin/accounting/ledger?after=2&throughSequence=5&format=ndjson'), f.env);
  assert.equal(second.headers.get('X-Accounting-Through-Sequence'), '5');
  assert.equal(second.headers.get('X-Accounting-Next-Cursor'), '');
  const entries = (await second.text()).trim().split('\n').map(value => JSON.parse(value));
  assert.deepEqual(entries.map(entry => entry.sequence), [3, 4, 5]);
  assert.equal((await handleRequest(billingRequest('/admin/accounting/ledger?after=-1'), f.env)).status, 400);
  assert.equal((await handleRequest(new Request('https://api.mainbrella.com/admin/accounting/ledger', { headers: { Authorization: 'Bearer browser_token' } }), f.env)).status, 401);
});

test('ledger creation-time pages sort recorded timestamps, break ties by sequence, and retain their snapshot', async t => {
  const f = await billingFixture(t, 'usage', false);
  f.sqlite.prepare('UPDATE users SET email = ? WHERE id = ?').run('oneone@gmail.com', TEST_USER);
  const timestamps = [100, 300, 200, 300, 400, 200, 500];
  let timestampIndex = 0;
  t.mock.method(Date, 'now', () => timestamps[timestampIndex++] ?? 600);
  const empty = await handleRequest(billingRequest('/admin/accounting/ledger?order=desc'), f.env);
  assert.deepEqual((await empty.json() as any).entries, []);
  const values = [1, 2, 3, 4, 5, 6];
  for (const value of values) {
    await appendAccountingEvent(f.env, { key: `created:${value}`, userId: TEST_USER, type: 'refund', occurredAt: received, data: { value } });
  }

  const firstResponse = await handleRequest(billingRequest('/admin/accounting/ledger?order=desc&limit=2'), f.env);
  const first = await firstResponse.json() as any;
  assert.equal(first.throughSequence, 6);
  assert.deepEqual(first.entries.map((entry: LedgerRow) => [entry.sequence, entry.recorded_at]), [[5, 400], [4, 300]]);
  assert.equal(first.nextCursor, 4);

  await appendAccountingEvent(f.env, { key: 'created:late', userId: TEST_USER, type: 'refund', occurredAt: received, data: { value: 7 } });
  const secondResponse = await handleRequest(billingRequest(`/admin/accounting/ledger?order=desc&after=${first.nextCursor}&throughSequence=${first.throughSequence}&limit=2`), f.env);
  const second = await secondResponse.json() as any;
  assert.deepEqual(second.entries.map((entry: LedgerRow) => [entry.sequence, entry.recorded_at]), [[2, 300], [6, 200]]);
  assert.equal(second.nextCursor, 6);

  const thirdResponse = await handleRequest(billingRequest(`/admin/accounting/ledger?order=desc&after=${second.nextCursor}&throughSequence=${first.throughSequence}&limit=2`), f.env);
  const third = await thirdResponse.json() as any;
  assert.deepEqual(third.entries.map((entry: LedgerRow) => [entry.sequence, entry.recorded_at]), [[3, 200], [1, 100]]);
  assert.equal(third.nextCursor, null);
  assert.equal((await handleRequest(billingRequest('/admin/accounting/ledger?order=sideways'), f.env)).status, 400);
  assert.equal((await handleRequest(billingRequest('/admin/accounting/ledger?order=desc&after=7&throughSequence=6'), f.env)).status, 400);
});

test('monthly close revisions and CPA policy records are immutable, and no policy is silently selected', async t => {
  const f = await billingFixture(t, 'usage', false);
  t.mock.method(Date, 'now', () => checkpointAt);
  f.sqlite.prepare('UPDATE users SET email = ? WHERE id = ?').run('oneone@gmail.com', TEST_USER);
  assert.equal((await handleRequest(billingRequest('/admin/accounting/policies', { method: 'cash_receipts' }, true, null), f.env)).status, 403);
  const approved = await handleRequest(billingRequest('/admin/accounting/policies', { method: 'cash_receipts', receiptTimezone: 'UTC', approvedBy: 'CPA', evidenceReference: 'signed-review.pdf' }), f.env);
  assert.equal(approved.status, 201);
  const approval = await approved.json() as any;
  const pending = await handleRequest(billingRequest('/admin/accounting/closes', { month: '2026-12' }), f.env);
  assert.equal(pending.status, 201);
  assert.equal((await pending.json() as any).report.taxMethod, 'unconfirmed');
  const selected = await handleRequest(billingRequest('/admin/accounting/closes', { month: '2026-12', policyId: approval.id }), f.env);
  assert.equal(selected.status, 201);
  assert.equal((await selected.json() as any).report.status, 'reconciled');
  const list = await handleRequest(billingRequest('/admin/accounting/closes?month=2026-12'), f.env);
  assert.equal((await list.json() as any).closes.length, 2);
  assert.throws(() => f.sqlite.exec('DELETE FROM accounting_closes'), /append_only/);
  assert.throws(() => f.sqlite.exec("UPDATE accounting_policies SET method = 'section_451c'"), /append_only/);
  assert.equal((await handleRequest(billingRequest('/admin/accounting/closes', { month: '2027-02' }), f.env)).status, 400);
  assert.equal((await handleRequest(billingRequest('/admin/accounting/policies', { method: 'cash_receipts', receiptTimezone: 'Wrong/Zone', approvedBy: 'CPA', evidenceReference: 'file' }), f.env)).status, 400);
});
