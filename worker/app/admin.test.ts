import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { handleRequest } from "./router";
import { hashToken } from "./auth-core";

const LEGACY_ADMIN_ID = "4109eeda-46e0-4ffa-ac57-f1ff81902116";

async function fixture({ legacy = true } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of ["001_initial.sql", "002_auth_sessions.sql"]) {
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
  return { call, sqlite, adminID, adminToken, memberToken };
}

test("admin users require a current allowlisted session and a trusted origin", async () => {
  const { call, sqlite, adminID, adminToken, memberToken } = await fixture({ legacy: false });
  assert.equal((await call("/admin/users")).status, 401);
  assert.equal((await call("/admin/users", memberToken)).status, 403);
  assert.equal((await call("/admin/users", adminToken, "GET", "https://example.com")).status, 403);
  assert.equal((await call("/admin/users", adminToken, "POST")).status, 405);
  const preflight = await call("/admin/users", undefined, "OPTIONS", "https://raincoat.mainbrella.com");
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-credentials"), "true");
  const response = await call("/admin/users", adminToken, "GET", "https://raincoat.mainbrella.com");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://raincoat.mainbrella.com");
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
    assert.deepEqual(Object.keys(user).sort(), ['created_at', 'dob', 'email', 'id', 'name']);
  }
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
