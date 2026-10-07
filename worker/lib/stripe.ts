export const PRO_PRICE_ID = "price_1UNAWSGSUs8K8zgHXfnoTiJE";
export const PLAN_PRICES = {
  builder: "price_1UNAovGSUs8K8zgHwUCsCX16",
  pro: PRO_PRICE_ID,
  scale: "price_1UNAq1GSUs8K8zgHnt8PplRQ",
} as const;
export type Plan = keyof typeof PLAN_PRICES;
export function subscriptionPlan(subscription: StripeSubscription | null): Plan | null {
  if (!subscription || subscription.items.has_more || subscription.items.data.length !== 1 || subscription.items.data[0].quantity !== 1) return null;
  return (Object.keys(PLAN_PRICES) as Plan[]).find((plan) =>
    subscription?.items.data.some((item) => item.price.id === PLAN_PRICES[plan]),
  ) || null;
}
export type BillingEnv = Env & { STRIPE_SECRET_KEY?: string; STRIPE_PUBLISHABLE_KEY?: string; STRIPE_WEBHOOK_SECRET?: string };
export interface StripeSubscription {
  id: string;
  status: string;
  cancel_at_period_end?: boolean;
  cancel_at?: number | null;
  pause_collection?: unknown;
  schedule?: string | { id: string } | null;
  customer?: string;
  items: { has_more?: boolean; data: { id?: string; quantity?: number; price: { id: string }; current_period_start?: number; current_period_end?: number }[] };
}
export interface CheckoutSession {
  id: string;
  url: string | null;
  status: string;
  client_secret?: string;
  ui_mode?: string;
  allow_promotion_codes?: boolean | null;
  payment_method_collection?: "always" | "if_required" | null;
  metadata?: Record<string, string>;
  client_reference_id: string;
  customer: string;
  subscription?: StripeSubscription | string | null;
}

// Match Cubacadabra's versioned, form-encoded Stripe REST requests.
export async function stripeRequest<T>(
  env: BillingEnv, path: string, params?: URLSearchParams, idempotencyKey?: string,
): Promise<T> {
  if (!env.STRIPE_SECRET_KEY) throw new Error("billing_unavailable");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
    "Stripe-Version": "2025-04-30.basil",
  };
  if (params) headers["content-type"] = "application/x-www-form-urlencoded";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    method: params ? "POST" : "GET", headers, body: params?.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    console.error("stripe_request_failed", path.split("?")[0], response.status);
    throw new Error("billing_unavailable");
  }
  return response.json() as Promise<T>;
}

export async function billingSubscription(env: BillingEnv, customer: string): Promise<StripeSubscription | null> {
  const params = new URLSearchParams({ customer, status: "all", limit: "100" });
  const subscriptions: StripeSubscription[] = [];
  // Include every page so old canceled subscriptions cannot hide a current plan.
  while (true) {
    const page = await stripeRequest<{ data: StripeSubscription[]; has_more: boolean }>(env, `/subscriptions?${params}`);
    subscriptions.push(...page.data);
    if (!page.has_more || !page.data.length) break;
    params.set("starting_after", page.data[page.data.length - 1].id);
  }
  const knownPrices = new Set<string>(Object.values(PLAN_PRICES));
  const candidates = subscriptions.filter((subscription) => subscription.items.data.some((item) =>
    knownPrices.has(item.price.id))
    && !["canceled", "incomplete_expired"].includes(subscription.status));
  // Ambiguous duplicate live purchases never yield an arbitrarily selected plan.
  if (candidates.length > 1) throw new Error("multiple_subscriptions");
  return candidates[0] || null;
}
