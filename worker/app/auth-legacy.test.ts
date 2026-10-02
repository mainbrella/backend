import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { handleRequest } from "./router";

function database() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const file of ["001_initial.sql", "004_iop_directory.sql", "011_native_app_auth.sql", "014_import_cast_herd.sql"]) {
    sqlite.exec(readFileSync(new URL(`../../migrations/${file}`, import.meta.url), "utf8"));
  }
  const db = {
    async batch(statements: { run(): unknown }[]) { return Promise.all(statements.map((statement) => statement.run())); },
    prepare(sql: string) {
      let values: unknown[] = [];
      return {
        bind(...args: unknown[]) { values = args; return this; },
        first() { return sqlite.prepare(sql).get(...values as Parameters<ReturnType<DatabaseSync["prepare"]>["get"]>) ?? null; },
        run() { return sqlite.prepare(sql).run(...values as Parameters<ReturnType<DatabaseSync["prepare"]>["run"]>); },
      };
    },
  } as unknown as D1Database;
  return { sqlite, db };
}

async function exchange(env: Env, token = "legacy-token-with-sufficient-length") {
  return handleRequest(new Request("https://api.groupicorn.com/auth/app/legacy-exchange", {
    method: "POST", headers: { Authorization: `Bearer ${token}` },
  }), env);
}

test("verified anonymous Supabase session becomes a native session for the same user ID", async () => {
  const { sqlite, db } = database();
  const sourceID = "8d24c6db-a5c7-49dc-849f-ae482ff1fb31";
  sqlite.prepare("INSERT INTO users (id, name, supabase_user_id) VALUES (?, ?, ?)")
    .run(sourceID, "Unicorn", sourceID);
  const env = { DB: db, SUPABASE_URL: "https://example.supabase.co", SUPABASE_PUBLISHABLE_KEY: "public-key" } as unknown as Env;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(input, "https://example.supabase.co/auth/v1/user");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer legacy-token-with-sufficient-length");
    return Response.json({ id: sourceID, is_anonymous: true });
  };
  try {
    const response = await exchange(env);
    assert.equal(response.status, 200);
    const result = await response.json() as { user: { id: string }; supabase_user_id: string; access_token: string };
    assert.equal(result.user.id, sourceID);
    assert.equal(result.supabase_user_id, sourceID);
    const me = await handleRequest(new Request("https://api.groupicorn.com/auth/app/me", {
      headers: { Authorization: `Bearer ${result.access_token}` },
    }), env);
    assert.equal((await me.json() as { user: { id: string } }).user.id, sourceID);
    assert.ok(sqlite.prepare("SELECT supabase_transfer_confirmed_at FROM users WHERE id = ?")
      .get(sourceID)?.supabase_transfer_confirmed_at);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM users").get()?.count, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exchange creates a native account for an unimported legacy identity and rejects invalid sessions", async () => {
  const { sqlite, db } = database();
  const sourceID = "8d24c6db-a5c7-49dc-849f-ae482ff1fb31";
  const env = { DB: db, SUPABASE_URL: "https://example.supabase.co", SUPABASE_PUBLISHABLE_KEY: "public-key" } as unknown as Env;
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ id: sourceID });
    const first = await exchange(env);
    assert.equal(first.status, 200);
    assert.equal((await first.json() as { user: { id: string } }).user.id, sourceID);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM users").get()?.count, 1);
    assert.equal(sqlite.prepare("SELECT json_extract(metadata, '$.native_anonymous') AS anonymous FROM users WHERE id = ?")
      .get(sourceID)?.anonymous, 1);
    assert.equal((await exchange(env)).status, 200);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM users").get()?.count, 1);
    globalThis.fetch = async () => Response.json({ error: "invalid" }, { status: 401 });
    assert.equal((await exchange(env)).status, 401);
    assert.equal((await exchange(env, "short")).status, 401);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("approved existing API user receives their native ID after legacy exchange", async () => {
  const { sqlite, db } = database();
  const sourceID = "8d24c6db-a5c7-49dc-849f-ae482ff1fb31";
  sqlite.prepare("INSERT INTO users (id, email, name, supabase_user_id) VALUES (?, ?, ?, ?)")
    .run("api-existing-id", "owner@example.com", "Owner", sourceID);
  const env = { DB: db, SUPABASE_URL: "https://example.supabase.co", SUPABASE_PUBLISHABLE_KEY: "public-key" } as unknown as Env;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ id: sourceID });
  try {
    const result = await (await exchange(env)).json() as { user: { id: string }; supabase_user_id: string };
    assert.equal(result.user.id, "api-existing-id");
    assert.equal(result.supabase_user_id, sourceID);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
