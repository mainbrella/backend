import { authCorsHeaders, authJson, currentUser, readJSON } from "./auth-core";
import { PLAN_PRICES, subscriptionPlan, billingSubscription, type Plan, stripeRequest, type BillingEnv, type CheckoutSession } from "../lib/stripe";

interface BillingRecord { stripe_customer_id: string; checkout_session_id: string | null }

export async function handleSubscriptionRequest(request: Request, env: BillingEnv): Promise<Response> {
  const cors = authCorsHeaders(request);
  if (cors === null) return authJson({ error: "origin_not_allowed" }, 403, {});
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const path = new URL(request.url).pathname;
  if (path === "/subscription/config" && request.method === "GET") {
    return authJson({ google_client_id: env.GOOGLE_CLIENT_ID, configured: Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_PUBLISHABLE_KEY) }, 200, cors);
  }
  if (!(["/subscription", "/subscription/checkout", "/subscription/complete", "/subscription/portal"].includes(path))) {
    return authJson({ error: "not_found" }, 404, cors);
  }
  if (request.method !== (path === "/subscription" ? "GET" : "POST")) {
    return authJson({ error: "method_not_allowed" }, 405, cors);
  }
  // Cookie-authenticated billing mutations must have a trusted browser origin.
  if (request.method === "POST" && !request.headers.get("Origin")) {
    return authJson({ error: "origin_required" }, 403, cors);
  }
  try {
    let plan: Plan = "pro";
    if (path === "/subscription/checkout") {
      const body = await readJSON(request, 2000);
      if (!body || typeof body.plan !== "string" || !Object.hasOwn(PLAN_PRICES, body.plan)) {
        return authJson({ error: "invalid_plan" }, 400, cors);
      }
      plan = body.plan as Plan;
      if (!env.STRIPE_SECRET_KEY || !env.STRIPE_PUBLISHABLE_KEY) {
        return authJson({ error: "billing_unavailable" }, 503, cors);
      }
    }
    const user = await currentUser(env, request);
    if (!user && path === "/subscription/checkout") {
      const origin = request.headers.get("Origin")!;
      const session = await stripeRequest<CheckoutSession>(env, "/checkout/sessions", new URLSearchParams({
        mode: "subscription", ui_mode: "custom",
        "payment_method_types[0]": "card",
        "metadata[plan]": plan, "subscription_data[metadata][plan]": plan,
        "line_items[0][price]": PLAN_PRICES[plan], "line_items[0][quantity]": "1",
        "metadata[checkout_type]": "guest", "subscription_data[metadata][checkout_type]": "guest",
        return_url: `${origin}/?subscription_return=1&session_id={CHECKOUT_SESSION_ID}#pricing`,
      }));
      if (!session.client_secret) throw new Error("billing_unavailable");
      return authJson({ client_secret: session.client_secret, publishable_key: env.STRIPE_PUBLISHABLE_KEY }, 200, cors);
    }
    if (!user && path === "/subscription/complete") {
      const body = await readJSON(request, 2000);
      if (typeof body?.session_id !== "string" || !/^cs_[A-Za-z0-9_]+$/.test(body.session_id)
        || typeof body.client_secret !== "string" || !body.client_secret) {
        return authJson({ error: "invalid_request" }, 400, cors);
      }
      const session = await stripeRequest<CheckoutSession>(env, `/checkout/sessions/${body.session_id}?expand[]=subscription`);
      if (session.metadata?.checkout_type !== "guest" || session.client_secret !== body.client_secret) {
        return authJson({ error: "checkout_not_owned" }, 403, cors);
      }
      if (session.status !== "complete" || !subscriptionPlan(session.subscription || null)) {
        return authJson({ error: "checkout_not_complete" }, 409, cors);
      }
      return authJson({ plan: subscriptionPlan(session.subscription || null), active: ["active", "trialing"].includes(session.subscription?.status || "") }, 200, cors);
    }
    if (!user) return authJson({ error: "not_authenticated" }, 401, cors);
    if (!env.STRIPE_SECRET_KEY) return authJson({ error: "billing_unavailable" }, 503, cors);
    let record = await env.DB.prepare("SELECT stripe_customer_id, checkout_session_id FROM pro_billing WHERE user_id = ?")
      .bind(user.id).first<BillingRecord>();
    const origin = request.headers.get("Origin") || "https://mainbrella.com";
    const returnUrl = `${origin}/#pricing`;
    if (path === "/subscription/complete") {
      const body = await readJSON(request, 2000);
      const id = body?.session_id;
      if (typeof id !== "string" || !/^cs_[A-Za-z0-9_]+$/.test(id)) {
        return authJson({ error: "invalid_request" }, 400, cors);
      }
      const session = await stripeRequest<CheckoutSession>(env, `/checkout/sessions/${id}?expand[]=subscription`);
      if (session.client_reference_id !== user.id || session.customer !== record?.stripe_customer_id) {
        return authJson({ error: "checkout_not_owned" }, 403, cors);
      }
      if (session.status !== "complete" || !subscriptionPlan(session.subscription || null)) {
        return authJson({ error: "checkout_not_complete" }, 409, cors);
      }
    }
    if (path === "/subscription" || path === "/subscription/complete") {
      const subscription = record ? await billingSubscription(env, record.stripe_customer_id) : null;
      const active = ["active", "trialing"].includes(subscription?.status || "");
      const plan = subscriptionPlan(subscription);
      return authJson({ subscription, plan, active, pro: active && plan === "pro", configured: true }, 200, cors);
    }
    if (path === "/subscription/portal") {
      if (!record) return authJson({ error: "no_subscription" }, 409, cors);
      const session = await stripeRequest<{ url: string }>(env, "/billing_portal/sessions", new URLSearchParams({
        customer: record.stripe_customer_id, return_url: returnUrl,
      }));
      return authJson({ url: session.url }, 200, cors);
    }
    if (!record) {
      const params = new URLSearchParams({ "metadata[app_user_id]": user.id });
      if (user.email) params.set("email", user.email);
      if (user.name) params.set("name", user.name);
      const customer = await stripeRequest<{ id: string }>(env, "/customers", params, `mainbrella-customer-${user.id}`);
      await env.DB.prepare("INSERT INTO pro_billing (user_id, stripe_customer_id) VALUES (?, ?) ON CONFLICT(user_id) DO NOTHING")
        .bind(user.id, customer.id).run();
      record = await env.DB.prepare("SELECT stripe_customer_id, checkout_session_id FROM pro_billing WHERE user_id = ?")
        .bind(user.id).first<BillingRecord>();
      if (!record) throw new Error("billing_unavailable");
    }
    if (await billingSubscription(env, record.stripe_customer_id)) {
      return authJson({ error: "subscription_exists" }, 409, cors);
    }
    if (record.checkout_session_id) {
      const existing = await stripeRequest<CheckoutSession>(env, `/checkout/sessions/${record.checkout_session_id}`);
      if (existing.status === "open") {
        if (existing.ui_mode === "custom" && existing.metadata?.plan === plan && existing.client_secret) {
          return authJson({ client_secret: existing.client_secret, publishable_key: env.STRIPE_PUBLISHABLE_KEY }, 200, cors);
        }
        await stripeRequest(env, `/checkout/sessions/${existing.id}/expire`, new URLSearchParams());
      }
    }
    const params = new URLSearchParams({
      mode: "subscription", ui_mode: "custom", "payment_method_types[0]": "card",
      "metadata[plan]": plan, "subscription_data[metadata][plan]": plan,
      customer: record.stripe_customer_id, client_reference_id: user.id,
      "line_items[0][price]": PLAN_PRICES[plan], "line_items[0][quantity]": "1",
      "metadata[app_user_id]": user.id, "subscription_data[metadata][app_user_id]": user.id,
      return_url: `${origin}/?subscription_return=1&session_id={CHECKOUT_SESSION_ID}#pricing`,
    });
    const session = await stripeRequest<CheckoutSession>(env, "/checkout/sessions", params,
      `mainbrella-inline-checkout-${user.id}-${plan}-${record.checkout_session_id || "initial"}`);
    if (!session.client_secret) throw new Error("billing_unavailable");
    await env.DB.prepare("UPDATE pro_billing SET checkout_session_id = ? WHERE user_id = ?")
      .bind(session.id, user.id).run();
    return authJson({ client_secret: session.client_secret, publishable_key: env.STRIPE_PUBLISHABLE_KEY }, 200, cors);
  } catch (error) {
    console.error("subscription_request_failed", error instanceof Error ? error.message : "unknown");
    return authJson({ error: "billing_unavailable" }, 503, cors);
  }
}
