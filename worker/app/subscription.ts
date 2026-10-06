import { redeemTrial } from '../lib/trial-coupons';
import { authCorsHeaders, authJson, currentUser, readJSON, type StringHeaders } from "./auth-core";
import { PLAN_PRICES, subscriptionPlan, billingSubscription, type Plan, stripeRequest, type BillingEnv, type CheckoutSession } from "../lib/stripe";
import { resolveBillingState, syncSubscriptionRecord, type BillingRecord, type BillingState } from "../lib/entitlements";
import { PLAN_DETAILS } from "../../containers/plan-policy.js";
import { PLAN_ORDER, portalSession, releaseScheduledChange, scheduleDowngrade, scheduledChange, scheduleID } from "../lib/billing-changes";
import { handleSubscriptionWebhook, type EntitlementChanged } from "./subscription-webhook";

function validPlan(value: unknown): value is Plan { return typeof value === "string" && Object.hasOwn(PLAN_PRICES, value); }
async function stateResponse(env: BillingEnv, state: BillingState, cors: StringHeaders): Promise<Response> {
  const plan = state.entitlement.plan || subscriptionPlan(state.subscription);
  return authJson({ subscription: state.subscription, trial: state.trial || null, plan, active: state.entitlement.active,
    valid_until: state.entitlement.validUntil, pro: state.entitlement.active && (plan === "pro" || plan === "scale"),
    configured: Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_PUBLISHABLE_KEY), ...await scheduledChange(env, state.subscription) }, 200, cors);
}

export async function handleSubscriptionRequest(request: Request, env: BillingEnv, changed?: EntitlementChanged): Promise<Response> {
  const path = new URL(request.url).pathname;
  // Stripe delivers signed requests without a browser origin or login cookie.
  if (path === "/subscription/webhook") return handleSubscriptionWebhook(request, env, changed);
  const cors = authCorsHeaders(request);
  if (cors === null) return authJson({ error: "origin_not_allowed" }, 403, {});
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (path === "/subscription/config" && request.method === "GET") {
    return authJson({ google_client_id: env.GOOGLE_CLIENT_ID, plans: PLAN_DETAILS,
      configured: Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_PUBLISHABLE_KEY) }, 200, cors);
  }
  if (!["/subscription", "/subscription/trial", "/subscription/checkout", "/subscription/complete", "/subscription/portal", "/subscription/change", "/subscription/cancel", "/subscription/resume"].includes(path)) {
    return authJson({ error: "not_found" }, 404, cors);
  }
  if (request.method !== (path === "/subscription" ? "GET" : "POST")) return authJson({ error: "method_not_allowed" }, 405, cors);
  if (request.method === "POST" && !request.headers.get("Origin")) return authJson({ error: "origin_required" }, 403, cors);
  let lock: { userId: string; token: string } | null = null;
  try {
    const user = await currentUser(env, request);
    // Never sell an orphan subscription; every purchase belongs to this account.
    if (!user) return authJson({ error: "not_authenticated" }, 401, cors);
    const body = request.method === "POST" ? await readJSON(request, 2000) : null;
    if (request.method === "POST" && !body) return authJson({ error: "invalid_request" }, 400, cors);
    if (["/subscription/checkout", "/subscription/trial", "/subscription/change"].includes(path) && !validPlan(body?.plan)) return authJson({ error: "invalid_plan" }, 400, cors);
    if (path === "/subscription/portal" && body?.plan !== undefined && !validPlan(body.plan)) return authJson({ error: "invalid_plan" }, 400, cors);
    if (["/subscription/change", "/subscription/cancel"].includes(path) && body?.confirm !== true) return authJson({ error: "confirmation_required" }, 400, cors);
    if (!["/subscription", "/subscription/complete"].includes(path)) {
      if (!env.STRIPE_SECRET_KEY || (path === "/subscription/checkout" && !env.STRIPE_PUBLISHABLE_KEY)) return authJson({ error: "billing_unavailable" }, 503, cors);
      const now = Date.now();
      const token = crypto.randomUUID();
      const acquired = await env.DB.prepare(`INSERT INTO billing_operation_locks (user_id, lock_token, expires_at)
        VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET lock_token = excluded.lock_token,
        expires_at = excluded.expires_at WHERE billing_operation_locks.expires_at <= ? RETURNING lock_token`)
        .bind(user.id, token, now + 300_000, now).first<{ lock_token: string }>();
      if (acquired?.lock_token !== token) return authJson({ error: "billing_operation_pending" }, 409, cors);
      lock = { userId: user.id, token };
    }
    const origin = cors["access-control-allow-origin"] || "https://mainbrella.com";
    const returnUrl = `${origin}/#pricing`;
    let record = await env.DB.prepare("SELECT stripe_customer_id, checkout_session_id FROM pro_billing WHERE user_id = ?")
      .bind(user.id).first<BillingRecord>();
    if (path === "/subscription/complete") {
      const id = body?.session_id;
      if (typeof id !== "string" || !/^cs_[A-Za-z0-9_]+$/.test(id)) return authJson({ error: "invalid_request" }, 400, cors);
      if (!record) return authJson({ error: "checkout_not_owned" }, 403, cors);
      const session = await stripeRequest<CheckoutSession>(env, `/checkout/sessions/${encodeURIComponent(id)}`);
      if (session.client_reference_id !== user.id || session.customer !== record.stripe_customer_id) return authJson({ error: "checkout_not_owned" }, 403, cors);
      if (session.status !== "complete") return authJson({ error: "checkout_not_complete" }, 409, cors);
    }
    if (path === "/subscription" || path === "/subscription/complete") {
      const state = await resolveBillingState(env, user.id);
      await changed?.(user.id, state.entitlement);
      return stateResponse(env, state, cors);
    }
    if (!env.STRIPE_SECRET_KEY || (path === "/subscription/checkout" && !env.STRIPE_PUBLISHABLE_KEY)) return authJson({ error: "billing_unavailable" }, 503, cors);
    if (path === "/subscription/trial") {
      const state = await resolveBillingState(env, user.id);
      if (state.subscription) return authJson({ error: "subscription_exists" }, 409, cors);
      await redeemTrial(env, user.id, body!.plan as Plan, body!.code);
      const updated = await resolveBillingState(env, user.id);
      await changed?.(user.id, updated.entitlement);
      return stateResponse(env, updated, cors);
    }
    if (path !== "/subscription/checkout") {
      if (!record) return authJson({ error: "no_subscription" }, 409, cors);
      const state = await resolveBillingState(env, user.id);
      const subscription = state.subscription;
      if (path === "/subscription/portal") {
        const target = body?.plan as Plan | undefined;
        if (target) {
          const currentPlan = subscriptionPlan(subscription);
          if (!subscription || !currentPlan || !state.entitlement.active) return authJson({ error: "payment_required" }, 402, cors);
          if (PLAN_ORDER[target] <= PLAN_ORDER[currentPlan]) return authJson({ error: "use_scheduled_change" }, 409, cors);
          if (scheduleID(subscription)) return authJson({ error: "scheduled_change_exists" }, 409, cors);
          if (subscription.cancel_at_period_end) return authJson({ error: "cancellation_pending" }, 409, cors);
        }
        return authJson(await portalSession(env, record.stripe_customer_id, returnUrl, subscription, target), 200, cors);
      }
      if (!subscription) return authJson({ error: "no_subscription" }, 409, cors);
      if (path === "/subscription/change") {
        const plan = body!.plan as Plan;
        const currentPlan = subscriptionPlan(subscription);
        if (!currentPlan || !state.entitlement.active) return authJson({ error: "payment_required" }, 402, cors);
        if (subscription.cancel_at_period_end) return authJson({ error: "cancellation_pending" }, 409, cors);
        if (PLAN_ORDER[plan] > PLAN_ORDER[currentPlan]) return authJson({ error: "use_upgrade_confirmation" }, 409, cors);
        if (plan === currentPlan) await releaseScheduledChange(env, subscription, user.id);
        else await scheduleDowngrade(env, subscription, user.id, plan, lock!.token);
      } else if (path === "/subscription/cancel") {
        await releaseScheduledChange(env, subscription, user.id);
        await stripeRequest(env, `/subscriptions/${encodeURIComponent(subscription.id)}`, new URLSearchParams({ cancel_at_period_end: "true" }));
      } else {
        if (!subscription.cancel_at_period_end) return authJson({ error: "not_canceling" }, 409, cors);
        await stripeRequest(env, `/subscriptions/${encodeURIComponent(subscription.id)}`, new URLSearchParams({ cancel_at_period_end: "false", cancel_at: "" }));
      }
      const updated = await resolveBillingState(env, user.id);
      await changed?.(user.id, updated.entitlement);
      return stateResponse(env, updated, cors);
    }
    const plan = body!.plan as Plan;
    if (!record) {
      const params = new URLSearchParams({ "metadata[app_user_id]": user.id });
      // Checkout inherits this email from the Customer. Stripe fixes it for the
      // session, so the client must not call updateEmail or override it on confirm.
      if (user.email) params.set("email", user.email);
      if (user.name) params.set("name", user.name);
      const customer = await stripeRequest<{ id: string }>(env, "/customers", params, `mainbrella-customer-${user.id}`);
      await env.DB.prepare("INSERT INTO pro_billing (user_id, stripe_customer_id) VALUES (?, ?) ON CONFLICT(user_id) DO NOTHING").bind(user.id, customer.id).run();
      record = await env.DB.prepare("SELECT stripe_customer_id, checkout_session_id FROM pro_billing WHERE user_id = ?").bind(user.id).first<BillingRecord>();
      if (!record) throw new Error("billing_unavailable");
    }
    const existingSubscription = await billingSubscription(env, record.stripe_customer_id);
    await syncSubscriptionRecord(env, user.id, existingSubscription);
    if (existingSubscription) return authJson({ error: "subscription_exists" }, 409, cors);
    if (record.checkout_session_id) {
      const existing = await stripeRequest<CheckoutSession>(env, `/checkout/sessions/${encodeURIComponent(record.checkout_session_id)}`);
      if (existing.status === "open") {
        if (existing.ui_mode === "embedded" && existing.allow_promotion_codes === true && existing.metadata?.plan === plan && existing.client_secret) return authJson({ client_secret: existing.client_secret, publishable_key: env.STRIPE_PUBLISHABLE_KEY }, 200, cors);
        await stripeRequest(env, `/checkout/sessions/${encodeURIComponent(existing.id)}/expire`, new URLSearchParams());
      }
    }
    const params = new URLSearchParams({
      mode: "subscription", ui_mode: "embedded", allow_promotion_codes: "true", "payment_method_types[0]": "card",
      "metadata[plan]": plan, "subscription_data[metadata][plan]": plan,
      customer: record.stripe_customer_id, client_reference_id: user.id,
      "line_items[0][price]": PLAN_PRICES[plan], "line_items[0][quantity]": "1",
      "metadata[app_user_id]": user.id, "subscription_data[metadata][app_user_id]": user.id,
      return_url: `${origin}/?subscription_return=1&session_id={CHECKOUT_SESSION_ID}#pricing`,
    });
    const session = await stripeRequest<CheckoutSession>(env, "/checkout/sessions", params,
      `mainbrella-embedded-promo-checkout-${user.id}-${plan}-${record.checkout_session_id || "initial"}`);
    if (!session.client_secret) throw new Error("billing_unavailable");
    await env.DB.prepare("UPDATE pro_billing SET checkout_session_id = ? WHERE user_id = ?").bind(session.id, user.id).run();
    return authJson({ client_secret: session.client_secret, publishable_key: env.STRIPE_PUBLISHABLE_KEY }, 200, cors);
  } catch (error) {
    const code = error instanceof Error ? error.message : "unknown";
    console.error("subscription_request_failed", code);
    if (code === "invalid_promo_code") return authJson({ error: code }, 400, cors);
    if (code === "trial_already_used") return authJson({ error: code }, 409, cors);
    if (code === "unsupported_schedule") return authJson({ error: "unsupported_schedule" }, 409, cors);
    return authJson({ error: "billing_unavailable" }, 503, cors);
  } finally {
    if (lock) {
      try {
        await env.DB.prepare("DELETE FROM billing_operation_locks WHERE user_id = ? AND lock_token = ?").bind(lock.userId, lock.token).run();
      } catch { console.error("billing_lock_release_failed"); }
    }
  }
}
