import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { handleRequest } from "./router";
import { hashToken } from "./auth-core";

const LEGACY_ADMIN_ID = "4109eeda-46e0-4ffa-ac57-f1ff81902116";

async function fixture({ legacy = true } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of ["001_initial.sql", "002_auth_sessions.sql", "003_pro_billing.sql", "004_subscription_details.sql", "009_trial_coupons.sql", "033_marketing_email_unsubscribe.sql"]) {
    sqlite.exec(readFileSync(new URL(`../../migrations/${file}`, import.meta.url), "utf8"));
  }
  if (legacy) sqlite.exec(readFileSync(new URL('./fixtures/legacy-compatibility.sql', import.meta.url), 'utf8'));
  const adminID = crypto.randomUUID();
  const memberID = crypto.randomUUID();
  sqlite.prepare("INSERT INTO users (id, name, email) VALUES (?, 'Admin', 'OneOne@Gmail.com')").run(adminID);
  if (legacy) {
    sqlite.prepare("INSERT INTO users (id, name, email, supabase_user_id) VALUES (?, 'Former admin', 'other@example.com', ?)").run(memberID, LEGACY_ADMIN_ID);
  } else {
    sqlite.prepare("INSERT INTO users (id, name, email) VALUES (?, 'Member', 'other@example.com')").run(memberID);
  }
  const adminToken = "a".repeat(64);
  const memberToken = "b".repeat(64);
  for (const [token, userID] of [[adminToken, adminID], [memberToken, memberID]]) {
    sqlite.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
      .run(await hashToken(token), userID, "2099-01-01T00:00:00.000Z");
  }
  if (legacy) {
    sqlite.prepare("INSERT INTO herds (id, name) VALUES ('herd-1', 'Alpha'), ('herd-2', 'Beta')").run();
    sqlite.prepare("INSERT INTO herd_memberships (herd_id, user_id, username, role) VALUES ('herd-1', ?, 'Member', 'member')").run(memberID);
    sqlite.prepare("INSERT INTO herd_chat_messages (id, herd_id, user_id, message, sent_at) VALUES (1, 'herd-1', ?, 'private text', '2026-01-01T00:00:00Z')").run(memberID);
  }
  const db = {
    prepare(sql: string) {
      let values: unknown[] = [];
      return {
        bind(...args: unknown[]) { values = args; return this; },
        first() { return sqlite.prepare(sql).get(...values as Parameters<ReturnType<DatabaseSync["prepare"]>["get"]>) ?? null; },
        all() { return { results: sqlite.prepare(sql).all(...values as Parameters<ReturnType<DatabaseSync["prepare"]>["all"]>) }; },
      };
    },
  } as unknown as D1Database;
  const env = { DB: db } as Env;
  async function call(path: string, token?: string, method = "GET", origin = "http://localhost:5173") {
    return handleRequest(new Request(`https://api.groupicorn.com${path}`, {
      method,
      headers: { Origin: origin, ...(token ? { Cookie: `mainbrella_session=${token}` } : {}) },
    }), env);
  }
  return { call, sqlite, env, adminID, adminToken, memberToken };
}

test("marketing users require a current allowlisted cookie session and support trusted CORS", async t => {
  const { call, sqlite, env, adminID, adminToken, memberToken } = await fixture({ legacy: false });
  t.after(() => sqlite.close());
  const path = "/api/get-marketing-users";
  for (const token of [undefined, "unknown", memberToken]) {
    const response = await call(path, token);
    assert.equal(response.status, token === memberToken ? 403 : 401);
    assert.deepEqual(await response.json(), { error: token === memberToken ? "forbidden" : "unauthorized" });
  }
  const bearer = await handleRequest(new Request(`https://api.mainbrella.com${path}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  }), env);
  assert.equal(bearer.status, 401);
  assert.equal((await call(path, adminToken, "GET", "https://example.com")).status, 403);
  for (const method of ["POST", "HEAD", "PUT", "DELETE"]) {
    const response = await call(path, adminToken, method);
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get("allow"), "GET");
  }
  const preflight = await call(path, undefined, "OPTIONS", "https://raindrop.mainbrella.com");
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-credentials"), "true");
  assert.match(preflight.headers.get("access-control-allow-methods")!, /GET/);
  const response = await call(path, adminToken, "GET", "https://raindrop.mainbrella.com");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://raindrop.mainbrella.com");
  assert.equal(response.headers.get("cache-control"), "no-store");
  sqlite.prepare("UPDATE users SET email = 'new@example.com' WHERE id = ?").run(adminID);
  assert.equal((await call(path, adminToken)).status, 403);
  sqlite.prepare("UPDATE users SET email = 'oneone@gmail.com' WHERE id = ?").run(adminID);
  sqlite.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'").run();
  assert.equal((await call(path, adminToken)).status, 401);
});

test("marketing users exclude user and normalized address opt-outs without exposing private fields", async t => {
  const { call, sqlite, adminToken } = await fixture({ legacy: false });
  t.after(() => sqlite.close());
  sqlite.exec(readFileSync(new URL("../../migrations/012_email_password.sql", import.meta.url), "utf8"));
  sqlite.prepare("UPDATE users SET created_at = '2025-01-01T00:00:00.000Z', google_sub = 'private-' || id, password_hash = 'private-hash'").run();
  sqlite.prepare("UPDATE users SET marketing_email_unsubscribed = 1 WHERE email = 'other@example.com'").run();
  sqlite.prepare("INSERT INTO marketing_email_unsubscribes (email) VALUES ('address@example.com'), ('later@example.com')").run();
  const users = [
    { id: "eligible", email: "Eligible@Example.com", unsubscribed: 0 },
    { id: "flag-only", email: "flag@example.com", unsubscribed: 1 },
    { id: "shared-flag", email: " FLAG@EXAMPLE.COM ", unsubscribed: 0 },
    { id: "address-only", email: " Address@Example.com ", unsubscribed: 0 },
    { id: "later-account", email: "LATER@example.com", unsubscribed: 0 },
    { id: "no-email", email: null, unsubscribed: 0 },
  ];
  for (const { id, email, unsubscribed } of users) {
    sqlite.prepare("INSERT INTO users (id, email, marketing_email_unsubscribed, created_at) VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z')")
      .run(id, email, unsubscribed);
  }
  const response = await call("/api/get-marketing-users?limit=1", adminToken);
  assert.equal(response.status, 200);
  const data = await response.json() as { users: Record<string, unknown>[]; total: number; offset: number; limit: number };
  assert.equal(data.total, 3);
  assert.equal(data.offset, 0);
  assert.equal(data.limit, 1);
  assert.equal(data.users.length, 1);
  assert.deepEqual(data.users[0], { id: "no-email", email: null, name: "Player", created_at: "2026-01-01T00:00:00.000Z" });
  const all = await (await call("/api/get-marketing-users", adminToken)).json() as { users: Record<string, unknown>[]; total: number };
  assert.equal(all.total, 3);
  assert.deepEqual(all.users.map(user => user.email), [null, "Eligible@Example.com", "OneOne@Gmail.com"]);
  for (const user of all.users) assert.deepEqual(Object.keys(user).sort(), ["created_at", "email", "id", "name"]);
});

test("marketing users paginate newest first with stable ties, filtered totals and empty pages", async t => {
  const { call, sqlite, adminToken } = await fixture({ legacy: false });
  t.after(() => sqlite.close());
  sqlite.prepare("UPDATE users SET created_at = '2025-01-01T00:00:00.000Z'").run();
  for (let index = 0; index < 30; index++) {
    sqlite.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)")
      .run(`user-${String(index).padStart(2, "0")}`, `user${index}@example.com`, index < 15 ? "2026-01-01T00:00:00.000Z" : "2026-02-01T00:00:00.000Z");
  }
  const page = async (query = "") => {
    const response = await call(`/api/get-marketing-users${query}`, adminToken);
    assert.equal(response.status, 200);
    return response.json() as Promise<{ users: { id: string }[]; total: number; offset: number; limit: number }>;
  };
  const first = await page();
  assert.equal(first.limit, 25);
  assert.equal(first.offset, 0);
  assert.equal(first.total, 32);
  assert.equal(first.users.length, 25);
  assert.equal(first.users[0].id, "user-29");
  assert.equal(first.users[15].id, "user-14");
  assert.equal(first.users[24].id, "user-05");
  const next = await page("?offset=25");
  assert.equal(next.total, 32);
  assert.equal(next.offset, 25);
  assert.equal(next.limit, 25);
  assert.equal(next.users.length, 7);
  assert.equal(next.users[0].id, "user-04");
  assert.equal(new Set([...first.users, ...next.users].map(user => user.id)).size, 32);
  const custom = await page("?offset=14&limit=3");
  assert.deepEqual(custom.users.map(user => user.id), ["user-15", "user-14", "user-13"]);
  assert.equal(custom.limit, 3);
  assert.equal(custom.offset, 14);
  assert.equal(custom.total, 32);
  assert.equal((await page("?limit=100")).users.length, 32);
  for (const offset of [32, 1_000_000]) {
    assert.deepEqual(await page(`?offset=${offset}`), { users: [], total: 32, offset, limit: 25 });
  }
  sqlite.prepare("UPDATE users SET marketing_email_unsubscribed = 1").run();
  assert.deepEqual(await page(), { users: [], total: 0, offset: 0, limit: 25 });
});

test("marketing users reject malformed and out-of-range pagination", async t => {
  const { call, sqlite, adminToken } = await fixture({ legacy: false });
  t.after(() => sqlite.close());
  for (const [name, values] of [
    ["offset", ["", "-1", "1.5", "1e2", "+1", " 1", "NaN", "Infinity", "1000001", "9007199254740992", "0 UNION SELECT 1"]],
    ["limit", ["", "0", "-1", "1.5", "1e2", "+1", " 1", "NaN", "Infinity", "101", "9007199254740992"]],
  ] as const) {
    for (const value of values) {
      const response = await call(`/api/get-marketing-users?${name}=${encodeURIComponent(value)}`, adminToken);
      assert.equal(response.status, 400, `${name}=${value}`);
      assert.deepEqual(await response.json(), { error: `invalid_${name}` });
    }
  }
});

test("marketing users return a safe unavailable error when authentication or preferences cannot be read", async t => {
  const { call, sqlite, env, adminToken } = await fixture({ legacy: false });
  t.after(() => sqlite.close());
  t.mock.method(console, "error", () => {});
  const prepare = env.DB.prepare.bind(env.DB);
  let failedQuery = "FROM sessions";
  t.mock.method(env.DB, "prepare", (sql: string) => {
    if (sql.includes(failedQuery)) throw new Error("Private database details");
    return prepare(sql);
  });
  for (const query of ["FROM sessions", "SELECT COUNT(*)", "SELECT users.id, users.email, users.name, users.created_at FROM users"]) {
    failedQuery = query;
    const response = await call("/api/get-marketing-users", adminToken);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:5173");
    assert.deepEqual(await response.json(), { error: "admin_unavailable" });
  }
});

test("admin users require a current allowlisted session and a trusted origin", async () => {
  const { call, sqlite, adminID, adminToken, memberToken } = await fixture({ legacy: false });
  assert.equal((await call("/admin/users")).status, 401);
  assert.equal((await call("/admin/users", memberToken)).status, 403);
  assert.equal((await call("/admin/users", adminToken, "GET", "https://example.com")).status, 403);
  assert.equal((await call("/admin/users", adminToken, "POST")).status, 405);
  const preflight = await call("/admin/users", undefined, "OPTIONS", "https://raindrop.mainbrella.com");
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-credentials"), "true");
  const response = await call("/admin/users", adminToken, "GET", "https://raindrop.mainbrella.com");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://raindrop.mainbrella.com");
  assert.equal(response.headers.get("cache-control"), "no-store");
  sqlite.prepare("UPDATE users SET email = 'new@example.com' WHERE id = ?").run(adminID);
  assert.equal((await call("/admin/users", adminToken)).status, 403);
  sqlite.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'").run();
  assert.equal((await call("/admin/users", adminToken)).status, 401);
});

test("admin users work with the production schema and return all users newest first without credentials", async () => {
  const { call, sqlite, adminToken } = await fixture({ legacy: false });
  sqlite.exec(readFileSync(new URL("../../migrations/012_email_password.sql", import.meta.url), "utf8"));
  sqlite.prepare("UPDATE users SET created_at = '2025-01-01T00:00:00.000Z', google_sub = 'private-' || id, password_hash = 'private-hash'").run();
  for (let index = 0; index < 30; index++) {
    sqlite.prepare("INSERT INTO users (id, name, created_at) VALUES (?, ?, ?)")
      .run(`user-${String(index).padStart(2, '0')}`, `User ${index}`, index < 15 ? '2026-01-01T00:00:00.000Z' : '2026-02-01T00:00:00.000Z');
  }
  const response = await call("/admin/users", adminToken);
  assert.equal(response.status, 200);
  const { users } = await response.json() as { users: Record<string, unknown>[] };
  assert.equal(users.length, 32);
  assert.equal(users[0].id, 'user-29');
  assert.equal(users[15].id, 'user-14');
  for (const user of users) {
    assert.deepEqual(Object.keys(user).sort(), ['created_at', 'dob', 'email', 'id', 'name', 'plan']);
    assert.equal(user.plan, 'none');
  }
});

test("admin users include stored active subscription and trial plan levels", async () => {
  const { call, sqlite, adminToken } = await fixture({ legacy: false });
  const now = Date.now();
  const cases = [
    { id: 'builder', plan: 'builder', status: 'active', end: now + 86400000, expected: 'builder' },
    { id: 'pro', plan: 'pro', status: 'active', end: now + 86400000, expected: 'pro' },
    { id: 'scale', plan: 'scale', status: 'active', end: now + 86400000, expected: 'scale' },
    { id: 'expired', plan: 'pro', status: 'active', end: now - 1000, expected: 'none' },
    { id: 'canceled', plan: 'scale', status: 'canceled', end: now + 86400000, expected: 'none' },
    { id: 'past-due', plan: 'builder', status: 'past_due', end: now + 86400000, expected: 'none' },
    { id: 'missing-plan', plan: null, status: 'active', end: now + 86400000, expected: 'none' },
  ];
  for (const item of cases) {
    sqlite.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run(item.id, item.id);
    sqlite.prepare(`INSERT INTO pro_billing (user_id, stripe_customer_id, stripe_subscription_id, plan, subscription_status, current_period_end)
      VALUES (?, ?, ?, ?, ?, ?)`).run(item.id, `cus_${item.id}`, `sub_${item.id}`, item.plan, item.status, Math.floor(item.end / 1000));
  }
  sqlite.prepare(`INSERT INTO trial_coupons (code_hash, plan, trial_days, expires_at, max_redemptions)
    VALUES ('trial-code', 'pro', 7, ?, 10)`).run(now + 86400000);
  for (const id of ['trial', 'expired-trial', 'checkout-trial']) {
    sqlite.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run(id, id);
  }
  sqlite.prepare(`INSERT INTO pro_billing (user_id, stripe_customer_id) VALUES ('checkout-trial', 'cus_checkout')`).run();
  for (const id of ['trial', 'expired-trial', 'checkout-trial', 'scale', 'canceled']) {
    sqlite.prepare(`INSERT INTO trial_redemptions (user_id, code_hash, plan, redeemed_at, expires_at)
      VALUES (?, 'trial-code', 'pro', ?, ?)`).run(id, now - 86400000, id === 'expired-trial' ? now - 1000 : now + 86400000);
  }
  const response = await call('/admin/users', adminToken);
  assert.equal(response.status, 200);
  const { users } = await response.json() as { users: { id: string; plan: string }[] };
  const plans = new Map(users.map(user => [user.id, user.plan]));
  for (const { id, expected } of cases) assert.equal(plans.get(id), expected, id);
  assert.equal(plans.get('trial'), 'pro');
  assert.equal(plans.get('expired-trial'), 'none');
  assert.equal(plans.get('checkout-trial'), 'pro');
});

test("admin table reads require a session for oneone@gmail.com", async () => {
  const { call, sqlite, adminID, adminToken, memberToken } = await fixture();
  assert.equal((await call("/admin/tables")).status, 401);
  assert.equal((await call("/admin/tables", memberToken)).status, 403);
  const response = await call("/admin/tables", adminToken);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const data = await response.json() as { tables: { id: string }[] };
  assert.ok(data.tables.some((table) => table.id === "herds"));
  assert.equal((await call("/admin/tables", adminToken, "POST")).status, 405);
  assert.equal((await call("/admin/tables/sessions", adminToken)).status, 404);
  sqlite.prepare("UPDATE users SET email = 'new@example.com' WHERE id = ?").run(adminID);
  assert.equal((await call("/admin/tables", adminToken)).status, 403);
});

test("admin rows are searchable, paginated, and omit private chat content", async () => {
  const { call, adminToken } = await fixture();
  const herds = await call("/admin/tables/herds?q=Alpha&offset=0", adminToken);
  assert.equal(herds.status, 200);
  const data = await herds.json() as { total: number; items: { name: string }[] };
  assert.equal(data.total, 1);
  assert.deepEqual(data.items.map((row) => row.name), ["Alpha"]);
  const later = await call("/admin/tables/herds?offset=1", adminToken);
  assert.equal((await later.json() as { items: unknown[] }).items.length, 1);
  const chats = await call("/admin/tables/community-chat", adminToken);
  assert.equal(chats.status, 200);
  const chatData = await chats.json() as { items: Record<string, unknown>[] };
  assert.equal(chatData.items.length, 1);
  assert.equal(chatData.items[0].message, undefined);
  assert.equal((await call("/admin/tables/herds?offset=-1", adminToken)).status, 400);
});
