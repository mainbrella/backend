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
  register(api, 'post', '/billing/topups', {
    operationId: 'createPrepaidTopup', tags: ['Billing'], summary: 'Create or recover hosted Stripe Checkout for a one-time balance purchase', security: cookieSecurity,
    description: 'Requires browser cookie and trusted Origin. Send a fresh UUID per purchase and retain it until Checkout returns; repeating the same UUID recovers the same purchase and cannot change its amount. Payment is verified before crediting. No subscription is created. Each dollar paid adds one dollar of balance, with the same compute prices and account limits for every purchase amount. Client-supplied credit amounts never authorize funding.',
    request: { headers: z.object({ Origin: z.string() }), ...requestBody(z.object({ amountCents: amount, requestId: z.uuid() })) },
    responses: { 200: jsonResponse(z.object({ url: z.url(), sessionId: z.string() })), ...errors(400, 401, 403, 409, 503) },
  }, handler);
  register(api, 'post', '/billing/topups/complete', {
    operationId: 'completePrepaidTopup', tags: ['Billing'], summary: 'Verify owned Checkout and apply confirmed prepaid funding once', security: cookieSecurity,
    description: 'Requires browser cookie and trusted Origin. The Checkout redirect does not prove payment. Current PaymentIntent, charge, currency, capture, ownership and refund/dispute status are verified on the server. Pending payments do not increase the balance.',
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
