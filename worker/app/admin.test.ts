import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { handleRequest } from "./router";
import { hashToken } from "./auth-core";

const LEGACY_ADMIN_ID = "4109eeda-46e0-4ffa-ac57-f1ff81902116";

async function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of ["001_initial.sql", "002_auth_sessions.sql", "003_iop_program_tracking.sql",
    "004_iop_directory.sql", "005_iop_map_index.sql", "006_staff_reviews.sql",
    "007_location_reviews.sql", "008_review_moderation.sql", "009_general_location_reviews.sql",
    "010_tour_requests.sql", "011_native_app_auth.sql", "012_tour_agreed_time.sql",
    "013_backfill_location_main_phone.sql", "014_import_cast_herd.sql",
    "015_herd_recognition_and_push.sql", "016_herd_invariants.sql", "018_program_client_claims.sql"]) {
    sqlite.exec(readFileSync(new URL(`../../migrations/${file}`, import.meta.url), "utf8"));
  }
  const adminID = crypto.randomUUID();
  const memberID = crypto.randomUUID();
  sqlite.prepare("INSERT INTO users (id, name, email) VALUES (?, 'Admin', 'OneOne@Gmail.com')").run(adminID);
  sqlite.prepare("INSERT INTO users (id, name, email, supabase_user_id) VALUES (?, 'Former admin', 'other@example.com', ?)").run(memberID, LEGACY_ADMIN_ID);
  const adminToken = "a".repeat(64);
  const memberToken = "b".repeat(64);
  for (const [token, userID] of [[adminToken, adminID], [memberToken, memberID]]) {
    sqlite.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
      .run(await hashToken(token), userID, "2099-01-01T00:00:00.000Z");
  }
  sqlite.prepare("INSERT INTO herds (id, name) VALUES ('herd-1', 'Alpha'), ('herd-2', 'Beta')").run();
  sqlite.prepare("INSERT INTO herd_memberships (herd_id, user_id, username, role) VALUES ('herd-1', ?, 'Member', 'member')").run(memberID);
  sqlite.prepare("INSERT INTO herd_chat_messages (id, herd_id, user_id, message, sent_at) VALUES (1, 'herd-1', ?, 'private text', '2026-01-01T00:00:00Z')").run(memberID);
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
  async function call(path: string, token?: string, method = "GET") {
    return handleRequest(new Request(`https://api.groupicorn.com${path}`, {
      method,
      headers: { Origin: "http://localhost:5173", ...(token ? { Cookie: `groupicorn_session=${token}` } : {}) },
    }), env);
  }
  return { call, sqlite, adminID, adminToken, memberToken };
}

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
