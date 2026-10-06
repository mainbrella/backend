import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { handleRequest } from "./router";
import { findOrCreateGoogleUser } from "./auth-core";

function fixture(t: test.TestContext) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const file of ["001_initial.sql", "002_auth_sessions.sql", "012_email_password.sql"]) {
    sqlite.exec(readFileSync(new URL(`../../migrations/${file}`, import.meta.url), "utf8"));
  }
  let limited = false;
  const keys: string[] = [];
  const env = {
    EMAIL_AUTH_LIMIT: { async limit({ key }: { key: string }) { keys.push(key); return { success: !limited }; } },
    DB: { prepare(sql: string) {
      let values: unknown[] = [];
      return {
        bind(...args: unknown[]) { values = args; return this; },
        async first() { return sqlite.prepare(sql).get(...values as Parameters<ReturnType<DatabaseSync["prepare"]>["get"]>) ?? null; },
        async run() { return sqlite.prepare(sql).run(...values as Parameters<ReturnType<DatabaseSync["prepare"]>["run"]>); },
      };
    } },
  } as unknown as Env;
  const login = (email: unknown = "person@example.com", password: unknown = "a strong password", origin = "https://mainbrella.com") =>
    handleRequest(new Request("https://api.mainbrella.com/auth/email", {
      method: "POST", headers: { "content-type": "application/json", Origin: origin, "CF-Connecting-IP": "192.0.2.1" },
      body: JSON.stringify({ email, password }),
    }), env);
  return { sqlite, env, login, keys, setLimited() { limited = true; } };
}

test("email form creates an account, stores only a salted hash, and establishes a browser session", async t => {
  const f = fixture(t);
  const first = await f.login(" Person@Example.COM ");
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("cache-control"), "no-store");
  assert.equal(first.headers.get("access-control-allow-origin"), "https://mainbrella.com");
  const body = await first.json() as { user: { id: string; email: string; password_hash?: string } };
  assert.equal(body.user.email, "person@example.com");
  assert.equal(body.user.password_hash, undefined);
  const stored = f.sqlite.prepare("SELECT password_hash FROM users WHERE id = ?").get(body.user.id)?.password_hash;
  assert.match(String(stored), /^scrypt:16384:8:5:[a-f0-9]{32}:[a-f0-9]{64}$/);
  assert.ok(!String(stored).includes("a strong password"));
  const cookie = first.headers.get("set-cookie")!;
  assert.match(cookie, /HttpOnly; SameSite=None; Secure/);
  const me = await handleRequest(new Request("https://api.mainbrella.com/auth/me", {
    headers: { Cookie: cookie.split(";")[0] },
  }), f.env);
  assert.deepEqual(await me.json(), body);
  const repeat = await f.login("PERSON@example.com");
  assert.equal(repeat.status, 200);
  assert.deepEqual(await repeat.json(), body);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS count FROM users").get()?.count, 1);
  const wrong = await f.login("person@example.com", "wrong password");
  assert.equal(wrong.status, 401);
  assert.deepEqual(await wrong.json(), { error: "invalid_credentials" });
  assert.equal(wrong.headers.get("set-cookie"), null);
  assert.equal(f.sqlite.prepare("SELECT password_hash FROM users WHERE id = ?").get(body.user.id)?.password_hash, stored);
  await f.login("other@example.com");
  assert.notEqual(f.sqlite.prepare("SELECT password_hash FROM users WHERE email = ?").get("other@example.com")?.password_hash, stored);
});

test("new accounts require valid email and bounded passwords", async t => {
  const f = fixture(t);
  for (const [email, password, error] of [
    ["invalid", "password123", "invalid_request"], ["user@example.com", "short", "weak_password"],
    ["user@example.com", "", "invalid_request"], ["user@example.com", "x".repeat(129), "invalid_request"],
    [null, "password123", "invalid_request"], ["user@example.com", null, "invalid_request"],
  ]) {
    const response = await f.login(email, password);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error });
  }
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS count FROM users").get()?.count, 0);
});

test("provider accounts cannot be claimed with a password and password accounts do not auto-link to Google", async t => {
  const f = fixture(t);
  f.sqlite.prepare("INSERT INTO users (id, email, google_sub) VALUES (?, ?, ?)").run("google", "Google@Example.com", "google-sub");
  const response = await f.login("GOOGLE@example.com");
  assert.equal(response.status, 401);
  assert.equal(f.sqlite.prepare("SELECT password_hash FROM users WHERE id = ?").get("google")?.password_hash, null);
  await f.login();
  await assert.rejects(findOrCreateGoogleUser(f.env, {
    googleSub: "another-sub", email: "person@example.com", name: "Person",
  }), { status: 409 });
  assert.equal(f.sqlite.prepare("SELECT google_sub FROM users WHERE email = ?").get("person@example.com")?.google_sub, null);
});

test("concurrent signups only authenticate the password that created the account", async t => {
  const f = fixture(t);
  const responses = await Promise.all([f.login("race@example.com", "password one"), f.login("race@example.com", "password two")]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 401]);
  const winner = responses[0].status === 200 ? "password one" : "password two";
  assert.equal((await f.login("race@example.com", winner)).status, 200);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS count FROM users").get()?.count, 1);
  const same = await Promise.all([f.login("same@example.com"), f.login("same@example.com")]);
  assert.deepEqual(same.map(response => response.status), [200, 200]);
});

test("rate limits and untrusted origins reject email auth before creating accounts", async t => {
  const f = fixture(t);
  assert.equal((await f.login("person@example.com", "password123", "https://untrusted.example")).status, 403);
  assert.equal(f.keys.length, 0);
  f.setLimited();
  const response = await f.login();
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "60");
  assert.deepEqual(f.keys, ["email:192.0.2.1"]);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS count FROM users").get()?.count, 0);
});
