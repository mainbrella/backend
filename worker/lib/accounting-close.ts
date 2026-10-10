import { accountBillingRequest, applyPrepaidPayment, completePrepaidCheckout, type PrepaidAccount } from './prepaid-billing';
import { ledgerRows, ledgerWatermark, type LedgerRow } from './accounting-ledger';
import type { BillingEnv } from './stripe';

const UNIT_MS_PER_CENT = 1800000n; // Current wallet rate: 2 cents / CU-hour.
const MICRO_USD_PER_CENT = 10000n;
export interface AccountingPolicy { id: string; method: 'cash_receipts' | 'section_451c'; receipt_timezone: string; approved_by: string; evidence_reference: string }
export function monthBounds(month: string): { start: number; end: number } {
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('invalid_month');
  const [year, value] = month.split('-').map(Number);
  return { start: Date.UTC(year, value - 1, 1), end: Date.UTC(year, value, 1) };
}
interface Lot {
  id: string; userId: string; receiptYear: string; units: bigint; revoked: bigint; consumed: bigint;
  paid: bigint; tax: bigint; consideration: bigint; earned: bigint; receiptYearEarned: bigint; refunded: bigint; chargeback: bigint;
  chargeId: string | null; creditCents: number; location: { country: string | null; state: string | null; postalCode: string | null; source: string };
  disputed: boolean;
}
const money = (cents: unknown) => BigInt(cents as number) * MICRO_USD_PER_CENT;
const yearAt = (at: number, timezone: string) => new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric' }).format(at);
function taxYearStart(year: number, timezone: string): number {
  const target = Date.UTC(year, 0, 1);
  let guess = target;
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' });
  for (let attempt = 0; attempt < 3; attempt++) {
    const parts = Object.fromEntries(formatter.formatToParts(guess).map(part => [part.type, part.value]));
    guess += target - Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  }
  return guess;
}
const max = (a: bigint, b: bigint) => a > b ? a : b;
const min = (a: bigint, b: bigint) => a < b ? a : b;

// Replays a fixed ledger watermark. Money is integer micro-USD, compute is
// weighted milliseconds. Never sum rounded dashboard cents or net Stripe cash.
export function buildAccountingClose(month: string, rows: LedgerRow[], policy: AccountingPolicy | null) {
  const { start, end } = monthBounds(month), timezone = policy?.receipt_timezone ?? 'UTC';
  const closeYear = yearAt(end - 1, timezone), issues = new Set<string>();
  if (!policy) issues.add('cpa_tax_method_not_recorded');
  const lots = new Map<string, Lot>(), userLots = new Map<string, Lot[]>();
  const refundBalances = new Map<string, bigint>(), paymentBalances = new Map<string, bigint>();
  const checkpoints = new Map<string, LedgerRow>();
  const allFunding = new Map<string, number>(), byUser = new Map<string, LedgerRow[]>();
  let creditFunded = 0n, creditRevoked = 0n, used = 0n, legacyUsed = 0n, monthlyEarned = 0n;
  let fees = 0n, stripeNet = 0n, stripeGross = 0n, refundedTax = 0n;
  const refunds: { fundingId: string; refundId: string; amount: bigint; tax: bigint | null; paymentYear: string }[] = [];
  const chargebacks: { fundingId: string; amount: bigint }[] = [];
  const taxAdjustments = new Map<string, bigint>();
  // A checkpoint is current evidence that the entire source wallet has arrived,
  // even when this close is for a historical month. Usage predating the ledger
  // remains a qualification, rather than invented historical transactions.
  for (const row of rows) {
    const d = JSON.parse(row.payload);
    const accountRows = byUser.get(row.user_id) ?? []; accountRows.push(row); byUser.set(row.user_id, accountRows);
    if (row.event_type === 'wallet_checkpoint') checkpoints.set(row.user_id, row);
    if (row.event_type === 'funding') allFunding.set(d.fundingId, d.creditCents);
  }
  for (const [userId, checkpoint] of checkpoints) {
    const d = JSON.parse(checkpoint.payload);
    if (d.asOf < end) issues.add(`wallet_checkpoint_before_cutoff:${userId}`);
    const evidence = byUser.get(userId)!.filter(r => r.sequence <= checkpoint.sequence);
    const revoked = new Map<string, number>();
    const refunded = new Map<string, number>();
    for (const item of evidence) {
      const fact = JSON.parse(item.payload);
      if (item.event_type === 'funding_state') revoked.set(fact.fundingId, Math.max(revoked.get(fact.fundingId) ?? 0, fact.revokedCents));
      if (item.event_type === 'refund') refunded.set(fact.fundingId, (refunded.get(fact.fundingId) ?? 0) + fact.amountCents);
    }
    const checkpointUsed = evidence.filter(r => ['compute', 'inference', 'legacy_usage'].includes(r.event_type))
      .reduce((sum, r) => sum + (r.event_type === 'inference' ? BigInt(JSON.parse(r.payload).costMicroUsd) * 180n : BigInt(JSON.parse(r.payload).unitMs)), 0n);
    if (checkpointUsed !== BigInt(d.usedUnitMs)) issues.add(`wallet_usage_mismatch:${userId}`);
    for (const funding of d.fundings) {
      if (allFunding.get(funding.id) !== funding.creditCents) issues.add(`wallet_funding_missing_or_mismatched:${funding.id}`);
      if ((revoked.get(funding.id) ?? -1) !== funding.revokedCents) issues.add(`wallet_revocation_mismatch:${funding.id}`);
    }
    const walletIds = new Set(d.fundings.map((f: { id: string }) => f.id));
    for (const row of evidence.filter(r => r.event_type === 'funding')) {
      const funding = JSON.parse(row.payload);
      if (!walletIds.has(funding.fundingId)) issues.add(`ledger_funding_not_in_wallet:${funding.fundingId}`);
      const states = evidence.filter(r => r.event_type === 'funding_state' && JSON.parse(r.payload).fundingId === funding.fundingId);
      const refundedCredit = states.reduce((largest, state) => Math.max(largest, JSON.parse(state.payload).refundedCreditCents), 0);
      const expectedCredit = funding.amountPaidCents ? Math.ceil((refunded.get(funding.fundingId) ?? 0) * funding.creditCents / funding.amountPaidCents) : 0;
      if (expectedCredit !== refundedCredit) issues.add(`refund_credit_not_reconciled:${funding.fundingId}`);
    }
  }
  for (const userId of new Set(rows.filter(r => ['funding', 'compute', 'inference'].includes(r.event_type)).map(r => r.user_id))) {
    if (!checkpoints.has(userId)) issues.add(`wallet_checkpoint_missing:${userId}`);
  }
  // Split source intervals at receipts, revocations, the close boundary and
  // local tax-year boundaries. Recognition follows delivery time, including
  // December runtime that is not checkpointed until January.
  const transitions = new Map<string, number[]>();
  for (const row of rows.filter(r => r.event_type === 'funding' || r.event_type === 'funding_state')) {
    const values = transitions.get(row.user_id) ?? []; values.push(row.occurred_at); transitions.set(row.user_id, values);
  }
  const effectiveRows = rows.flatMap(row => {
    if (row.event_type !== 'compute') return [row];
    const d = JSON.parse(row.payload), until = Math.min(d.endAt, end);
    if (d.startAt >= until) return [];
    const cuts = new Set<number>([d.startAt, until]);
    if (start > d.startAt && start < until) cuts.add(start);
    for (const at of transitions.get(row.user_id) ?? []) if (at > d.startAt && at < until) cuts.add(at);
    for (let year = Number(yearAt(d.startAt, timezone)) + 1; year <= Number(yearAt(until, timezone)); year++) {
      const at = taxYearStart(year, timezone); if (at > d.startAt && at < until) cuts.add(at);
    }
    const sorted = [...cuts].sort((a, b) => a - b);
    return sorted.slice(1).map((at, index) => ({ ...row, occurred_at: at,
      payload: JSON.stringify({ ...d, startAt: sorted[index], endAt: at, unitMs: Number(BigInt(d.unitMs) * BigInt(at - sorted[index]) / BigInt(d.endAt - d.startAt)) }) }));
  });
  const ordered = effectiveRows.sort((a, b) => a.occurred_at - b.occurred_at
    || Number(a.event_type !== 'compute') - Number(b.event_type !== 'compute') || a.sequence - b.sequence);
  const chargebackSources = new Set<string>();
  for (const row of ordered) {
    const d = JSON.parse(row.payload);
    if (row.event_type === 'legacy_usage' && BigInt(d.unitMs) > 0n) issues.add(`historical_usage_requires_backfill:${row.user_id}`);
    if (row.event_type === 'compute') {
      if (d.startAt >= end) continue;
    } else if (row.occurred_at >= end) continue;
    if (row.event_type === 'funding') {
      const lot: Lot = { id: d.fundingId, userId: row.user_id, receiptYear: yearAt(row.occurred_at, timezone), units: BigInt(d.creditCents) * UNIT_MS_PER_CENT,
        revoked: 0n, consumed: 0n, paid: money(d.amountPaidCents), tax: money(d.taxCollectedCents), consideration: money(d.considerationCents),
        earned: 0n, receiptYearEarned: 0n, refunded: 0n, chargeback: 0n, chargeId: d.chargeId, creditCents: d.creditCents, location: d.taxLocation, disputed: false };
      lots.set(lot.id, lot);
      const account = userLots.get(lot.userId) ?? [];
      if (account.reduce((sum, prior) => sum + prior.units - prior.revoked - prior.consumed, 0n) < 0n) issues.add(`funding_offsets_negative_credit_requires_review:${lot.id}`);
      account.push(lot); userLots.set(lot.userId, account);
      creditFunded += lot.units;
      if (!lot.location.country || (lot.location.country === 'US' && (!lot.location.state || !lot.location.postalCode))) issues.add(`tax_location_missing:${lot.id}`);
      if (d.receiptDateSource === 'payment_intent_created' && lot.paid > 0n) issues.add(`payment_receipt_date_requires_review:${lot.id}`);
    } else if (row.event_type === 'funding_state') {
      const lot = lots.get(d.fundingId);
      if (!lot) { issues.add(`credit_without_receipt:${d.fundingId}`); continue; }
      const revoked = BigInt(d.revokedCents) * UNIT_MS_PER_CENT;
      creditRevoked += max(0n, revoked - lot.revoked); lot.revoked = max(revoked, lot.revoked);
      lot.disputed ||= d.disputed;
    } else if (['compute', 'inference', 'legacy_usage'].includes(row.event_type)) {
      let consumed = row.event_type === 'inference' ? BigInt(d.costMicroUsd) * 180n : BigInt(d.unitMs);
      if (row.event_type === 'compute') {
        if (d.unitMsPerCent !== Number(UNIT_MS_PER_CENT)) issues.add(`unrecognized_compute_rate:${row.event_key}`);
        // Intervals spanning a cutoff are prorated using integer CU-ms. The
        // wallet splits UTC months; later checkpoints may end past this cutoff.
        if (d.endAt > end) consumed = consumed * BigInt(end - d.startAt) / BigInt(d.endAt - d.startAt);
      } else if (row.event_type === 'legacy_usage') legacyUsed += consumed;
      used += consumed;
      let remaining = consumed;
      for (const lot of userLots.get(row.user_id) ?? []) {
        const take = min(remaining, max(0n, lot.units - lot.revoked - lot.consumed));
        const previous = lot.earned;
        lot.consumed += take; lot.earned = lot.consideration * lot.consumed / lot.units;
        const earned = lot.earned - previous;
        if (yearAt(Math.min(row.occurred_at - 1, end - 1), timezone) === lot.receiptYear) lot.receiptYearEarned += earned;
        if (row.occurred_at > start && (row.event_type !== 'compute' || d.startAt >= start)) monthlyEarned += earned;
        remaining -= take;
        if (!remaining) break;
      }
      if (remaining) issues.add(`usage_exceeds_funded_credit:${row.user_id}`);
    } else if (row.event_type === 'refund') {
      refunds.push({ fundingId: d.fundingId, refundId: d.refundId, amount: money(d.amountCents), tax: d.taxRefundedCents === null ? null : money(d.taxRefundedCents), paymentYear: yearAt(row.occurred_at, timezone) });
    } else if (row.event_type === 'stripe_balance') {
      fees += money(d.processingFeeCents); stripeNet += money(d.netCents); stripeGross += money(d.amountCents);
      if (d.category === 'payment') paymentBalances.set(d.fundingId, (paymentBalances.get(d.fundingId) ?? 0n) + money(d.amountCents));
      if (d.category === 'refund') refundBalances.set(d.sourceId, (refundBalances.get(d.sourceId) ?? 0n) - money(d.amountCents));
      if (d.category === 'chargeback') { chargebacks.push({ fundingId: d.fundingId, amount: -money(d.amountCents) }); chargebackSources.add(d.fundingId); }
    }
  }
  for (const refund of refunds) {
    const lot = lots.get(refund.fundingId);
    if (!lot) { issues.add(`refund_without_receipt:${refund.refundId}`); continue; }
    if (refund.tax === null) { issues.add(`refund_tax_allocation_unknown:${refund.refundId}`); continue; }
    lot.refunded += refund.amount - refund.tax; refundedTax += refund.tax;
    taxAdjustments.set(refund.paymentYear, (taxAdjustments.get(refund.paymentYear) ?? 0n) + refund.amount - refund.tax);
    if (refundBalances.get(refund.refundId) !== refund.amount) issues.add(`refund_cash_not_reconciled:${refund.refundId}`);
  }
  for (const txn of chargebacks) {
    const lot = lots.get(txn.fundingId);
    if (!lot) { issues.add(`chargeback_without_receipt:${txn.fundingId}`); continue; }
    lot.chargeback += txn.amount;
    if (lot.tax > 0n) issues.add(`chargeback_tax_allocation_requires_review:${lot.id}`);
  }
  let consideration = 0n, earned = 0n, liability = 0n, refundAdjustments = 0n, chargebackAdjustments = 0n, contraRevenue = 0n, grossReceipts = 0n, taxes = 0n;
  const cohorts = new Map<string, { receipts: bigint; earned: bigint; refunds: bigint; chargebacks: bigint }>();
  const jurisdictions = new Map<string, { country: string | null; state: string | null; consideration: bigint; tax: bigint }>();
  for (const lot of lots.values()) {
    consideration += lot.consideration; earned += lot.earned; refundAdjustments += lot.refunded; chargebackAdjustments += lot.chargeback;
    grossReceipts += lot.paid; taxes += lot.tax;
    const residual = lot.consideration - lot.earned - lot.refunded - lot.chargeback;
    liability += max(0n, residual); contraRevenue += max(0n, -residual);
    if (lot.paid > 0n && paymentBalances.get(lot.id) !== lot.paid) issues.add(`payment_cash_or_fee_missing:${lot.id}`);
    if (lot.units - lot.revoked - lot.consumed <= 0n && residual > 0n) issues.add(`consideration_without_compute_rights_requires_review:${lot.id}`);
    if (lot.chargeback > 0n) issues.add(`chargeback_revenue_treatment_requires_review:${lot.id}`);
    if (lot.disputed && !chargebackSources.has(lot.id)) issues.add(`dispute_cash_evidence_missing:${lot.id}`);
    const cohort = cohorts.get(lot.receiptYear) ?? { receipts: 0n, earned: 0n, refunds: 0n, chargebacks: 0n };
    cohort.receipts += lot.consideration; cohort.earned += lot.receiptYearEarned; cohort.refunds += lot.refunded; cohort.chargebacks += lot.chargeback; cohorts.set(lot.receiptYear, cohort);
    const key = `${lot.location.country ?? 'unknown'}:${lot.location.state ?? 'unknown'}`;
    const jurisdiction = jurisdictions.get(key) ?? { country: lot.location.country, state: lot.location.state, consideration: 0n, tax: 0n };
    jurisdiction.consideration += lot.consideration; jurisdiction.tax += lot.tax; jurisdictions.set(key, jurisdiction);
  }
  const credits = creditFunded - creditRevoked - used;
  const cohortReceipts = [...cohorts.values()].reduce((sum, c) => sum + c.receipts, 0n);
  return {
    month, periodStart: start, periodEnd: end, calendar: 'UTC', currency: 'usd', moneyUnit: 'micro_usd', computeUnit: 'weighted_millisecond',
    status: issues.size ? 'needs_review' : 'reconciled', issues: [...issues].sort(),
    policyId: policy?.id ?? null, taxMethod: policy?.method ?? 'unconfirmed', receiptTimezone: timezone,
    allocationMethod: 'FIFO; actual consideration allocated proportionally to original compute credit; no breakage recognition',
    customerComputeCredits: { fundedUnitMs: creditFunded.toString(), revokedUnitMs: creditRevoked.toString(), consumedUnitMs: used.toString(),
      outstandingUnitMs: credits.toString(), outstandingCreditCents: Number(credits) / Number(UNIT_MS_PER_CENT), historicalUnattributedUnitMs: legacyUsed.toString(),
      walletAccountsReconciled: checkpoints.size, sourceReconciliation: [...issues].some(i => /^(wallet_|ledger_funding|historical_usage|credit_without)/.test(i)) ? 'failed' : 'passed' },
    deferredRevenue: { considerationMicroUsd: consideration.toString(), earnedMicroUsd: earned.toString(), monthlyEarnedMicroUsd: monthlyEarned.toString(),
      refundsMicroUsd: refundAdjustments.toString(), chargebacksMicroUsd: chargebackAdjustments.toString(), contraRevenueMicroUsd: contraRevenue.toString(),
      outstandingMicroUsd: liability.toString(), reconciliationDifferenceMicroUsd: (consideration - earned - refundAdjustments - chargebackAdjustments - liability + contraRevenue).toString() },
    taxableAdvancePaymentsByReceiptYear: [...cohorts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([receiptYear, cohort]) => {
      const included = !policy ? null : policy.method === 'cash_receipts' || closeYear > receiptYear ? cohort.receipts : cohort.earned;
      return { receiptYear, considerationMicroUsd: cohort.receipts.toString(), earnedInReceiptYearMicroUsd: cohort.earned.toString(),
        grossIncludedThroughCloseMicroUsd: included?.toString() ?? null, notYetIncludedMicroUsd: included === null ? null : (cohort.receipts - included).toString(),
        refundsThroughCloseMicroUsd: cohort.refunds.toString(), chargebacksThroughCloseMicroUsd: cohort.chargebacks.toString() };
    }),
    taxReceiptReconciliationDifferenceMicroUsd: ([...paymentBalances.values()].reduce((sum, value) => sum + value, 0n) - taxes - cohortReceipts).toString(),
    refundTaxAdjustmentsByPaymentYear: [...taxAdjustments.entries()].map(([paymentYear, amount]) => ({ paymentYear, amountMicroUsd: amount.toString(), treatment: 'CPA review required; separate from original gross inclusion' })),
    cash: { grossReceiptsMicroUsd: grossReceipts.toString(), salesTaxCollectedMicroUsd: taxes.toString(), salesTaxRefundedMicroUsd: refundedTax.toString(),
      processingFeesMicroUsd: fees.toString(), stripeNetMicroUsd: stripeNet.toString(), stripeBalanceDifferenceMicroUsd: (stripeGross - fees - stripeNet).toString(),
      sourceReconciliation: [...issues].some(i => /cash|fee_missing/.test(i)) ? 'failed' : 'passed' },
    receiptsByJurisdiction: [...jurisdictions.values()].map(j => ({ country: j.country, state: j.state, considerationMicroUsd: j.consideration.toString(), taxCollectedMicroUsd: j.tax.toString() })),
  };
}

export async function createAccountingClose(env: BillingEnv, month: string, actor: string, policyId?: string) {
  const { end } = monthBounds(month);
  if (end > Date.now()) throw new Error('month_not_finished');
  const policy = policyId ? await env.DB.prepare('SELECT * FROM accounting_policies WHERE id = ?').bind(policyId).first<AccountingPolicy>() : null;
  if (policyId && !policy) throw new Error('policy_not_found');
  const sourceIssues: string[] = [];
  let after = '';
  // Refresh live payment facts, including historical wallet fundings. Stripe
  // evidence is never reconstructed from face credit or a dashboard total.
  while (true) {
    const accounts = await env.DB.prepare('SELECT * FROM prepaid_accounts WHERE user_id > ? ORDER BY user_id LIMIT 100').bind(after).all<PrepaidAccount>();
    for (const account of accounts.results) {
      try {
        const first = await accountBillingRequest<{ fundings: { id: string }[]; pendingEvents: number }>(env, account.user_id, '/billing/accounting-checkpoint', {});
        const receipts = await env.DB.prepare("SELECT json_extract(payload,'$.fundingId') AS id FROM accounting_ledger WHERE user_id = ? AND event_type = 'funding'").bind(account.user_id).all<{ id: string }>();
        const identities = new Set([...first.fundings, ...receipts.results].map(f => f.id));
        for (const id of identities) {
          if (id.startsWith('pi_')) await applyPrepaidPayment(env, account, id, undefined, true);
          else await completePrepaidCheckout(env, account, id);
        }
        const last = await accountBillingRequest<{ pendingEvents: number }>(env, account.user_id, '/billing/accounting-checkpoint', {});
        if (last.pendingEvents) sourceIssues.push(`wallet_outbox_pending:${account.user_id}`);
      } catch { sourceIssues.push(`source_reconciliation_failed:${account.user_id}`); }
    }
    if (accounts.results.length < 100) break;
    after = accounts.results.at(-1)!.user_id;
  }
  const sequence = await ledgerWatermark(env), report = buildAccountingClose(month, await ledgerRows(env, sequence), policy);
  report.issues.push(...sourceIssues); report.issues.sort(); if (report.issues.length) report.status = 'needs_review';
  const id = crypto.randomUUID(), createdAt = Date.now();
  await env.DB.prepare('INSERT INTO accounting_closes (id,month,created_at,created_by,ledger_sequence,policy_id,report) VALUES (?,?,?,?,?,?,?)')
    .bind(id, month, createdAt, actor, sequence, policy?.id ?? null, JSON.stringify(report)).run();
  return { id, createdAt, ledgerSequence: sequence, report };
}
