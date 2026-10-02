import { Buffer } from "node:buffer";
import { verifyGoogleIdToken } from "./auth-core";
import { verifyAppleIdentityToken } from "./auth-apple";

type Provider = "apple" | "google" | null;

export async function deletionProvider(env: Env, userID: string): Promise<Provider> {
  const row = await env.DB.prepare(
    `SELECT u.apple_sub, u.google_sub,
       (SELECT provider FROM user_linked_accounts WHERE user_id = u.id
        AND provider IN ('apple', 'google') ORDER BY linked_at LIMIT 1) AS linked_provider
     FROM users u WHERE u.id = ?`,
  ).bind(userID).first<{ apple_sub: string | null; google_sub: string | null;
    linked_provider: string | null }>();
  if (row?.linked_provider === "apple" || row?.linked_provider === "google") return row.linked_provider;
  return row?.apple_sub ? "apple" : row?.google_sub ? "google" : null;
}

async function appleClientSecret(env: Env): Promise<string> {
  const config = env as Env & { APPLE_TEAM_ID?: string; APPLE_KEY_ID?: string;
    APPLE_PRIVATE_KEY?: string; APPLE_CLIENT_ID?: string };
  if (!config.APPLE_TEAM_ID || !config.APPLE_KEY_ID || !config.APPLE_PRIVATE_KEY) {
    throw new Error("apple_revocation_not_configured");
  }
  const der = Buffer.from(config.APPLE_PRIVATE_KEY.replaceAll("\\n", "\n")
    .replace(/-----[^-]+-----/g, "").replace(/\s/g, ""), "base64");
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" },
    false, ["sign"]);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const content = `${encode({ alg: "ES256", kid: config.APPLE_KEY_ID })}.${encode({
    iss: config.APPLE_TEAM_ID, sub: config.APPLE_CLIENT_ID || "dev.andrewarrow.groupicorn.app",
    aud: "https://appleid.apple.com", iat: now, exp: now + 300,
  })}`;
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key,
    new TextEncoder().encode(content));
  return `${content}.${Buffer.from(signature).toString("base64url")}`;
}

export async function revokeDeletionProvider(
  env: Env, userID: string, provider: Exclude<Provider, null>, body: Record<string, unknown>,
): Promise<void> {
  if (provider === "apple") {
    const identity = await verifyAppleIdentityToken(body.apple_identity_token, body.apple_nonce);
    const account = await env.DB.prepare(
      `SELECT COALESCE(u.apple_sub, a.provider_user_id) AS provider_user_id FROM users u
       LEFT JOIN user_linked_accounts a ON a.user_id = u.id AND a.provider = 'apple'
       WHERE u.id = ?`,
    ).bind(userID).first<{ provider_user_id: string | null }>();
    if (identity.sub !== account?.provider_user_id ||
      typeof body.apple_authorization_code !== "string" || body.apple_authorization_code.length > 5000) {
      throw new Error("provider_reauthentication_failed");
    }
    const clientID = (env as Env & { APPLE_CLIENT_ID?: string }).APPLE_CLIENT_ID ||
      "dev.andrewarrow.groupicorn.app";
    const secret = await appleClientSecret(env);
    const exchange = await fetch("https://appleid.apple.com/auth/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientID, client_secret: secret,
        code: body.apple_authorization_code, grant_type: "authorization_code" }),
    });
    const credentials = await exchange.json().catch(() => ({})) as { refresh_token?: string; access_token?: string };
    const token = credentials.refresh_token || credentials.access_token;
    if (!exchange.ok || !token) throw new Error("apple_token_exchange_failed");
    const revoked = await fetch("https://appleid.apple.com/auth/revoke", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientID, client_secret: secret, token,
        token_type_hint: credentials.refresh_token ? "refresh_token" : "access_token" }),
    });
    if (!revoked.ok) throw new Error(`apple_revocation_failed:${revoked.status}`);
    return;
  }
  const identity = await verifyGoogleIdToken(body.google_id_token, env);
  const account = await env.DB.prepare(
    `SELECT COALESCE(u.google_sub, a.provider_user_id) AS google_sub FROM users u
     LEFT JOIN user_linked_accounts a ON a.user_id = u.id AND a.provider = 'google'
     WHERE u.id = ?`,
  ).bind(userID).first<{ google_sub: string | null }>();
  if (identity.googleSub !== account?.google_sub ||
    typeof body.google_access_token !== "string" || body.google_access_token.length > 5000) {
    throw new Error("provider_reauthentication_failed");
  }
  const info = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { authorization: `Bearer ${body.google_access_token}` },
  });
  const profile = await info.json().catch(() => ({})) as { sub?: string };
  if (!info.ok || profile.sub !== identity.googleSub) throw new Error("provider_reauthentication_failed");
  const revoked = await fetch("https://oauth2.googleapis.com/revoke", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: body.google_access_token }),
  });
  if (!revoked.ok && revoked.status !== 400) throw new Error(`google_revocation_failed:${revoked.status}`);
}
