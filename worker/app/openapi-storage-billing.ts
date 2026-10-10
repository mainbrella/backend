import { z } from 'zod';
import { cookieSecurity, errors, jsonResponse, register, requestBody, type LegacyHandler, type OpenAPIApi } from './openapi-shared';

export const storagePricingSchema = z.object({
  mode: z.enum(['off', 'meter', 'charge']), markupBps: z.number(), maxBytes: z.number(), chargeFrom: z.number().nullable(),
  storageUsdPerGbMonth: z.literal(0.015), classAUsdPerMillion: z.literal(4.5), classBUsdPerMillion: z.literal(0.36), retentionDays: z.literal(7),
});
export const storageSummarySchema = z.object({ month: z.string(), maxBytes: z.number(), pricing: storagePricingSchema, projects: z.array(z.object({ appId: z.string(), name: z.string().nullable(), storedBytes: z.number(), sourceAssetsBytes: z.number(), historyBytes: z.number(),
  chargedCents: z.number(), estimatedMonthlyCents: z.number(), cloudflareCents: z.number(), markupCents: z.number(), adjustmentCents: z.number(),
  writes: z.number(), reads: z.number(), fundedThrough: z.number().nullable(), writesBlocked: z.boolean() })) }).openapi('StorageBillingSummary');
const nano = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const invoice = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), month: z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/), evidenceReference: z.string().min(1).max(2000),
  providerNanoUsd: z.object({ storage: nano, classA: nano, classB: nano }).strict(),
  additionalPlatformUsage: z.object({ byteDays: nano, classA: nano, classB: nano }).strict() }).strict();
const reconciliation = z.object({ invoice, platformNanoUsd: nano,
  allocations: z.array(z.object({ userId: z.string(), appId: z.string(), providerNanoUsd: nano, markupNanoUsd: nano, costNanoUsd: nano,
    provisionalNanoUsd: nano, adjustmentNanoUsd: z.number().int() })) });
export function registerStorageBillingRoutes(api: OpenAPIApi, handler: LegacyHandler) {
  register(api, 'get', '/billing/storage', { operationId: 'getStorageBilling', tags: ['Billing'], security: cookieSecurity,
    summary: 'Get retained Storage and Git usage by project',
    description: 'Storage consumes balance while files/history remain retained, including stopped apps. Meter mode records usage without deductions. Daily deductions start prospectively at chargeFrom, use Standard daily peaks over 30 days plus provider operations, and are provisional until category invoice reconciliation. Funded seven-day retention is reserved before growth; failed renewal blocks writes, leaves exports available until fundedThrough, then deletes retained source/history. Estimates exclude account free-tier and billing-unit adjustments; egress and deletes are free.',
    responses: { 200: jsonResponse(storageSummarySchema), ...errors(400, 401, 403, 503) } }, handler);
  register(api, 'get', '/admin/accounting/storage-invoices', { operationId: 'listStorageInvoices', tags: ['Admin'], security: cookieSecurity,
    summary: 'List immutable R2 invoice allocations', description: 'Admin only. Includes provider evidence, separately allocated Mainbrella costs, markup and customer adjustments.',
    responses: { 200: jsonResponse(z.object({ invoices: z.array(reconciliation) })), ...errors(400, 401, 403, 503) } }, handler);
  register(api, 'post', '/admin/accounting/storage-invoices', { operationId: 'reconcileStorageInvoice', tags: ['Admin'], security: cookieSecurity,
    summary: 'Reconcile an actual shared-account Standard R2 invoice',
    description: 'Admin cookie and trusted Origin required. Submit final category invoice costs in integer nano-USD, including shared free-tier/rounding, with an evidence reference and additional unmetered Mainbrella byte-days/operations. Finished months only, after metering and daily receipts settle. Allocation uses proportional measured usage and deterministic largest-remainder rounding. Uncharged usage belongs to Mainbrella. One immutable invoice per month; identical retries return the original allocation, changed evidence returns 409. Adjustment receipts settle through the existing wallet, with negative amounts returning previously deducted balance.',
    request: { headers: z.object({ Origin: z.string() }), ...requestBody(invoice) },
    responses: { 201: jsonResponse(reconciliation), ...errors(400, 401, 403, 409, 503) } }, handler);
}
