import { AuthError, authJson, readJSON, type AuthUser, type StringHeaders } from "./auth-core";
import { issueAppTokens } from "./auth-app";
import { absorbAnonymousHerds } from "./auth-anonymous";

const APPLE_ISSUER = "https://appleid.apple.com";
const APPLE_KEYS_URL = "https://appleid.apple.com/auth/keys";
const IOS_BUNDLE_ID = "dev.andrewarrow.groupicorn.app";

function decodePart(value: string): Uint8Array | null {
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    return Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function decodeObject(value: string): Record<string, unknown> | null {
  const bytes = decodePart(value);
  if (!bytes) return null;
  try {
    const object: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return object && typeof object === "object" && !Array.isArray(object) ? object as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function buffer(bytes: Uint8Array): ArrayBuffer {
  const result = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(result).set(bytes);
  return result;
}

async function nonceHash(nonce: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(nonce));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function verifyAppleIdentityToken(
  token: unknown,
  nonce: unknown,
): Promise<{ sub: string; email: string | null }> {
  if (typeof token !== "string" || token.length > 10_000
    || typeof nonce !== "string" || nonce.length < 32 || nonce.length > 200) {
    throw new AuthError("Invalid Apple credential.");
  }
  const parts = token.split(".");
  if (parts.length !== 3) throw new AuthError("Invalid Apple credential.");
  const header = decodeObject(parts[0]);
  const claims = decodeObject(parts[1]);
  const signature = decodePart(parts[2]);
  if (!header || !claims || !signature || header.alg !== "RS256" || typeof header.kid !== "string") {
    throw new AuthError("Invalid Apple credential.");
  }

  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== APPLE_ISSUER || claims.aud !== IOS_BUNDLE_ID
    || typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 200
    || typeof claims.exp !== "number" || claims.exp <= now
    || typeof claims.iat !== "number" || claims.iat > now + 60
    || claims.nonce !== await nonceHash(nonce)) {
    throw new AuthError("Invalid Apple credential.");
  }

  let keys: { keys?: (JsonWebKey & { kid?: string })[] };
  try {
    const response = await fetch(APPLE_KEYS_URL);
    if (!response.ok) throw new Error(`Apple keys returned ${response.status}`);
    keys = await response.json() as { keys?: (JsonWebKey & { kid?: string })[] };
  } catch (error) {
    console.error("apple_keys_error", error);
    throw new AuthError("Apple sign-in is temporarily unavailable.", 503);
  }
  const jwk = keys.keys?.find((key) => key.kid === header.kid && key.kty === "RSA");
  if (!jwk) throw new AuthError("Invalid Apple credential.");
  try {
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, buffer(signature), buffer(new TextEncoder().encode(`${parts[0]}.${parts[1]}`)));
    if (!valid) throw new AuthError("Invalid Apple credential.");
  } catch {
    throw new AuthError("Invalid Apple credential.");
  }
  const verifiedEmail = claims.email_verified === true || claims.email_verified === "true";
  const email = verifiedEmail && typeof claims.email === "string" ? claims.email.trim().toLowerCase() : null;
  return { sub: claims.sub, email: email && email.includes("@") && email.length <= 320 ? email : null };
}

export async function handleNativeAppleLogin(request: Request, env: Env, headers: StringHeaders): Promise<Response> {
  if (!env.DB) return authJson({ error: "auth_unavailable" }, 503, headers);
  const body = await readJSON(request, 20_000);
  if (!body) return authJson({ error: "invalid_request" }, 400, headers);
  try {
    const identity = await verifyAppleIdentityToken(body.identity_token, body.nonce);
    let user = await env.DB.prepare(
      "SELECT id, email, name, dob, google_sub, created_at FROM users WHERE apple_sub = ? LIMIT 1",
    ).bind(identity.sub).first<AuthUser>();
    if (!user && identity.email) {
      const byEmail = await env.DB.prepare(
        "SELECT id, email, name, dob, google_sub, created_at, apple_sub FROM users WHERE email = ? LIMIT 1",
      ).bind(identity.email).first<AuthUser & { apple_sub: string | null }>();
      if (byEmail?.apple_sub && byEmail.apple_sub !== identity.sub) {
        return authJson({ error: "identity_conflict" }, 409, headers);
      }
      if (byEmail) {
        await env.DB.prepare("UPDATE users SET apple_sub = ? WHERE id = ?").bind(identity.sub, byEmail.id).run();
        user = byEmail;
      }
    }
    if (!user) {
      if (!identity.email) return authJson({ error: "email_required" }, 400, headers);
      const name = typeof body.name === "string" ? body.name.trim().replace(/\s+/g, " ").slice(0, 120) : "";
      const id = crypto.randomUUID();
      await env.DB.prepare("INSERT INTO users (id, email, name, apple_sub) VALUES (?, ?, ?, ?)")
        .bind(id, identity.email, name || "Groupicorn member", identity.sub).run();
      user = await env.DB.prepare(
        "SELECT id, email, name, dob, google_sub, created_at FROM users WHERE id = ? LIMIT 1",
      ).bind(id).first<AuthUser>();
    }
    if (!user?.email) return authJson({ error: "email_required" }, 400, headers);
    await absorbAnonymousHerds(env, request, user.id);
    return authJson(await issueAppTokens(env, user), 200, headers);
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 500;
    if (status >= 500) console.error("native_apple_login_error", error);
    return authJson({ error: status === 503 ? "apple_unavailable" : status === 401 ? "invalid_apple_credential" : "auth_unavailable" }, status, headers);
  }
}
