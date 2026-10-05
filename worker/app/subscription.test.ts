import test from "node:test";
import assert from "node:assert/strict";
import { handleSubscriptionRequest } from "./subscription";
import { PRO_PRICE_ID, type BillingEnv } from "../lib/stripe";

function request(path = "/subscription/checkout", origin: string | null = "https://mainbrella.com", method = "POST") {
  return new Request(`https://api.mainbrella.com${path}`, {
    method, headers: origin ? { Origin: origin } : {},
  });
}

const env = {
  STRIPE_SECRET_KEY: "sk_test_example",
  DB: { prepare() { throw new Error("Guest checkout must not require account storage"); } },
} as unknown as BillingEnv;

test("guest checkout uses the fixed Pro plan without an account or pre-created customer", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(input, "https://api.stripe.com/v1/checkout/sessions");
    assert.equal(init?.method, "POST");
    const params = new URLSearchParams(String(init?.body));
    assert.equal(params.get("mode"), "subscription");
    assert.equal(params.get("line_items[0][price]"), PRO_PRICE_ID);
    assert.equal(params.get("line_items[0][quantity]"), "1");
    assert.equal(params.has("customer"), false);
    assert.equal(params.has("client_reference_id"), false);
    assert.equal(params.get("success_url"), "https://mainbrella.com/?subscription_return=1#pricing");
    assert.equal(params.get("cancel_url"), "https://mainbrella.com/?subscription_cancelled=1#pricing");
    return Response.json({ id: "cs_test_guest", url: "https://checkout.stripe.com/guest" });
  });
  const response = await handleSubscriptionRequest(request(), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { url: "https://checkout.stripe.com/guest" });
});

test("guest checkout keeps origin and method restrictions", async (t) => {
  const stripe = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected Stripe request"); });
  assert.equal((await handleSubscriptionRequest(request(undefined, null), env)).status, 403);
  assert.equal((await handleSubscriptionRequest(request(undefined, "https://untrusted.example"), env)).status, 403);
  assert.equal((await handleSubscriptionRequest(request(undefined, undefined, "GET"), env)).status, 405);
  assert.equal(stripe.mock.callCount(), 0);
});

test("subscription status, completion and portal still require authentication", async () => {
  for (const path of ["/subscription", "/subscription/complete", "/subscription/portal"]) {
    const response = await handleSubscriptionRequest(request(path, undefined, path === "/subscription" ? "GET" : "POST"), env);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "not_authenticated" });
  }
});

test("guest checkout handles unavailable billing and missing checkout URLs", async (t) => {
  t.mock.method(console, "error", () => {});
  const stripe = t.mock.method(globalThis, "fetch", async () => Response.json({ id: "cs_test_guest", url: null }));
  const unavailable = await handleSubscriptionRequest(request(), { DB: env.DB } as BillingEnv);
  assert.equal(unavailable.status, 503);
  assert.equal(stripe.mock.callCount(), 0);
  const missingURL = await handleSubscriptionRequest(request(), env);
  assert.equal(missingURL.status, 503);
  assert.deepEqual(await missingURL.json(), { error: "billing_unavailable" });
});
