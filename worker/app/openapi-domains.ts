import { z } from 'zod';
import { cookieSecurity, errors, jsonResponse, register, requestBody, type LegacyHandler, type OpenAPIApi } from './openapi-shared';
import { checkoutSchema, quoteSchema, settingsSchema, recordSchema, contactSchema } from './domain-schemas';
const order = z.object({ id: z.string().uuid(), domainName: z.string(), projectId: z.string().uuid().nullable(), kind: z.enum(['registration', 'renewal']),
  years: z.number().int(), amountCents: z.number().int(), renewalCents: z.number().int(), premium: z.boolean(), autoRenew: z.boolean(),
  status: z.enum(['quoted','checkout','charging','paid','fulfilling','registered','connecting','complete','refunding','refunded','expired','review']), error: z.string().nullable(), expiresAt: z.number() });
const record = z.object({ id: z.number().int(), type: z.string(), host: z.string().nullable(), answer: z.string(), ttl: z.number().int(), priority: z.number().optional() });
const domainQuery = z.object({ domainName: z.string() });
const registrarDomain = z.object({ domainName: z.string(), expireDate: z.string(), privacyEnabled: z.boolean(), locked: z.boolean(),
  locks: z.array(z.string()).optional(), transferLockExpiresAt: z.string().optional(), nameservers: z.array(z.string()),
  contacts: z.object({ registrant: contactSchema.passthrough().extend({ isVerified: z.boolean().optional(), verificationId: z.number().nullable().optional() }) }).passthrough(),
  autoRenew: z.boolean(), renewalCents: z.number().int() }).passthrough();
export function registerDomainRoutes(api: OpenAPIApi, handler: LegacyHandler) {
  const common = { tags: ['Domains'], security: cookieSecurity,
    description: 'Requires a browser session. Mutations require a trusted Origin. Only the owning account can inspect, purchase, or manage registrations. Local development uses Name.com sandbox and Stripe test credentials. Registrar secrets never reach browsers.' };
  const response = (schema: z.ZodType, status = 200) => ({ [status]: jsonResponse(schema), ...errors(400,401,403,404,409,429,503) });
  register(api, 'get', '/domains/config', { ...common, operationId: 'getDomainRegistrarConfig', summary: 'Inspect domain purchase availability',
    responses: response(z.object({ configured: z.boolean(), sandbox: z.boolean(), tlds: z.array(z.string()), canConnect: z.boolean() })) }, handler);
  register(api, 'get', '/domains', { ...common, operationId: 'listRegisteredDomains', summary: 'List purchased domains and pending orders', responses: response(z.object({
    domains: z.array(z.object({ domainName: z.string(), projectId: z.string().nullable(), expireDate: z.string(), autoRenew: z.boolean(), renewalCents: z.number(), error: z.string().nullable() })), orders: z.array(order) })) }, handler);
  register(api, 'post', '/domains/search', { ...common, operationId: 'searchDomains', summary: 'Search registration inventory with USD prices',
    request: requestBody(z.object({ keyword: z.string().min(1).max(100) })), responses: response(z.object({ results: z.array(z.object({ domainName: z.string(), premium: z.boolean(), amountCents: z.number(), renewalCents: z.number() })) })) }, handler);
  register(api, 'post', '/domains/quote', { ...common, operationId: 'quoteDomainOrder', summary: 'Create an authoritative registration or renewal quote',
    description: common.description + ' Quotes expire in 15 minutes. Supports ASCII .com, .net, .org, .app, .dev, .xyz registrations and terms of 1–10 years where supported. IDNs, special requirements, claims, and aftermarket inventory are excluded. Renewal price is annual. Domain ownership survives project deletion.',
    request: requestBody(quoteSchema), responses: response(z.object({ order }),201) }, handler);
  register(api, 'post', '/domains/checkout', { ...common, operationId: 'createDomainCheckout', summary: 'Open or resume Stripe checkout for an owned quote',
    description: common.description + ' Supply the same order ID to retry. Prices are rechecked; registration contacts and terms consent are required. Saves a card for consented annual renewals. Auto-renew charges 30 days before expiry and never exceeds the accepted renewal amount. Registrar auto-renew is disabled so registrar credit cannot renew an unpaid order.',
    request: requestBody(checkoutSchema), responses: response(z.object({ order, clientSecret: z.string().optional(), publishableKey: z.string().optional() })) }, handler);
  register(api, 'get', '/domains/order', { ...common, operationId: 'getDomainOrder', summary: 'Inspect and reconcile a domain purchase',
    description: common.description + ' Live Stripe state, paid amount, currency, customer, and order metadata must match before registration. Persisted idempotency keys and leases prevent concurrent purchases. Definitive registration rejection triggers a Stripe refund; uncertain results enter review after the retry window. Configures apex ANAME or static A/AAAA records, www, ownership TXT, and certificates through project hosting.',
    request: { query: z.object({ id: z.string().uuid() }) }, responses: response(z.object({ order })) }, handler);
  register(api, 'get', '/domains/detail', { ...common, operationId: 'getRegisteredDomain', summary: 'Inspect registration contacts, verification, DNS and locks',
    request: { query: domainQuery }, responses: response(z.object({ domain: registrarDomain, projectId: z.string().nullable(), projects: z.array(z.object({ id: z.string(), name: z.string() })), records: z.array(record) })) }, handler);
  register(api, 'post', '/domains/connect', { ...common, operationId: 'connectRegisteredDomain', summary: 'Connect or disconnect a purchased domain and project',
    description: common.description + ' A null projectId disconnects hosting while preserving registration, DNS mail records and renewals. A project ID connects the root and www hostnames with automatic DNS and HTTPS setup. Only owned projects are accepted; pending purchases must finish first.',
    request: { query: domainQuery, ...requestBody(z.object({ projectId: z.string().uuid().nullable() }).strict()) },
    responses: response(z.object({ order: order.optional(), disconnected: z.literal(true).optional() })) }, handler);
  register(api, 'patch', '/domains/settings', { ...common, operationId: 'updateRegisteredDomain', summary: 'Change renewal, privacy, contacts or transfer lock',
    request: requestBody(settingsSchema), responses: response(z.object({ saved: z.literal(true) })) }, handler);
  register(api, 'post', '/domains/verification', { ...common, operationId: 'resendDomainContactVerification', summary: 'Resend registrant email verification',
    request: { query: domainQuery }, responses: response(z.object({ sent: z.literal(true) })) }, handler);
  register(api, 'post', '/domains/records', { ...common, operationId: 'createRegisteredDomainDnsRecord', summary: 'Add a DNS record alongside managed hosting records',
    request: { query: domainQuery, ...requestBody(recordSchema) }, responses: response(z.object({ record }),201) }, handler);
  register(api, 'delete', '/domains/records', { ...common, operationId: 'deleteRegisteredDomainDnsRecord', summary: 'Remove a user DNS record',
    description: common.description + ' Protects MainBrella ownership records and apex/www routing while a project is connected.',
    request: { query: domainQuery.extend({ recordId: z.string().regex(/^\d+$/) }) }, responses: response(z.object({ deleted: z.literal(true) })) }, handler);
  register(api, 'post', '/domains/auth-code', { ...common, operationId: 'getRegisteredDomainTransferCode', summary: 'Reveal the EPP code for an unlocked domain',
    request: { query: domainQuery }, responses: response(z.object({ authCode: z.string() })) }, handler);
}
