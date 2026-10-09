import { z } from "zod";
import { usageBillingSchema, usagePricingSchema } from "./openapi-usage-billing";
import { limitsSchema, machineSizeSchema } from "./openapi-containers";
import { cookieSecurity, errors, jsonResponse, planSchema, register, requestBody, type LegacyHandler, type OpenAPIApi } from "./openapi-shared";

const subscriptionState = z.object({
  subscription: z.object({ id: z.string(), status: z.string(), cancel_at_period_end: z.boolean() }).loose().nullable(),
  trial: z.object({ plan: planSchema, expires_at: z.number().describe("Unix milliseconds; access ends automatically without charges.") }).nullable(),
  plan: planSchema.nullable(), active: z.boolean(), valid_until: z.number().nullable().describe("Unix milliseconds."),
  pro: z.boolean(), configured: z.boolean(), scheduled_plan: planSchema.nullable(),
  scheduled_change_at: z.number().nullable().describe("Unix seconds."),
}).openapi("SubscriptionState");

export function registerSubscriptionRoutes(api: OpenAPIApi, handler: LegacyHandler): void {
  register(api, "get", "/subscription/config", {
    operationId: "getSubscriptionConfig", tags: ["Subscriptions"], summary: "Get public plans and billing availability",
    responses: { 200: jsonResponse(z.object({ google_client_id: z.string().optional(), configured: z.boolean(), usage_configured: z.boolean(), usage_pricing: usagePricingSchema,
      plans: z.record(planSchema, z.object({ name: z.string(), price: z.number(), limits: limitsSchema,
        machine: z.object({ instance: z.string(), cpuVcpu: z.number(), memoryMiB: z.number(), diskGB: z.number() }),
        sizes: z.array(machineSizeSchema),
        access: z.object({ maxTerminalConnections: z.number(), maxSSHAccessTokens: z.number(), sshTokenLifetimeMs: z.number() }),
        features: z.record(z.string(), z.boolean()), legacy: z.boolean().optional(), billing: usagePricingSchema.optional(),
      })) })), ...errors(403) },
  }, handler);
  register(api, "get", "/subscription", {
    operationId: "getSubscription", tags: ["Subscriptions"], summary: "Get subscription and paid entitlement", security: cookieSecurity,
    responses: { 200: jsonResponse(subscriptionState), ...errors(401, 403, 503) },
  }, handler);
  register(api, 'get', '/subscription/usage', {
    operationId: 'getUsageBilling', tags: ['Subscriptions'], summary: 'Get current billing-period compute, estimate, spending cap and alerts', security: cookieSecurity,
    responses: { 200: jsonResponse(z.object({ billing: usageBillingSchema.nullable() })), ...errors(401, 403, 503) },
  }, handler);
  register(api, 'post', '/subscription/usage', {
    operationId: 'setUsageSpendLimit', tags: ['Subscriptions'], summary: 'Set the account monthly compute spending cap', security: cookieSecurity,
    description: 'Requires an active usage subscription, browser cookie and trusted Origin. USD cents, $5–$1,000. The default $5 cap prevents overages; raising it requires authorizeOverages:true. A lower cap cannot discard committed runtime; stop machines first. Caps reserve full session runtime and may shorten new sessions. Estimates exclude taxes. Alerts are shown at 50%, 80% and 100%.',
    request: { headers: z.object({ Origin: z.string() }), ...requestBody(z.object({ spendLimitCents: z.number().int().min(500).max(100000), authorizeOverages: z.boolean().optional() })) },
    responses: { 200: jsonResponse(z.object({ billing: usageBillingSchema.nullable() })), ...errors(400, 401, 402, 403, 409, 503) },
  }, handler);
  const mutations = [
    { path: "trial", id: "redeemTrialCoupon", summary: "Redeem a card-free trial coupon; one trial per account", body: z.object({ plan: planSchema, code: z.string().min(4).max(64) }), result: subscriptionState },
    { path: "checkout", id: "createCheckout", summary: "Create or reuse custom Elements checkout with promotion codes and required card collection", body: z.object({ plan: planSchema }),
      result: z.object({ client_secret: z.string(), publishable_key: z.string() }) },
    { path: "complete", id: "completeCheckout", summary: "Verify owned checkout and paid entitlement", body: z.object({ session_id: z.string() }), result: subscriptionState },
    { path: "portal", id: "createBillingPortal", summary: "Open billing portal or confirm an upgrade", body: z.object({ plan: planSchema.optional() }), result: z.object({ url: z.string() }) },
    { path: "change", id: "changeSubscription", summary: "Schedule a downgrade or remove a scheduled downgrade", body: z.object({ plan: planSchema, confirm: z.literal(true) }), result: subscriptionState },
    { path: "cancel", id: "cancelSubscription", summary: "Cancel at the end of the paid period", body: z.object({ confirm: z.literal(true) }), result: subscriptionState },
    { path: "resume", id: "resumeSubscription", summary: "Resume a subscription pending cancellation", body: z.object({}), result: subscriptionState },
  ];
  for (const mutation of mutations) {
    register(api, "post", `/subscription/${mutation.path}`, {
      operationId: mutation.id, tags: ["Subscriptions"], summary: mutation.summary, security: cookieSecurity,
      description: "Requires a browser session cookie and trusted Origin. Bearer automation credentials do not authorize billing mutations. Legacy plans use separate hard-coded Stripe prices in local development; usage billing requires explicitly configured test-mode recurring price. New purchases use the usage plan. Legacy subscriptions can switch to usage at renewal.",
      request: { headers: z.object({ Origin: z.string() }), ...requestBody(mutation.body) },
      responses: { 200: jsonResponse(mutation.result), ...errors(400, 401, 402, 403, 409, 503) },
    }, handler);
  }
  register(api, "post", "/subscription/webhook", {
    operationId: "stripeWebhook", tags: ["Internal"], summary: "Reconcile signed Stripe billing events", security: [{ stripeSignature: [] }],
    request: requestBody(z.object({ id: z.string(), type: z.string(), data: z.object({ object: z.record(z.string(), z.unknown()) }) }).loose()),
    responses: { 200: jsonResponse(z.object({ received: z.boolean() })), ...errors(400, 503) },
  }, handler);
}
