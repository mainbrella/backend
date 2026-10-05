import { authJson } from "./auth-core";
import { resolveEntitlement, type Entitlement } from "../lib/entitlements";
import { stripeRequest, type BillingEnv } from "../lib/stripe";

export type EntitlementChanged = (userId: string, entitlement: Entitlement) => Promise<void>;

export async function verifyStripeSignature(body: string, header: string | null, secret: string, now = Date.now()): Promise<boolean> {
  const parts = (header ?? "").split(",").map((part) => part.split("="));
  const timestamps = parts.filter(([key]) => key === "t");
  if (timestamps.length !== 1 || !/^\d+$/.test(timestamps[0][1] ?? "")) return false;
  const timestamp = Number(timestamps[0][1]);
  if (!Number.isSafeInteger(timestamp) || Math.abs(now / 1000 - timestamp) > 300) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const payload = new TextEncoder().encode(`${timestamp}.${body}`);
  for (const [name, signature] of parts) {
    if (name !== "v1" || !/^[0-9a-f]{64}$/i.test(signature ?? "")) continue;
    const bytes = Uint8Array.from(signature.match(/../g)!, (hex) => parseInt(hex, 16));
    if (await crypto.subtle.verify("HMAC", key, bytes, payload)) return true;
  }
  return false;
}

export async function handleSubscriptionWebhook(request: Request, env: BillingEnv, changed?: EntitlementChanged): Promise<Response> {
  if (request.method !== "POST") return authJson({ error: "method_not_allowed" }, 405, {});
  if (!env.STRIPE_WEBHOOK_SECRET) return authJson({ error: "billing_unavailable" }, 503, {});
  if (Number(request.headers.get("Content-Length") ?? 0) > 262_144) return authJson({ error: "invalid_webhook" }, 400, {});
  const body = await request.text();
  if (new TextEncoder().encode(body).length > 262_144
    || !await verifyStripeSignature(body, request.headers.get("Stripe-Signature"), env.STRIPE_WEBHOOK_SECRET)) {
    return authJson({ error: "invalid_signature" }, 400, {});
  }
  let event: { id: string; type: string; data: { object: { customer?: string | { id: string }; charge?: string } } };
  try {
    event = JSON.parse(body);
    if (!/^evt_[A-Za-z0-9_]+$/.test(event.id) || typeof event.type !== "string" || !event.data?.object) throw new Error();
  } catch { return authJson({ error: "invalid_webhook" }, 400, {}); }
  if (!event.type.startsWith("customer.subscription.") && !event.type.startsWith("subscription_schedule.")
    && !event.type.startsWith("invoice.") && !event.type.startsWith("checkout.session.")
    && !event.type.startsWith("charge.")) return authJson({ received: true }, 200, {});
  try {
    const receipt = await env.DB.prepare("SELECT event_id FROM billing_webhook_events WHERE event_id = ?").bind(event.id).first();
    if (receipt) return authJson({ received: true }, 200, {});
    let customer = typeof event.data.object.customer === "string" ? event.data.object.customer : event.data.object.customer?.id;
    if (!customer && event.type.startsWith("charge.dispute.") && typeof event.data.object.charge === "string") {
      customer = (await stripeRequest<{ customer: string }>(env, `/charges/${encodeURIComponent(event.data.object.charge)}`)).customer;
    }
    const record = customer ? await env.DB.prepare("SELECT user_id FROM pro_billing WHERE stripe_customer_id = ?").bind(customer).first<{ user_id: string }>() : null;
    if (record) {
      // Events can arrive late or out of order. The signed event identifies the
      // account only; live Stripe subscription/invoice state determines access.
      const entitlement = await resolveEntitlement(env, record.user_id);
      await changed?.(record.user_id, entitlement);
    }
    await env.DB.prepare("INSERT INTO billing_webhook_events (event_id, user_id) VALUES (?, ?) ON CONFLICT(event_id) DO NOTHING")
      .bind(event.id, record?.user_id ?? null).run();
    return authJson({ received: true }, 200, {});
  } catch (error) {
    console.error("subscription_webhook_failed", error instanceof Error ? error.message : "unknown");
    // A failed reconciliation or revocation remains retryable; no receipt is saved.
    return authJson({ error: "billing_unavailable" }, 503, {});
  }
}
