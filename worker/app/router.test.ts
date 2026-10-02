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

test("IOP tracking requires an authenticated session", async () => {
  const response = await handleRequest(
    new Request("https://api.groupicorn.com/iop/tracked-programs"),
    {} as Env,
  );

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "unauthorized" });
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
