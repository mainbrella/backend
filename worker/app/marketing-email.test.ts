import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { handleRequest } from "./router";
import { hashToken } from "./auth-core";
import { marketingSender } from "../lib/marketing-email";

const input = {
  to: "foo@bar.com", subj: "New idea", from: "Bob Smith <bob.smith@mainbrella.com>",
  message: "hey everyone just want to say hi",
};

async function fixture(t: test.TestContext) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  for (const file of ["001_initial.sql", "002_auth_sessions.sql"]) {
    sqlite.exec(readFileSync(new URL(`../../migrations/${file}`, import.meta.url), "utf8"));
  }
  const adminID = crypto.randomUUID(), memberID = crypto.randomUUID();
  sqlite.prepare("INSERT INTO users (id, name, email) VALUES (?, 'Admin', 'OneOne@Gmail.com')").run(adminID);
  sqlite.prepare("INSERT INTO users (id, name, email) VALUES (?, 'Member', 'member@example.com')").run(memberID);
  const adminToken = "a".repeat(64), memberToken = "b".repeat(64);
  for (const [token, id] of [[adminToken, adminID], [memberToken, memberID]]) {
    sqlite.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
      .run(await hashToken(token), id, "2099-01-01T00:00:00.000Z");
  }
  const emails: EmailMessageBuilder[] = [];
  const env = {
    MARKETING_EMAIL: { async send(message: EmailMessageBuilder) {
      emails.push(message);
      return { messageId: "marketing-123" };
    } },
    DB: { prepare(sql: string) {
      let values: unknown[] = [];
      return {
        bind(...args: unknown[]) { values = args; return this; },
        async first() { return sqlite.prepare(sql).get(...values as Parameters<ReturnType<DatabaseSync["prepare"]>["get"]>) ?? null; },
      };
    } },
  } as unknown as Env;
  const call = ({ token = adminToken, method = "POST", origin = "https://raindrop.mainbrella.com", body = JSON.stringify(input), headers = {} }: {
    token?: string | null; method?: string; origin?: string | null; body?: string; headers?: Record<string, string>;
  } = {}) => handleRequest(new Request("https://api.mainbrella.com/api/send-marketing-email", {
    method,
    headers: {
      "content-type": "application/json", ...(origin ? { Origin: origin } : {}),
      ...(token ? { Cookie: `mainbrella_session=${token}` } : {}), ...headers,
    },
    ...(["POST", "PUT", "PATCH", "DELETE"].includes(method) ? { body } : {}),
  }), env);
  return { env, call, sqlite, emails, adminID, memberToken };
}

test("marketing emails require a current admin session and trusted Origin before sending", async t => {
  const f = await fixture(t);
  assert.equal((await f.call({ token: null })).status, 401);
  assert.equal((await f.call({ token: "unknown" })).status, 401);
  assert.equal((await f.call({ token: f.memberToken })).status, 403);
  assert.equal((await f.call({ origin: "https://example.com" })).status, 403);
  assert.equal((await f.call({ origin: "null" })).status, 403);
  const missingOrigin = await f.call({ origin: null });
  assert.equal(missingOrigin.status, 403);
  assert.deepEqual(await missingOrigin.json(), { error: "origin_required" });
  sqliteChangeEmail(f.sqlite, f.adminID, "member@example.org");
  assert.equal((await f.call()).status, 403);
  sqliteChangeEmail(f.sqlite, f.adminID, "oneone@gmail.com");
  f.sqlite.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'").run();
  assert.equal((await f.call()).status, 401);
  assert.equal(f.emails.length, 0);
});

function sqliteChangeEmail(sqlite: DatabaseSync, id: string, email: string) {
  sqlite.prepare("UPDATE users SET email = ? WHERE id = ?").run(email, id);
}

test("marketing email preflight supports Raindrop and unsupported methods do not send", async t => {
  const f = await fixture(t);
  for (const origin of ["https://raindrop.mainbrella.com", "http://localhost:5174"]) {
    const response = await f.call({ token: null, method: "OPTIONS", origin });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
    assert.equal(response.headers.get("access-control-allow-credentials"), "true");
    assert.match(response.headers.get("access-control-allow-methods")!, /POST/);
  }
  for (const method of ["GET", "HEAD", "PUT", "DELETE"]) {
    const response = await f.call({ method });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "POST, OPTIONS");
  }
  assert.equal(f.emails.length, 0);
});

test("marketing email sends named sender, text and escaped HTML inside the template", async t => {
  const f = await fixture(t);
  const email = { ...input, subj: 'New <idea> & "news"', message: "Hi <everyone> & 'friends'\r\n\r\n<script>alert(1)</script>\nKeep dry!" };
  const response = await f.call({ body: JSON.stringify(email) });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { ok: true, messageId: "marketing-123" });
  assert.equal(response.headers.get("access-control-allow-origin"), "https://raindrop.mainbrella.com");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(f.emails.length, 1);
  const sent = f.emails[0];
  assert.deepEqual(sent.from, { name: "Bob Smith", email: "bob.smith@mainbrella.com" });
  assert.equal(sent.to, email.to);
  assert.equal(sent.subject, email.subj);
  assert.equal(sent.text, email.message);
  assert.match(sent.html!, /<title>New &lt;idea&gt; &amp; &quot;news&quot;<\/title>/);
  assert.match(sent.html!, /<h1[^>]*>New &lt;idea&gt; &amp; &quot;news&quot;<\/h1>/);
  assert.match(sent.html!, /<img src="https:\/\/mainbrella\.com\/images\/logo\.png"[^>]*width="44" height="44"/);
  assert.match(sent.html!, /Hi &lt;everyone&gt; &amp; &#39;friends&#39;<br>\n<br>\n&lt;script&gt;alert\(1\)&lt;\/script&gt;<br>\nKeep dry!/);
  assert.ok(!sent.html!.includes("<script>"));
  assert.ok(sent.html!.indexOf(">mainbrella</a>") < sent.html!.indexOf("Hi &lt;everyone&gt;"));
  assert.ok(sent.html!.indexOf("Hi &lt;everyone&gt;") < sent.html!.indexOf(">mainbrella.com</a>"));
  const bare = await f.call({ body: JSON.stringify({ ...input, from: "bob.smith@mainbrella.com" }) });
  assert.equal(bare.status, 202);
  assert.equal(f.emails[1].from, "bob.smith@mainbrella.com");
});

test("sender parsing allows a single named mailbox and rejects header injection or multiple senders", () => {
  assert.deepEqual(marketingSender('"Smith, Bob" <bob@mainbrella.com>'), { email: "bob@mainbrella.com", name: "Smith, Bob" });
  assert.deepEqual(marketingSender("José Smith <jose@mainbrella.com>"), { email: "jose@mainbrella.com", name: "José Smith" });
  for (const sender of ["", "bad", "Bob <bad>", "<bob@mainbrella.com>", "A <a@example.com>, B <b@example.com>",
    "a@example.com, b@example.com", "Bob <bob@example.com>\r\nBcc: other@example.com", '"Bob <bob@example.com>']) {
    assert.equal(marketingSender(sender), null, sender);
  }
});

test("invalid marketing email bodies and fields are rejected without sending", async t => {
  const f = await fixture(t);
  const invalid = [null, [], {}, { ...input, extra: true }, { ...input, to: [input.to] }, { ...input, to: "not-an-email" },
    { ...input, subj: "" }, { ...input, subj: "   " }, { ...input, subj: "x".repeat(999) }, { ...input, subj: "Hi\r\nBcc: injected@example.com" },
    { ...input, from: "Bob <bad>" }, { ...input, from: "Bob <bob@example.com>\n" }, { ...input, from: "x".repeat(513) },
    { ...input, message: "" }, { ...input, message: " \n\t " }, { ...input, message: 123 }, { ...input, message: "x".repeat(100_001) }];
  for (const body of ["{", "", ...invalid.map(value => JSON.stringify(value))]) {
    const response = await f.call({ body });
    assert.equal(response.status, 400, body.slice(0, 100));
    assert.deepEqual(await response.json(), { error: "invalid_request" });
  }
  assert.equal(f.emails.length, 0);
});

test("marketing email request byte limit applies with or without a Content-Length header", async t => {
  const f = await fixture(t);
  for (const options of [{ headers: { "content-length": String(1024 * 1024 + 1) } }, { body: " ".repeat(1024 * 1024 + 1) }]) {
    const response = await f.call(options);
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error: "request_too_large" });
  }
  assert.equal(f.emails.length, 0);
});

test("marketing email waits for binding acceptance before returning a message ID", async t => {
  const f = await fixture(t);
  let accept!: (result: EmailSendResult) => void;
  let started!: () => void;
  const sending = new Promise<void>(resolve => { started = resolve; });
  f.env.MARKETING_EMAIL = { send() {
    started();
    return new Promise<EmailSendResult>(resolve => { accept = resolve; });
  } };
  let completed = false;
  const pending = f.call().then(response => { completed = true; return response; });
  await sending;
  assert.equal(completed, false);
  accept({ messageId: "accepted-later" });
  const response = await pending;
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { ok: true, messageId: "accepted-later" });
});

test("marketing email failures return safe errors and never report acceptance", async t => {
  const f = await fixture(t);
  t.mock.method(console, "error", () => {});
  const unavailable = { ...f.env, MARKETING_EMAIL: undefined } as unknown as Env;
  const request = () => new Request("https://api.mainbrella.com/api/send-marketing-email", {
    method: "POST", headers: { Origin: "https://raindrop.mainbrella.com", Cookie: `mainbrella_session=${"a".repeat(64)}` },
    body: JSON.stringify(input),
  });
  const missing = await handleRequest(request(), unavailable);
  assert.equal(missing.status, 503);
  assert.deepEqual(await missing.json(), { error: "email_sending_unavailable" });
  for (const code of ["E_DELIVERY_FAILED", "E_RECIPIENT_SUPPRESSED", "E_SENDER_NOT_VERIFIED", "E_RATE_LIMIT_EXCEEDED", "E_DAILY_LIMIT_EXCEEDED", undefined]) {
    let attempts = 0;
    f.env.MARKETING_EMAIL = { async send() { attempts++; throw Object.assign(new Error("Private provider details"), { code }); } };
    const response = await f.call();
    const limited = code === "E_RATE_LIMIT_EXCEEDED" || code === "E_DAILY_LIMIT_EXCEEDED";
    assert.equal(response.status, limited ? 429 : 502);
    assert.deepEqual(await response.json(), { error: limited ? "email_rate_limited" : "email_send_failed" });
    assert.equal(attempts, 1);
  }
  f.env.MARKETING_EMAIL = { async send() { return {} as EmailSendResult; } };
  assert.equal((await f.call()).status, 502);
  f.env.DB = { prepare() { throw new Error("Private database details"); } } as unknown as D1Database;
  const authFailure = await f.call();
  assert.equal(authFailure.status, 503);
  assert.deepEqual(await authFailure.json(), { error: "admin_unavailable" });
});
