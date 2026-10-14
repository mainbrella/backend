import { z } from 'zod';
import { cookieSecurity, errors, jsonResponse, register, requestBody, type LegacyHandler, type OpenAPIApi } from './openapi-shared';
import { prepaidBalanceSchema } from './openapi-prepaid-billing';

export function registerAppleIAPRoutes(api: OpenAPIApi, handler: LegacyHandler): void {
  register(api, 'get', '/billing/apple/config', {
    operationId: 'getAppleComputeCredit', tags: ['Billing'], summary: 'Get net compute credit and a stable App Store account token', security: cookieSecurity,
    description: 'Quote MAINBRELLA_FIVE against a server-controlled USD proceeds policy for the exact storefront and price in milliunits. Credit is Apple net proceeds after commission and applicable taxes, rounded down to whole cents; no Stripe fees apply. Unsupported or unconfigured prices fail before purchase. App account token is bound to the authenticated account. Local Xcode testing requires LOCAL_DEV, explicit opt-in and a loopback request.',
    request: { query: z.object({ storefront: z.string().regex(/^[A-Z]{3}$/), currency: z.string().regex(/^[A-Z]{3}$/), priceMilliunits: z.coerce.number().int().positive() }) },
    responses: { 200: jsonResponse(z.object({ productId: z.literal('MAINBRELLA_FIVE'), appAccountToken: z.uuid(), creditCents: z.number().int().positive(), currency: z.literal('usd') })), ...errors(400, 401, 403, 409, 503) },
  }, handler);
  register(api, 'post', '/billing/apple/transactions', {
    operationId: 'completeAppleComputeCredit', tags: ['Billing'], summary: 'Verify an owned Apple consumable and deliver its net credit once', security: cookieSecurity,
    description: 'Requires account cookie and trusted Origin. Verify Apple signature, bundle, environment, consumable product, quantity, purchase price and appAccountToken; refresh the transaction from Apple before delivery to detect refunds. Production accepts Production only; Sandbox belongs on a separate local development backend. Persist the original net proceeds policy and deduplicate globally by environment and transaction ID. Credit the same prepaid wallet used by web purchases, independently of Stripe availability. Refunds revoke net credit proportionally, rounded up; older successes cannot restore revoked credit. Finish the StoreKit transaction only after this response succeeds. No client-provided credit or price authorizes funding.',
    request: { headers: z.object({ Origin: z.string() }), ...requestBody(z.object({ signedTransactionInfo: z.string().min(1).max(60000) })) },
    responses: { 200: jsonResponse(z.object({ balance: prepaidBalanceSchema, creditedCents: z.number().int().nonnegative(), transactionId: z.string() })), ...errors(400, 401, 403, 409, 503) },
  }, handler);
  register(api, 'post', '/billing/apple/notifications', {
    operationId: 'receiveAppleBillingNotification', tags: ['Billing'], summary: 'Receive authenticated App Store Server Notifications V2', security: [],
    description: 'Apple JWS signature, certificate chain, environment, bundle and app ID authenticate this webhook; no account cookie is used. Verify the embedded transaction and refresh it from Apple. Apply funding or refund revocation idempotently to the account bound to appAccountToken. Xcode payloads are rejected. Transient verification or delivery failures return 503 so Apple retries.',
    request: requestBody(z.object({ signedPayload: z.string().min(1).max(60000) })),
    responses: { 200: jsonResponse(z.object({ ok: z.literal(true) })), ...errors(400, 403, 409, 503) },
  }, handler);
}
