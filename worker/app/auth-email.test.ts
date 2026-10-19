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
  const emails: EmailMessageBuilder[] = [];
  const background: Promise<unknown>[] = [];
  const ctx = { waitUntil(promise: Promise<unknown>) { background.push(promise); } } as ExecutionContext;
  const env = {
    WELCOME_EMAIL: { async send(message: EmailMessageBuilder) { emails.push(message); return { messageId: "welcome" }; } },
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
    }), env, ctx);
  return { sqlite, env, login, keys, emails, background, setLimited() { limited = true; } };
}

test("email form creates an account, stores only a salted hash, and establishes a browser session", async t => {
  const f = fixture(t);
  const first = await f.login(" Person@Example.COM ");
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("cache-control"), "no-store");
  assert.equal(first.headers.get("access-control-allow-origin"), "https://mainbrella.com");
  const body = await first.json() as { user: { id: string; email: string; password_hash?: string }; created: boolean };
  assert.equal(body.created, true);
  assert.equal(body.user.email, "person@example.com");
  await Promise.all(f.background);
  assert.equal(f.emails.length, 1);
  assert.deepEqual(f.emails[0].from, { email: "andrew@mainbrella.com", name: "Andrew Arrow" });
  assert.equal(f.emails[0].to, "person@example.com");
  assert.equal(f.emails[0].subject, "Thanks for signing up! 🔋⚡");
  assert.equal(f.emails[0].text, `💥 Hey there! Thanks for signing up with mainbrella.

Real quick and I'll get out of your inbox.

My name is Andrew, founder of the mainbrella and we will jump over backwards here to make you a happy customer.

Please let me know personally if there is anything confusing or hard to use.

Keep out of the rain!

Best,
-aa`);
  assert.equal(body.user.password_hash, undefined);
  const stored = f.sqlite.prepare("SELECT password_hash FROM users WHERE id = ?").get(body.user.id)?.password_hash;
  assert.match(String(stored), /^scrypt:16384:8:5:[a-f0-9]{32}:[a-f0-9]{64}$/);
  assert.ok(!String(stored).includes("a strong password"));
  const cookie = first.headers.get("set-cookie")!;
  assert.match(cookie, /HttpOnly; SameSite=None; Secure/);
  const me = await handleRequest(new Request("https://api.mainbrella.com/auth/me", {
    headers: { Cookie: cookie.split(";")[0] },
  }), f.env);
  assert.deepEqual(await me.json(), { user: body.user });
  const repeat = await f.login("PERSON@example.com");
  assert.equal(repeat.status, 200);
  assert.deepEqual(await repeat.json(), { user: body.user, created: false });
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS count FROM users").get()?.count, 1);
  const wrong = await f.login("person@example.com", "wrong password");
  assert.equal(wrong.status, 401);
  assert.deepEqual(await wrong.json(), { error: "invalid_credentials" });
  assert.equal(wrong.headers.get("set-cookie"), null);
  assert.equal(f.sqlite.prepare("SELECT password_hash FROM users WHERE id = ?").get(body.user.id)?.password_hash, stored);
  assert.equal(f.emails.length, 1);
  await f.login("other@example.com");
  assert.notEqual(f.sqlite.prepare("SELECT password_hash FROM users WHERE email = ?").get("other@example.com")?.password_hash, stored);
});

test('staging origins and browser sessions remain separate from production', async t => {
  const f = fixture(t);
  const production = await f.login();
  assert.equal(production.status, 200);
  const productionCookie = production.headers.get('set-cookie')!.split(';')[0];
  assert.match(productionCookie, /^mainbrella_session=/);
  assert.equal((await f.login('person@example.com', 'a strong password', 'https://stg.mainbrella.com')).status, 403);

  f.env.DEPLOYMENT_ENVIRONMENT = 'staging';
  const request = (path: string, origin: string, cookie?: string, method = 'GET') =>
    handleRequest(new Request(`https://api-stg.mainbrella.com${path}`, {
      method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}) },
    }), f.env);
  for (const origin of ['https://mainbrella.com', 'https://www.mainbrella.com', 'https://raindrop.mainbrella.com', 'http://localhost:5173']) {
    assert.equal((await request('/auth/me', origin)).status, 403, origin);
  }
  assert.equal((await request('/auth/me', 'https://stg.mainbrella.com', productionCookie)).status, 200);
  assert.deepEqual(await (await request('/auth/me', 'https://stg.mainbrella.com', productionCookie)).json(), { user: null });
  const stage = await f.login('person@example.com', 'a strong password', 'https://stg.mainbrella.com');
  assert.equal(stage.status, 200);
  assert.equal(stage.headers.get('access-control-allow-origin'), 'https://stg.mainbrella.com');
  const stageCookie = stage.headers.get('set-cookie')!.split(';')[0];
  assert.match(stageCookie, /^mainbrella_session_stg=/);
  await Promise.all(f.background);
  assert.equal(f.emails.length, 1);
  const stageMe = await request('/auth/me', 'https://raindrop-stg.mainbrella.com', stageCookie);
  assert.equal((await stageMe.json() as { user: { email: string } }).user.email, 'person@example.com');
  const logout = await request('/auth/logout', 'https://stg.mainbrella.com', stageCookie, 'POST');
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie')!, /^mainbrella_session_stg=; Max-Age=0/);
  assert.deepEqual(await (await request('/auth/me', 'https://stg.mainbrella.com', stageCookie)).json(), { user: null });
  f.env.DEPLOYMENT_ENVIRONMENT = 'production';
  const productionMe = await handleRequest(new Request('https://api.mainbrella.com/auth/me', {
    headers: { Origin: 'https://mainbrella.com', Cookie: productionCookie },
  }), f.env);
  assert.equal((await productionMe.json() as { user: { email: string } }).user.email, 'person@example.com');
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

test("blocked disposable email domains cannot create accounts, while existing accounts and lookalikes can sign in", async t => {
  const f = fixture(t);
  for (const email of [
    "  Person@MailNeSiA.com  ",
    "PERSON@MAXXSPACE.COM",
    "person@GuerrillaMailBlock.com",
  ]) {
    const response = await f.login(email);
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "email_domain_blocked" });
  }
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS count FROM users").get()?.count, 0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS count FROM sessions").get()?.count, 0);
  assert.equal(f.emails.length, 0);
  assert.equal(f.background.length, 0);

  assert.equal((await f.login("person@notmailnesia.com")).status, 200);
  assert.equal((await f.login("person@mailnesia.com.example.org")).status, 200);
  await Promise.all(f.background);

  const existing = await f.login("existing@example.com");
  assert.equal(existing.status, 200);
  const existingUser = f.sqlite.prepare("SELECT id FROM users WHERE email = ?").get("existing@example.com");
  f.sqlite.prepare("UPDATE users SET email = ? WHERE id = ?").run("existing@maxxspace.com", existingUser!.id as string);
  const returning = await f.login(" Existing@MaxxSpace.com ");
  assert.equal(returning.status, 200);
  assert.deepEqual(await returning.json(), { user: { ...((await existing.json()) as { user: object }).user, email: "existing@maxxspace.com" }, created: false });
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS count FROM users").get()?.count, 3);
  assert.equal(f.emails.length, 3);
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
  const results = await Promise.all(same.map(response => response.json() as Promise<{ created: boolean }>));
  assert.deepEqual(results.map(result => result.created).sort(), [false, true]);
  await Promise.all(f.background);
  assert.deepEqual(f.emails.map(message => message.to).sort(), ["race@example.com", "same@example.com"]);
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

test("Google creation sends one welcome; repeated sign-in and linking do not", async t => {
  const f = fixture(t);
  const identity = { googleSub: "new-sub", email: "google@example.com", name: "Person" };
  assert.equal((await findOrCreateGoogleUser(f.env, identity)).created, true);
  assert.equal((await findOrCreateGoogleUser(f.env, identity)).created, false);
  f.sqlite.prepare("INSERT INTO users (id, email, name) VALUES (?, ?, ?)").run("linked", "linked@example.com", "Linked");
  assert.equal((await findOrCreateGoogleUser(f.env, { ...identity, googleSub: "linked-sub", email: "linked@example.com" })).created, false);
  assert.deepEqual(f.emails.map(message => message.to), ["google@example.com"]);
});

test("Google rejects new accounts at blocked domains but preserves existing identities", async t => {
  const f = fixture(t);
  for (const domain of ["mailnesia.com", "maxxspace.com", "guerrillamailblock.com"]) {
    await assert.rejects(findOrCreateGoogleUser(f.env, {
      googleSub: `blocked-${domain}`, email: `person@${domain}`, name: "Person",
    }), { status: 403, message: "email_domain_blocked" });
  }
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS count FROM users").get()?.count, 0);
  assert.equal(f.emails.length, 0);

  f.sqlite.prepare("INSERT INTO users (id, email, name, google_sub) VALUES (?, ?, ?, ?)")
    .run("existing-blocked-google", "person@mailnesia.com", "Person", "known-sub");
  const existing = await findOrCreateGoogleUser(f.env, {
    googleSub: "known-sub", email: "person@mailnesia.com", name: "Person",
  });
  assert.equal(existing.created, false);
  assert.equal(existing.user.id, "existing-blocked-google");
  assert.equal((await findOrCreateGoogleUser(f.env, {
    googleSub: "lookalike-sub", email: "person@mailnesia.com.example.org", name: "Person",
  })).created, true);
  assert.deepEqual(f.emails.map(message => message.to), ["person@mailnesia.com.example.org"]);
});

test("signup completes before background delivery and email failure does not fail authentication", async t => {
  const f = fixture(t);
  let rejectSend!: (error: Error) => void;
  f.env.WELCOME_EMAIL = { send() { return new Promise((_resolve, reject) => { rejectSend = reject; }); } } as SendEmail;
  const logged: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logged.push(args); });
  const response = await f.login();
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { created: boolean }).created, true);
  assert.equal(f.background.length, 1);
  rejectSend(new Error("Email service unavailable"));
  await Promise.all(f.background);
  assert.equal(logged[0][0], "welcome_email_failed");
  assert.equal((await f.login()).status, 200);
  assert.equal(f.background.length, 1);
});
