import { z } from 'zod';
import { cookieSecurity, errors, jsonResponse, register, requestBody, type LegacyHandler, type OpenAPIApi } from './openapi-shared';

const integerText = z.string().regex(/^-?\d+$/).describe('Exact integer. Monetary fields are micro-USD: 1 USD = 1,000,000 micro-USD.');
const month = z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/);
const policyMethod = z.enum(['cash_receipts', 'section_451c']);
const policy = z.object({ id: z.uuid(), created_at: z.number(), created_by: z.string(), method: policyMethod,
  receipt_timezone: z.string(), approved_by: z.string(), evidence_reference: z.string() });
const report = z.object({
  month, periodStart: z.number(), periodEnd: z.number(), calendar: z.literal('UTC'), currency: z.literal('usd'), moneyUnit: z.literal('micro_usd'), computeUnit: z.literal('weighted_millisecond'),
  status: z.enum(['reconciled', 'needs_review']), issues: z.array(z.string()), policyId: z.string().nullable(), taxMethod: z.enum(['unconfirmed', 'cash_receipts', 'section_451c']),
  receiptTimezone: z.string(), allocationMethod: z.string(),
  customerComputeCredits: z.object({ fundedUnitMs: integerText, revokedUnitMs: integerText, consumedUnitMs: integerText, outstandingUnitMs: integerText,
    outstandingCreditCents: z.number(), historicalUnattributedUnitMs: integerText, walletAccountsReconciled: z.number(), sourceReconciliation: z.enum(['failed', 'passed']) }),
  deferredRevenue: z.object({ considerationMicroUsd: integerText, earnedMicroUsd: integerText, monthlyEarnedMicroUsd: integerText, refundsMicroUsd: integerText,
    chargebacksMicroUsd: integerText, contraRevenueMicroUsd: integerText, outstandingMicroUsd: integerText, reconciliationDifferenceMicroUsd: integerText }),
  taxableAdvancePaymentsByReceiptYear: z.array(z.object({ receiptYear: z.string(), considerationMicroUsd: integerText, earnedInReceiptYearMicroUsd: integerText,
    grossIncludedThroughCloseMicroUsd: integerText.nullable(), notYetIncludedMicroUsd: integerText.nullable(), refundsThroughCloseMicroUsd: integerText, chargebacksThroughCloseMicroUsd: integerText })),
  taxReceiptReconciliationDifferenceMicroUsd: integerText,
  refundTaxAdjustmentsByPaymentYear: z.array(z.object({ paymentYear: z.string(), amountMicroUsd: integerText, treatment: z.string() })),
  cash: z.object({ grossReceiptsMicroUsd: integerText, salesTaxCollectedMicroUsd: integerText, salesTaxRefundedMicroUsd: integerText, processingFeesMicroUsd: integerText,
    stripeNetMicroUsd: integerText, stripeBalanceDifferenceMicroUsd: integerText, sourceReconciliation: z.enum(['failed', 'passed']) }),
  receiptsByJurisdiction: z.array(z.object({ country: z.string().nullable(), state: z.string().nullable(), considerationMicroUsd: integerText, taxCollectedMicroUsd: integerText })),
}).openapi('AccountingCloseReport');

export function registerAccountingRoutes(api: OpenAPIApi, handler: LegacyHandler): void {
  const access = 'Requires a browser cookie session for oneone@gmail.com. Monetary values in reports are exact integer micro-USD strings; ledger Stripe amounts are integer USD cents. Records survive user deletion.';
  register(api, 'get', '/admin/accounting/ledger', {
    operationId: 'exportAccountingLedger', tags: ['Admin'], summary: 'Export immutable accounting evidence with a fixed sequence watermark', security: cookieSecurity,
    description: `${access} Defaults to JSON, limit 1000. For subsequent pages reuse throughSequence and nextCursor as after. NDJSON exports expose X-Accounting-Through-Sequence and X-Accounting-Next-Cursor headers (empty cursor means complete). Sequence pagination includes late-recorded historical events; no event is updated or deleted.`,
    request: { query: z.object({ after: z.coerce.number().int().min(0).optional(), throughSequence: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().min(1).max(1000).optional(), format: z.enum(['json', 'ndjson']).optional() }) },
    responses: { 200: { description: 'JSON page or downloadable NDJSON records.', content: {
      'application/json': { schema: z.object({ entries: z.array(z.object({ sequence: z.number(), event_key: z.string(), user_id: z.string(), event_type: z.enum(['funding', 'refund', 'stripe_balance', 'funding_state', 'compute', 'legacy_usage', 'wallet_checkpoint']), occurred_at: z.number(), recorded_at: z.number(), data: z.record(z.string(), z.unknown()) })), throughSequence: z.number(), nextCursor: z.number().nullable() }) },
      'application/x-ndjson': { schema: z.string() },
    } }, ...errors(400, 401, 403, 405, 503) },
  }, handler);
  register(api, 'get', '/admin/accounting/closes', {
    operationId: 'listAccountingCloses', tags: ['Admin'], summary: 'Read saved monthly close revisions', security: cookieSecurity,
    description: `${access} Returns up to 100 revisions newest first, optionally filtered by UTC month. Saved reports never change when late evidence arrives.`,
    request: { query: z.object({ month: month.optional() }) },
    responses: { 200: jsonResponse(z.object({ closes: z.array(z.object({ id: z.uuid(), month, created_at: z.number(), created_by: z.string(), ledger_sequence: z.number(), policy_id: z.string().nullable(), report })) })), ...errors(400, 401, 403, 405, 503) },
  }, handler);
  register(api, 'post', '/admin/accounting/closes', {
    operationId: 'createAccountingClose', tags: ['Admin'], summary: 'Reconcile and save a monthly accounting close revision', security: cookieSecurity,
    description: `${access} Requires trusted Origin. Month must have ended in UTC. Refreshes all prepaid account payment evidence and wallet outboxes before fixing a watermark. Reports compute credit, proportionally allocated deferred revenue, and gross taxable advance inclusion by receipt year independently. Fees and sales tax never enter compute credit or consideration. Missing evidence and unresolved treatments produce needs_review; tax inclusion is null until a CPA-approved policy is selected explicitly. No breakage recognition. Refund tax deductions and dispute classification require CPA review. This is an administrative close operation, not a tax return.`,
    request: { headers: z.object({ Origin: z.string() }), ...requestBody(z.object({ month, policyId: z.string().max(100).optional() }).strict()) },
    responses: { 201: jsonResponse(z.object({ id: z.uuid(), createdAt: z.number(), ledgerSequence: z.number(), report })), ...errors(400, 401, 403, 404, 405, 503) },
  }, handler);
  register(api, 'get', '/admin/accounting/policies', {
    operationId: 'listAccountingPolicies', tags: ['Admin'], summary: 'Read recorded CPA tax-method approvals', security: cookieSecurity,
    description: `${access} Returns up to 100 immutable policies newest first. No method is selected automatically.`,
    responses: { 200: jsonResponse(z.object({ policies: z.array(policy) })), ...errors(400, 401, 403, 405, 503) },
  }, handler);
  register(api, 'post', '/admin/accounting/policies', {
    operationId: 'recordAccountingPolicy', tags: ['Admin'], summary: 'Record a CPA-approved advance-payment tax method and evidence reference', security: cookieSecurity,
    description: `${access} Requires trusted Origin. Store only a method confirmed by the named CPA and a reference to the written approval, including any required election or method change. receiptTimezone is an IANA timezone used for calendar receipt years. This record does not create refund rights, elect a tax method, or implement refundable deposits. A genuine refundable-deposit model requires separate approved terms and operational changes.`,
    request: { headers: z.object({ Origin: z.string() }), ...requestBody(z.object({ method: policyMethod, receiptTimezone: z.string().min(1).max(2000), approvedBy: z.string().min(1).max(2000), evidenceReference: z.string().min(1).max(2000) }).strict()) },
    responses: { 201: jsonResponse(z.object({ id: z.uuid(), createdAt: z.number() })), ...errors(400, 401, 403, 405, 503) },
  }, handler);
}
