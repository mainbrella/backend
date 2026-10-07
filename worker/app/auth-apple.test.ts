import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { verifyAppleIdentityToken } from "./auth-apple";
import { handleRequest } from "./router";

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

test("Apple identity tokens require a valid signature, app audience, and nonce", async () => {
  const keys = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ keys: [{ ...jwk, kid: "test-key" }] });
  const nonce = "nonce-that-is-at-least-thirty-two-characters";
  const nonceDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(nonce));
  const hashedNonce = [...new Uint8Array(nonceDigest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const now = Math.floor(Date.now() / 1000);
  async function token(claims: Record<string, unknown>): Promise<string> {
    const header = base64url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", kid: "test-key" })));
    const payload = base64url(new TextEncoder().encode(JSON.stringify({
      iss: "https://appleid.apple.com",
      aud: "dev.andrewarrow.groupicorn.app",
      sub: "apple-user-id",
      exp: now + 300,
      iat: now,
      nonce: hashedNonce,
      email: "person@example.com",
      email_verified: "true",
      ...claims,
    })));
    const message = `${header}.${payload}`;
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(message));
    return `${message}.${base64url(new Uint8Array(signature))}`;
  }
  try {
    const valid = await token({});
    assert.deepEqual(await verifyAppleIdentityToken(valid, nonce), {
      sub: "apple-user-id", email: "person@example.com",
    });
    await assert.rejects(verifyAppleIdentityToken(valid, `${nonce}-wrong`));
    await assert.rejects(verifyAppleIdentityToken(await token({ aud: "another.app" }), nonce));
    await assert.rejects(verifyAppleIdentityToken(await token({ exp: now - 1 }), nonce));
    const signatureStart = valid.lastIndexOf(".") + 1;
    const tampered = valid.slice(0, signatureStart)
      + (valid[signatureStart] === "A" ? "B" : "A")
      + valid.slice(signatureStart + 1);
    await assert.rejects(verifyAppleIdentityToken(tampered, nonce));

    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON");
    for (const file of ["001_initial.sql", "002_auth_sessions.sql"]) {
      sqlite.exec(readFileSync(new URL(`../../migrations/${file}`, import.meta.url), "utf8"));
    }
    sqlite.exec(readFileSync(new URL('./fixtures/legacy-compatibility.sql', import.meta.url), 'utf8'));
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
    const emails: EmailMessageBuilder[] = [];
    const emailBinding = { async send(message: EmailMessageBuilder) { emails.push(message); return { messageId: "apple-welcome" }; } };
    async function signIn() {
      return handleRequest(new Request("https://api.groupicorn.com/auth/app/apple", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identity_token: valid, nonce }),
      }), { DB: db, WELCOME_EMAIL: emailBinding } as unknown as Env);
    }
    const first = await signIn();
    assert.equal(first.status, 200);
    const firstTokens = await first.json() as { access_token: string; user: { id: string } };
    assert.equal((await signIn()).status, 200);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM users").get()?.count, 1);
    assert.deepEqual(emails.map(message => message.to), ["person@example.com"]);
    assert.equal(sqlite.prepare("SELECT apple_sub FROM users WHERE id = ?").get(firstTokens.user.id)?.apple_sub, "apple-user-id");
    const me = await handleRequest(new Request("https://api.groupicorn.com/auth/app/me", {
      headers: { Authorization: `Bearer ${firstTokens.access_token}` },
    }), { DB: db, WELCOME_EMAIL: emailBinding } as unknown as Env);
    assert.equal(me.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
