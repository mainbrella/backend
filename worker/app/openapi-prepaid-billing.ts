import { z } from 'zod';
import { cookieSecurity, errors, jsonResponse, register, requestBody, type LegacyHandler, type OpenAPIApi } from './openapi-shared';

const amount = z.number().int().min(500).max(100000).describe('USD cents.');
const autoRechargeSettings = z.object({ enabled: z.boolean(), amountCents: amount, monthlyLimitCents: amount });
export const prepaidBalanceSchema = z.object({
  balanceCents: z.number(), availableBalanceCents: z.number(), reservedBalanceCents: z.number(), currency: z.literal('usd'),
  spendLimitCents: z.number(), monthlyUsageCents: z.number(), productionHourlyCents: z.number(), fundedRuntimeMs: z.number().nullable(),
  minimumProductionRuntimeMs: z.literal(86400000), autoRecharge: autoRechargeSettings.extend({ spentCents: z.number(), status: z.string() }),
}).openapi('PrepaidBalance');
const result = z.object({ balance: prepaidBalanceSchema });
const resource = z.object({ id: z.string(), containerId: z.string(), name: z.string().nullable(), lifecycle: z.enum(['ad_hoc', 'production']),
  size: z.enum(['lite', 'small', 'medium', 'large', 'xl']), startAt: z.number(), endAt: z.number().nullable(), runtimeMs: z.number(),
  computeUnitHours: z.number(), usedCents: z.number(), reservedCents: z.number(), hourlyCents: z.number(), active: z.boolean() });
const history = z.object({ asOf: z.number(), balance: prepaidBalanceSchema,
  totals: z.object({ fundedCents: z.number(), revokedCents: z.number(), usedCents: z.number(), unattributedUsedCents: z.number() }),
  currentHourlyCents: z.number(), activeResources: z.array(resource), resources: z.array(resource),
  fundings: z.array(z.object({ id: z.string(), createdAt: z.number(), amountCents: z.number(), revokedCents: z.number(), reason: z.enum(['refund', 'dispute']).nullable() })),
  nextResourceCursor: z.string().nullable(), nextFundingCursor: z.string().nullable(), historyTruncated: z.boolean(), retainedResourceLimit: z.literal(256) }).openapi('PrepaidHistory');

export function registerPrepaidBillingRoutes(api: OpenAPIApi, handler: LegacyHandler): void {
  register(api, 'get', '/billing/config', {
    operationId: 'getPrepaidBillingConfig', tags: ['Billing'], summary: 'Get prepaid funding availability and purchase limits',
    responses: { 200: jsonResponse(z.object({ configured: z.boolean(), minTopupCents: z.literal(500), maxTopupCents: z.literal(100000) })), ...errors(403) },
  }, handler);
  register(api, 'get', '/billing/balance', {
    operationId: 'getPrepaidBalance', tags: ['Billing'], summary: 'Get account funding, reserved runtime and monthly spending', security: cookieSecurity,
    description: 'Successful one-time card payments fund compute in advance. Funding carries forward. The spending cap and auto recharge authorization do not add funds. Balance can be negative after a refund or dispute.',
    responses: { 200: jsonResponse(result), ...errors(401, 403, 503) },
  }, handler);
  register(api, 'get', '/billing/history', {
    operationId: 'getPrepaidHistory', tags: ['Billing'], summary: 'Explain prepaid funding and elapsed compute consumption by allocation', security: cookieSecurity,
    description: 'Read-only wallet snapshot with epoch-millisecond asOf, exact fractional consumption cents and lifetime totals. Active allocations are always included separately; currentHourlyCents sums unexpired leases. Completed resources and fundings paginate independently newest-first with returned ID cursors; limit defaults to 50, maximum 100. Retains 256 completed allocations plus current leases. Earlier settled usage and compacted allocations remain exact in unattributedUsedCents; historyTruncated signals unavailable attribution. Resource startAt begins attributable runtime, potentially later than allocation start for older leases. Retained unresolved leases have endAt null and active false after their budget expires. Provisioning and idle time are billed; reservations hold future funds and are not consumption. Funding createdAt is purchase time; revokedCents and reason describe current refund/dispute deductions without invented reversal dates. No Stripe request, guest provisioning, lease renewal or billing mutation occurs. Legacy subscription invoices are not prepaid history.',
    request: { query: z.object({ limit: z.coerce.number().int().min(1).max(100).optional(), resourceCursor: z.string().min(1).max(200).optional(), fundingCursor: z.string().min(1).max(200).optional() }) },
    responses: { 200: jsonResponse(history), ...errors(400, 401, 403, 503) },
  }, handler);
  register(api, 'post', '/billing/topups', {
    operationId: 'createPrepaidTopup', tags: ['Billing'], summary: 'Create or recover embedded Stripe Checkout for a one-time balance purchase', security: cookieSecurity,
    description: 'Requires browser cookie, trusted Origin and configured Stripe publishable key. Send a fresh UUID per purchase and retain it until Checkout returns; repeating the same UUID recovers the same purchase and cannot change its amount. Stripe promotion codes may discount the price while the selected amountCents remains the compute balance purchased. The server verifies the live Checkout subtotal, discount and payment before crediting, including completed no-payment-required orders for 100% discounts. No subscription is created. Compute prices and account limits are the same for every purchase amount. Client-supplied credit amounts never authorize funding.',
    request: { headers: z.object({ Origin: z.string() }), ...requestBody(z.object({ amountCents: amount, requestId: z.uuid() })) },
    responses: { 200: jsonResponse(z.object({ client_secret: z.string(), publishable_key: z.string(), sessionId: z.string() })), ...errors(400, 401, 403, 409, 503) },
  }, handler);
  register(api, 'post', '/billing/topups/complete', {
    operationId: 'completePrepaidTopup', tags: ['Billing'], summary: 'Verify owned Checkout and apply confirmed prepaid funding once', security: cookieSecurity,
    description: 'Requires browser cookie and trusted Origin. The Checkout redirect does not prove payment. Live Checkout subtotal, Stripe discount, ownership and completion are verified. Completed zero-total orders with paid or no_payment_required status and no PaymentIntent fund the selected balance once using their Checkout session ID. Nonzero totals additionally require a verified PaymentIntent and captured card charge with matching currency, amount and refund/dispute state. Refunds revoke the corresponding proportion of purchased compute credit, rounded up; disputes revoke the full credit. Pending payments do not increase the balance.',
    request: { headers: z.object({ Origin: z.string() }), ...requestBody(z.object({ sessionId: z.string().regex(/^cs_[A-Za-z0-9_]+$/) })) },
    responses: { 200: jsonResponse(result), ...errors(400, 401, 403, 409, 503) },
  }, handler);
  register(api, 'post', '/billing/settings', {
    operationId: 'setPrepaidBillingSettings', tags: ['Billing'], summary: 'Set monthly spending cap and optional automatic recharge authorization', security: cookieSecurity,
    description: 'Requires browser cookie and trusted Origin. Enabling automatic recharge explicitly authorizes the stated one-time amount up to the stated monthly maximum, and saving the last verified card. Pending charges count toward the maximum. Cards are never charged beyond available authorization; failed payments never fund runtime.',
    request: { headers: z.object({ Origin: z.string() }), ...requestBody(z.object({ spendLimitCents: amount.optional(), autoRecharge: autoRechargeSettings.optional() })) },
    responses: { 200: jsonResponse(result), ...errors(400, 401, 403, 409, 503) },
  }, handler);
}
