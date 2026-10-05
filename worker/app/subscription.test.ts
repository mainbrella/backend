import test from "node:test";
import assert from "node:assert/strict";
import { handleSubscriptionRequest } from "./subscription";
import { PRO_PRICE_ID, PLAN_PRICES, billingSubscription, type BillingEnv } from "../lib/stripe";

function request(path = "/subscription/checkout", origin: string | null = "https://mainbrella.com", method = "POST", body: unknown = { plan: "pro" }, authenticated = false) {
  return new Request(`https://api.mainbrella.com${path}`, {
    method, headers: { ...(origin ? { Origin: origin } : {}), ...(authenticated ? { Cookie: "mainbrella_session=test_token" } : {}) },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
}

const env = {
  STRIPE_PUBLISHABLE_KEY: "pk_test_example",
  STRIPE_SECRET_KEY: "sk_test_example",
  DB: { prepare() { throw new Error("Guest checkout must not require account storage"); } },
} as unknown as BillingEnv;

test("guest checkout uses inline Pro checkout without an account or pre-created customer", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(input, "https://api.stripe.com/v1/checkout/sessions");
    assert.equal(init?.method, "POST");
    const params = new URLSearchParams(String(init?.body));
    assert.equal(params.get("mode"), "subscription");
    assert.equal(params.get("line_items[0][price]"), PRO_PRICE_ID);
    assert.equal(params.get("line_items[0][quantity]"), "1");
    assert.equal(params.has("customer"), false);
    assert.equal(params.has("client_reference_id"), false);
    assert.equal(params.get("ui_mode"), "custom");
    assert.equal(params.get("payment_method_types[0]"), "card");
    assert.equal(params.has("success_url"), false);
    assert.equal(params.has("cancel_url"), false);
    assert.equal(params.get("return_url"), "https://mainbrella.com/?subscription_return=1&session_id={CHECKOUT_SESSION_ID}#pricing");
    return Response.json({ id: "cs_test_guest", client_secret: "cs_test_guest_secret" });
  });
  const response = await handleSubscriptionRequest(request(), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { client_secret: "cs_test_guest_secret", publishable_key: "pk_test_example" });
});

test("guest checkout keeps origin and method restrictions", async (t) => {
  const stripe = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected Stripe request"); });
  assert.equal((await handleSubscriptionRequest(request(undefined, null), env)).status, 403);
  assert.equal((await handleSubscriptionRequest(request(undefined, "https://untrusted.example"), env)).status, 403);
  assert.equal((await handleSubscriptionRequest(request(undefined, undefined, "GET"), env)).status, 405);
  assert.equal(stripe.mock.callCount(), 0);
});

test("subscription status and portal still require authentication", async () => {
  for (const path of ["/subscription", "/subscription/portal"]) {
    const response = await handleSubscriptionRequest(request(path, undefined, path === "/subscription" ? "GET" : "POST"), env);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "not_authenticated" });
  }
});

test("guest checkout handles unavailable billing and missing client secrets", async (t) => {
  t.mock.method(console, "error", () => {});
  const stripe = t.mock.method(globalThis, "fetch", async () => Response.json({ id: "cs_test_guest", url: null }));
  const unavailable = await handleSubscriptionRequest(request(), { DB: env.DB } as BillingEnv);
  assert.equal(unavailable.status, 503);
  assert.equal(stripe.mock.callCount(), 0);
  const missingURL = await handleSubscriptionRequest(request(), env);
  assert.equal(missingURL.status, 503);
  assert.deepEqual(await missingURL.json(), { error: "billing_unavailable" });
});

for (const [plan, price] of Object.entries(PLAN_PRICES)) {
  test(`guest checkout selects ${plan} from the server allowlist`, async (t) => {
    t.mock.method(globalThis, "fetch", async (_input: string | URL | Request, init?: RequestInit) => {
      const params = new URLSearchParams(String(init?.body));
      assert.equal(params.get("line_items[0][price]"), price);
      assert.equal(params.get("metadata[plan]"), plan);
      assert.equal(params.get("subscription_data[metadata][plan]"), plan);
      return Response.json({ id: "cs_test_guest", client_secret: "cs_test_secret" });
    });
    assert.equal((await handleSubscriptionRequest(request(undefined, undefined, "POST", { plan }), env)).status, 200);
  });
}

test("invalid plans cannot reach Stripe, including prototype properties and price injection", async (t) => {
  const stripe = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected request"); });
  for (const body of [{}, { plan: "enterprise" }, { plan: "toString" }, { plan: "__proto__" }, { price_id: PRO_PRICE_ID }, { plan: 5 }]) {
    assert.equal((await handleSubscriptionRequest(request(undefined, undefined, "POST", body), env)).status, 400);
  }
  assert.equal(stripe.mock.callCount(), 0);
});

test("inline checkout requires both Stripe keys", async (t) => {
  const stripe = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected request"); });
  const response = await handleSubscriptionRequest(request(), { ...env, STRIPE_PUBLISHABLE_KEY: undefined } as unknown as BillingEnv);
  assert.equal(response.status, 503);
  assert.equal(stripe.mock.callCount(), 0);
});

test("guest completion verifies ownership and actual subscription status", async (t) => {
  let status = "complete";
  let price = PLAN_PRICES.builder as string;
  t.mock.method(globalThis, "fetch", async () => Response.json({
    id: "cs_test_guest", status, client_secret: "cs_test_secret", metadata: { checkout_type: "guest" },
    subscription: { id: "sub_test", status: "active", items: { data: [{ price: { id: price } }] } },
  }));
  const complete = (secret: string) => handleSubscriptionRequest(request("/subscription/complete", undefined, "POST", {
    session_id: "cs_test_guest", client_secret: secret,
  }), env);
  assert.equal((await complete("wrong_secret")).status, 403);
  status = "open";
  assert.equal((await complete("cs_test_secret")).status, 409);
  status = "complete";
  price = "price_unrelated";
  assert.equal((await complete("cs_test_secret")).status, 409);
  price = PLAN_PRICES.builder;
  const result = await complete("cs_test_secret");
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { plan: "builder", active: true });
});

function accountEnv(checkout = "cs_old", writes: { sql: string; values: unknown[] }[] = []) {
  return {
    ...env,
    DB: {
      prepare(sql: string) {
        let values: unknown[] = [];
        return {
          bind(...args: unknown[]) { values = args; return this; },
          async first() { return sql.includes("FROM sessions") ? { id: "user_test", email: "user@example.com", name: "Test" } : { stripe_customer_id: "cus_test", checkout_session_id: checkout }; },
          async run() { writes.push({ sql, values }); return {}; },
        };
      },
    },
  } as unknown as BillingEnv;
}

test("changing plans expires the prior session and creates checkout for the selected price", async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/subscriptions?")) return Response.json({ data: [], has_more: false });
    if (url.endsWith("/cs_old")) return Response.json({ id: "cs_old", status: "open", ui_mode: "custom", metadata: { plan: "pro" }, client_secret: "cs_old_secret" });
    if (url.endsWith("/cs_old/expire")) return Response.json({ id: "cs_old", status: "expired" });
    assert.ok(url.endsWith("/checkout/sessions"));
    const params = new URLSearchParams(String(init?.body));
    assert.equal(params.get("line_items[0][price]"), PLAN_PRICES.scale);
    assert.equal(params.get("customer"), "cus_test");
    assert.ok((init?.headers as Record<string, string>)["Idempotency-Key"].includes("-scale-"));
    return Response.json({ id: "cs_new", client_secret: "cs_new_secret" });
  });
  const result = await handleSubscriptionRequest(request(undefined, undefined, "POST", { plan: "scale" }, true), accountEnv());
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { client_secret: "cs_new_secret", publishable_key: "pk_test_example" });
  assert.equal(calls.length, 4);
});

for (const [plan, price] of Object.entries(PLAN_PRICES)) {
  test(`account completion persists verified ${plan} subscription without a second Stripe lookup`, async (t) => {
    const writes: { sql: string; values: unknown[] }[] = [];
    const subscription = { id: "sub_paid", status: "active", cancel_at_period_end: false,
      items: { data: [{ price: { id: price }, current_period_end: 1800000000 }] } };
    const stripe = t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
      assert.ok(String(input).includes("/checkout/sessions/cs_paid?"));
      return Response.json({ id: "cs_paid", status: "complete", customer: "cus_test",
        client_reference_id: "user_test", subscription });
    });
    const result = await handleSubscriptionRequest(request("/subscription/complete", undefined, "POST",
      { session_id: "cs_paid" }, true), accountEnv("cs_paid", writes));
    assert.equal(result.status, 200);
    const payload = await result.json() as { plan: string; active: boolean };
    assert.equal(payload.plan, plan);
    assert.equal(payload.active, true);
    assert.equal(stripe.mock.callCount(), 1);
    assert.equal(writes.length, 1);
    assert.match(writes[0].sql, /UPDATE pro_billing SET plan/);
    assert.deepEqual(writes[0].values, [plan, "sub_paid", "active", 0, 1800000000, "user_test"]);
  });
}

test("account completion rejects unowned and incomplete sessions without writing billing details", async (t) => {
  const writes: { sql: string; values: unknown[] }[] = [];
  let owner = "another_user";
  let status = "complete";
  t.mock.method(globalThis, "fetch", async () => Response.json({
    id: "cs_paid", status, customer: "cus_test", client_reference_id: owner,
    subscription: { id: "sub_paid", status: "active", items: { data: [{ price: { id: PRO_PRICE_ID } }] } },
  }));
  const complete = () => handleSubscriptionRequest(request("/subscription/complete", undefined, "POST",
    { session_id: "cs_paid" }, true), accountEnv("cs_paid", writes));
  assert.equal((await complete()).status, 403);
  owner = "user_test";
  status = "open";
  assert.equal((await complete()).status, 409);
  assert.equal(writes.length, 0);
});

test("status refresh backfills plans, records payment problems and cancellation, and clears ended subscriptions", async (t) => {
  const writes: { sql: string; values: unknown[] }[] = [];
  let price: string = PLAN_PRICES.builder;
  let status = "active";
  let cancel = false;
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [
    { id: "sub_test", status, cancel_at_period_end: cancel,
      items: { data: [{ price: { id: price }, current_period_end: 1800000000 }] } },
  ], has_more: false }));
  const refresh = () => handleSubscriptionRequest(request("/subscription", undefined, "GET", undefined, true), accountEnv("cs_old", writes));
  assert.equal((await refresh()).status, 200);
  assert.deepEqual(writes.at(-1)?.values, ["builder", "sub_test", "active", 0, 1800000000, "user_test"]);
  price = PLAN_PRICES.scale;
  status = "past_due";
  cancel = true;
  const changed = await refresh();
  assert.equal((await changed.json() as { active: boolean }).active, false);
  assert.deepEqual(writes.at(-1)?.values, ["scale", "sub_test", "past_due", 1, 1800000000, "user_test"]);
  status = "canceled";
  assert.equal((await refresh()).status, 200);
  assert.deepEqual(writes.at(-1)?.values, [null, null, null, 0, null, "user_test"]);
});

test("Stripe failures preserve the last saved subscription", async (t) => {
  const writes: { sql: string; values: unknown[] }[] = [];
  t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async () => new Response("unavailable", { status: 503 }));
  assert.equal((await handleSubscriptionRequest(request("/subscription", undefined, "GET", undefined, true), accountEnv("cs_old", writes))).status, 503);
  assert.equal(writes.length, 0);
});

test("existing Builder or Scale subscriptions block duplicate purchases", async (t) => {
  let price: string = PLAN_PRICES.builder;
  const stripe = t.mock.method(globalThis, "fetch", async () => Response.json({ data: [
    { id: "sub_test", status: "active", items: { data: [{ price: { id: price } }] } },
  ], has_more: false }));
  for (price of [PLAN_PRICES.builder, PLAN_PRICES.scale]) {
    assert.equal((await handleSubscriptionRequest(request(undefined, undefined, "POST", { plan: "pro" }, true), accountEnv())).status, 409);
  }
  assert.equal(stripe.mock.callCount(), 2);
});

test("subscription discovery searches older pages and ignores canceled plans", async (t) => {
  let page = 0;
  t.mock.method(globalThis, "fetch", async () => Response.json(++page === 1 ? {
    data: [{ id: "sub_old", status: "canceled", items: { data: [{ price: { id: PRO_PRICE_ID } }] } }], has_more: true,
  } : {
    data: [{ id: "sub_scale", status: "active", items: { data: [{ price: { id: PLAN_PRICES.scale } }] } }], has_more: false,
  }));
  assert.equal((await billingSubscription(env, "cus_test"))?.id, "sub_scale");
  assert.equal(page, 2);
});
