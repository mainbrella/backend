import { planPrices, stripeRequest, subscriptionPlan, type BillingEnv, type Plan, type StripeSubscription } from "./stripe";

export const PLAN_ORDER: Record<Plan, number> = { usage: -1, builder: 0, pro: 1, scale: 2 };
interface SchedulePhase extends Record<string, unknown> {
  start_date: number; end_date: number;
  items: { price: string | { id: string }; quantity: number; [key: string]: unknown }[];
}
interface Schedule { id: string; status: string; customer?: string; subscription?: string; metadata?: Record<string, string>; phases: SchedulePhase[] }
export function scheduleID(subscription: StripeSubscription): string | null {
  return typeof subscription.schedule === "string" ? subscription.schedule : subscription.schedule?.id ?? null;
}

export async function scheduledChange(env: BillingEnv, subscription: StripeSubscription | null): Promise<{ scheduled_plan: Plan | null; scheduled_change_at: number | null }> {
  const id = subscription && scheduleID(subscription);
  if (!id) return { scheduled_plan: null, scheduled_change_at: null };
  const schedule = await stripeRequest<Schedule>(env, `/subscription_schedules/${encodeURIComponent(id)}`);
  const future = schedule.phases.find((phase) => phase.start_date > Date.now() / 1000);
  const price = future?.items[0]?.price;
  const priceId = typeof price === "string" ? price : price?.id;
  const plan = (Object.keys(planPrices(env)) as Plan[]).find((key) => planPrices(env)[key] === priceId) ?? null;
  return { scheduled_plan: plan, scheduled_change_at: plan ? future!.start_date : null };
}

async function managedSchedule(env: BillingEnv, subscription: StripeSubscription, userId: string): Promise<Schedule | null> {
  const id = scheduleID(subscription);
  if (!id) return null;
  const schedule = await stripeRequest<Schedule>(env, `/subscription_schedules/${encodeURIComponent(id)}`);
  if (schedule.metadata?.app_user_id !== userId) {
    // Recover an interrupted from_subscription conversion before metadata was
    // saved. An existing future schedule or another owner is never adopted.
    const phase = schedule.phases[0];
    const price = phase?.items[0]?.price;
    const priceId = typeof price === "string" ? price : price?.id;
    if (schedule.metadata?.app_user_id || schedule.subscription !== subscription.id
      || schedule.customer !== subscription.customer || schedule.status !== "active" || schedule.phases.length !== 1
      || phase.items.length !== 1 || phase.items[0].quantity !== 1 || priceId !== subscription.items.data[0].price.id
      || phase.end_date !== subscription.items.data[0].current_period_end) throw new Error("unsupported_schedule");
    await stripeRequest(env, `/subscription_schedules/${encodeURIComponent(schedule.id)}`, new URLSearchParams({ "metadata[app_user_id]": userId }));
  }
  return schedule;
}

export async function releaseScheduledChange(env: BillingEnv, subscription: StripeSubscription, userId: string): Promise<void> {
  const schedule = await managedSchedule(env, subscription, userId);
  if (schedule) await stripeRequest(env, `/subscription_schedules/${encodeURIComponent(schedule.id)}/release`,
    new URLSearchParams({ preserve_cancel_date: "true" }));
}

function appendForm(params: URLSearchParams, key: string, value: unknown): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    if (!value.length) params.set(key, "");
    else value.forEach((entry, index) => appendForm(params, `${key}[${index}]`, entry));
  } else if (typeof value === "object") {
    for (const [name, entry] of Object.entries(value)) appendForm(params, `${key}[${name}]`, entry);
  } else params.set(key, String(value));
}

function writablePhase(phase: SchedulePhase): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  // Keep billing settings returned by from_subscription, including discounts
  // and tax/payment collection. Read-only response fields aren't sent back.
  for (const field of ["application_fee_percent", "automatic_tax", "billing_cycle_anchor", "collection_method", "default_payment_method",
    "default_tax_rates", "description", "invoice_settings", "metadata", "on_behalf_of", "transfer_data"]) {
    if (phase[field] !== null && phase[field] !== undefined) result[field] = phase[field];
  }
  if (Array.isArray(phase.default_tax_rates)) result.default_tax_rates = phase.default_tax_rates.map(objectID);
  if (Array.isArray(phase.discounts)) result.discounts = phase.discounts.map(writableDiscount);
  result.items = phase.items.map((item) => ({ price: typeof item.price === "string" ? item.price : item.price.id, quantity: item.quantity,
    ...(Array.isArray(item.tax_rates) ? { tax_rates: item.tax_rates.map(objectID) } : {}),
    ...(Array.isArray(item.discounts) ? { discounts: item.discounts.map(writableDiscount) } : {}),
    ...(item.metadata ? { metadata: item.metadata } : {}),
  }));
  return result;
}

function objectID(value: unknown): unknown { return typeof value === "string" ? value : (value as { id?: string })?.id; }
function writableDiscount(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return { discount: value };
  const discount = value as Record<string, unknown>;
  for (const name of ["discount", "coupon", "promotion_code"]) if (discount[name]) return { [name]: objectID(discount[name]) };
  throw new Error("unsupported_schedule");
}

export async function scheduleDowngrade(env: BillingEnv, subscription: StripeSubscription, userId: string, plan: Plan, operationToken: string): Promise<void> {
  const end = subscription.items.data[0].current_period_end!;
  let schedule = await managedSchedule(env, subscription, userId);
  if (!schedule) {
    schedule = await stripeRequest<Schedule>(env, "/subscription_schedules", new URLSearchParams({ from_subscription: subscription.id }),
      `mainbrella-schedule-${subscription.id}-${operationToken}`);
  }
  const current = schedule.phases.find((phase) => phase.start_date <= Date.now() / 1000 && phase.end_date > Date.now() / 1000);
  if (!current || current.items.length !== 1) throw new Error("unsupported_schedule");
  const params = new URLSearchParams({ end_behavior: "release", proration_behavior: "none", "metadata[app_user_id]": userId });
  appendForm(params, "phases[0]", { ...writablePhase(current), start_date: current.start_date, end_date: end, proration_behavior: "none" });
  const future = writablePhase(current);
  const futureItem = (future.items as Record<string, unknown>[])[0];
  appendForm(params, "phases[1]", { ...future, start_date: end, iterations: 1, proration_behavior: "none",
    items: [{ ...futureItem, price: planPrices(env)[plan], quantity: 1 }], metadata: { ...((current.metadata as Record<string, string>) ?? {}), plan, app_user_id: userId } });
  await stripeRequest(env, `/subscription_schedules/${encodeURIComponent(schedule.id)}`, params);
}

export async function portalSession(env: BillingEnv, customer: string, returnUrl: string, subscription: StripeSubscription | null, plan?: Plan): Promise<{ url: string }> {
  const configParams = new URLSearchParams({
    "features[invoice_history][enabled]": "true", "features[payment_method_update][enabled]": "true",
    "features[subscription_cancel][enabled]": "false", // app cancellation also releases pending downgrades
    "features[subscription_update][enabled]": plan ? "true" : "false",
  });
  if (plan) {
    const price = await stripeRequest<{ product: string }>(env, `/prices/${planPrices(env)[plan]}`);
    configParams.set("features[subscription_update][default_allowed_updates][0]", "price");
    configParams.set("features[subscription_update][proration_behavior]", "always_invoice");
    configParams.set("features[subscription_update][products][0][product]", price.product);
    configParams.set("features[subscription_update][products][0][prices][0]", planPrices(env)[plan]);
  }
  const config = await stripeRequest<{ id: string }>(env, "/billing_portal/configurations", configParams,
    `mainbrella-portal-v2-${plan ?? "manage"}-${Math.floor(Date.now() / 86_400_000)}`);
  const params = new URLSearchParams({ customer, return_url: returnUrl, configuration: config.id });
  if (plan && subscription) {
    const item = subscription.items.data[0];
    if (!item.id || !subscriptionPlan(subscription, env)) throw new Error("billing_unavailable");
    params.set("flow_data[type]", "subscription_update_confirm");
    params.set("flow_data[subscription_update_confirm][subscription]", subscription.id);
    params.set("flow_data[subscription_update_confirm][items][0][id]", item.id);
    params.set("flow_data[subscription_update_confirm][items][0][price]", planPrices(env)[plan]);
    params.set("flow_data[subscription_update_confirm][items][0][quantity]", "1");
    params.set("flow_data[after_completion][type]", "redirect");
    params.set("flow_data[after_completion][redirect][return_url]", returnUrl);
  }
  return stripeRequest(env, "/billing_portal/sessions", params);
}
