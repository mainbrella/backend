import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "./router";

test("health returns an OK JSON response", async () => {
  const response = await handleRequest(
    new Request("https://api.groupicorn.com/health"),
    {} as Env,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("unknown routes return not found", async () => {
  const response = await handleRequest(
    new Request("https://api.groupicorn.com/unknown"),
    {} as Env,
  );

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "not_found" });
});

test("state rejects non-GET requests", async () => {
  const response = await handleRequest(
    new Request("https://api.groupicorn.com/state", { method: "POST" }),
    {} as Env,
  );

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET");
});

test("routes from omitted source features return not found", async () => {
  for (const path of ["/iop/tracked-programs", "/directory/locations", "/herds", "/iap/apple/notifications"]) {
    const response = await handleRequest(
      new Request(`https://api.groupicorn.com${path}`),
      {} as Env,
    );
    assert.equal(response.status, 404, path);
    assert.deepEqual(await response.json(), { error: "not_found" }, path);
  }
});

test("auth preflight allows the web origin", async () => {
  const response = await handleRequest(
    new Request("https://api.groupicorn.com/auth/google", {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:5173" },
    }),
    {} as Env,
  );

  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:5173");
  assert.equal(response.headers.get("access-control-allow-credentials"), "true");
});

test("auth rejects an unknown origin", async () => {
  const response = await handleRequest(
    new Request("https://api.groupicorn.com/auth/me", {
      headers: { Origin: "https://example.com" },
    }),
    {} as Env,
  );

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "origin_not_allowed" });
});

test("auth me returns an empty session without a cookie", async () => {
  const response = await handleRequest(
    new Request("https://api.groupicorn.com/auth/me"),
    {} as Env,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { user: null });
});

test("production auth origins retain credentialed CORS for empty, expired and unavailable sessions", async () => {
  for (const origin of ["https://mainbrella.com", "https://www.mainbrella.com"]) {
    for (const state of ["empty", "expired", "unavailable"]) {
      const env = state === "empty" ? {} : { DB: {
        prepare() { return { bind() { return { async first() {
          if (state === "unavailable") throw new Error("Test database outage");
          return null;
        } }; } }; },
      } };
      const originalError = console.error;
      // The handler logs database failures; keep this expected outage quiet.
      console.error = () => {};
      let response;
      try {
        response = await handleRequest(new Request("https://api.mainbrella.com/auth/me", {
          headers: { Origin: origin, ...(state === "empty" ? {} : { Cookie: "mainbrella_session=expired" }) },
        }), env as unknown as Env);
      } finally { console.error = originalError; }
      assert.equal(response.status, state === "unavailable" ? 503 : 200);
      assert.equal(response.headers.get("access-control-allow-origin"), origin);
      assert.equal(response.headers.get("access-control-allow-credentials"), "true");
      assert.equal(response.headers.get("vary"), "Origin");
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), state === "unavailable" ? { error: "auth_unavailable" } : { user: null });
    }
    const preflight = await handleRequest(new Request("https://api.mainbrella.com/auth/google", {
      method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type" },
    }), {} as Env);
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
    assert.equal(preflight.headers.get("access-control-allow-credentials"), "true");
  }
});

test("email auth rejects invalid credentials before touching the database", async () => {
  const response = await handleRequest(
    new Request("https://api.groupicorn.com/auth/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "wrong@example.com", password: "wrong" }),
    }),
    {} as Env,
  );

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "invalid_credentials" });
});
