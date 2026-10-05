import { jsonResponse } from "../shared/http";

const AUTH_COOKIE_NAME = "mainbrella_session";
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = new Set([
  "https://accounts.google.com",
  "accounts.google.com",
]);
const AUTH_ORIGINS = new Set([
  "https://mainbrella.com",
  "https://www.mainbrella.com",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);

export interface AuthUser {
  id: string;
  email: string | null;
  name: string;
  dob: string | null;
  google_sub: string | null;
  created_at: string;
}

export interface GoogleIdentity {
  googleSub: string;
  email: string;
  name: string;
}

export type StringHeaders = Record<string, string>;

export class AuthError extends Error {
  readonly status: number;

  constructor(message: string, status = 401) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

export function authCorsHeaders(request: Request): StringHeaders | null {
  const requestOrigin = request.headers.get("Origin");
  if (!requestOrigin) return {};

  let origin: string;
  try {
    origin = new URL(requestOrigin).origin;
  } catch {
    return null;
  }

  if (!AUTH_ORIGINS.has(origin)) return null;

  return {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type, authorization, idempotency-key",
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

export function authJson(body: unknown, status: number, corsHeaders: StringHeaders): Response {
  return jsonResponse(body, status, {
    "cache-control": "no-store",
    ...corsHeaders,
  });
}

export async function readJSON(request: Request, maxBytes: number): Promise<Record<string, unknown> | null> {
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > maxBytes) return null;

  try {
    const body: unknown = await request.json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? body as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function decodeBase64Url(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || value.length === 0) return null;

  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function decodeJSONPart(value: unknown): Record<string, unknown> | null {
  const bytes = decodeBase64Url(value);
  if (!bytes) return null;

  try {
    const decoded: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return decoded && typeof decoded === "object" && !Array.isArray(decoded)
      ? decoded as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export async function verifyGoogleIdToken(credential: unknown, env: Env): Promise<GoogleIdentity> {
  if (typeof credential !== "string" || credential.length > 10_000) {
    throw new AuthError("Invalid Google credential.");
  }

  const parts = credential.split(".");
  if (parts.length !== 3) throw new AuthError("Invalid Google credential.");

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJSONPart(encodedHeader);
  const claims = decodeJSONPart(encodedPayload);
  const signature = decodeBase64Url(encodedSignature);
  const clientID = env.GOOGLE_CLIENT_ID;

  if (!header || !claims || !signature || header.alg !== "RS256" || typeof header.kid !== "string") {
    throw new AuthError("Invalid Google credential.");
  }
  if (!clientID) throw new AuthError("Google sign-in is not configured.", 500);

  let keySet: { keys?: (JsonWebKey & { kid?: string })[] };
  try {
    const keyResponse = await fetch(GOOGLE_JWKS_URL);
    if (!keyResponse.ok) throw new Error(`Google keys returned ${keyResponse.status}`);
    keySet = await keyResponse.json() as { keys?: (JsonWebKey & { kid?: string })[] };
  } catch (error) {
    console.error("google_keys_error", error);
    throw new AuthError("Google sign-in is temporarily unavailable.", 503);
  }

  const jwk = keySet.keys?.find((key) => key.kid === header.kid);
  if (!jwk) throw new AuthError("Invalid Google credential.");

  let publicKey: CryptoKey;
  try {
    publicKey = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
  } catch {
    throw new AuthError("Invalid Google credential.");
  }

  const signatureBuffer = new ArrayBuffer(signature.byteLength);
  new Uint8Array(signatureBuffer).set(signature);
  const signedDataBytes = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
  const signedData = new ArrayBuffer(signedDataBytes.byteLength);
  new Uint8Array(signedData).set(signedDataBytes);
  const isSignatureValid = await crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    publicKey,
    signatureBuffer,
    signedData,
  );
  if (!isSignatureValid) throw new AuthError("Invalid Google credential.");

  const now = Math.floor(Date.now() / 1_000);
  const expiresAt = Number(claims.exp);
  const issuedAt = Number(claims.iat);
  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  if (
    typeof claims.iss !== "string"
    || !GOOGLE_ISSUERS.has(claims.iss)
    || claims.aud !== clientID
    || typeof claims.sub !== "string"
    || claims.sub.length === 0
    || claims.email_verified !== true
    || !Number.isFinite(expiresAt)
    || expiresAt <= now
    || !Number.isFinite(issuedAt)
    || issuedAt > now + 60
    || !email.includes("@")
    || email.length > 320
  ) {
    throw new AuthError("Invalid Google credential.");
  }

  return {
    googleSub: claims.sub,
    email,
    name: typeof claims.name === "string" ? claims.name : "",
  };
}

function normalizeUserName(name: string, email: string): string {
  const normalized = name.trim().replace(/\s+/g, " ").slice(0, 120);
  return normalized || (email.split("@")[0] || "Player").slice(0, 120);
}

export function publicUser(user: AuthUser): Record<string, unknown> {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    created_at: user.created_at,
    dob: user.dob,
  };
}

export async function findOrCreateGoogleUser(
  env: Env,
  identity: GoogleIdentity,
): Promise<{ user: AuthUser; created: boolean }> {
  if (!env.DB) throw new AuthError("Authentication is unavailable.", 503);

  const byGoogleSub = await env.DB.prepare(
    "SELECT id, email, name, dob, google_sub, created_at FROM users WHERE google_sub = ? LIMIT 1",
  ).bind(identity.googleSub).first<AuthUser>();
  const existing = byGoogleSub || await env.DB.prepare(
    "SELECT id, email, name, dob, google_sub, created_at FROM users WHERE email = ? LIMIT 1",
  ).bind(identity.email).first<AuthUser>();

  if (existing) {
    if (existing.google_sub && existing.google_sub !== identity.googleSub) {
      throw new AuthError("Google identity is already linked to another account.", 409);
    }
    if (!existing.google_sub) {
      await env.DB.prepare("UPDATE users SET google_sub = ?, name = ? WHERE id = ?")
        .bind(identity.googleSub, normalizeUserName(identity.name, identity.email), existing.id)
        .run();
    }
    return { user: existing, created: false };
  }

  const user: AuthUser = {
    id: crypto.randomUUID(),
    email: identity.email,
    name: normalizeUserName(identity.name, identity.email),
    dob: null,
    google_sub: identity.googleSub,
    created_at: new Date().toISOString(),
  };

  try {
    await env.DB.prepare(
      "INSERT INTO users (id, email, name, google_sub) VALUES (?, ?, ?, ?)",
    ).bind(user.id, user.email, user.name, user.google_sub).run();
    return { user, created: true };
  } catch (error) {
    if (!String(error instanceof Error ? error.message : error).toLowerCase().includes("unique")) throw error;
    const concurrentUser = await env.DB.prepare(
      "SELECT id, email, name, dob, google_sub, created_at FROM users WHERE email = ? LIMIT 1",
    ).bind(identity.email).first<AuthUser>();
    if (!concurrentUser) throw error;
    return { user: concurrentUser, created: false };
  }
}

export async function findOrCreateReviewUser(env: Env, email: string): Promise<AuthUser> {
  if (!env.DB) throw new AuthError("Authentication is unavailable.", 503);
  const existing = await env.DB.prepare(
    "SELECT id, email, name, dob, google_sub, created_at FROM users WHERE email = ? LIMIT 1",
  ).bind(email).first<AuthUser>();
  if (existing) return existing;

  const user: AuthUser = {
    id: crypto.randomUUID(),
    email,
    name: "Test User",
    dob: null,
    google_sub: null,
    created_at: new Date().toISOString(),
  };
  await env.DB.prepare("INSERT INTO users (id, email, name) VALUES (?, ?, ?)")
    .bind(user.id, user.email, user.name)
    .run();
  return user;
}

export function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readCookie(request: Request, name: string): string | null {
  const cookieHeader = request.headers.get("Cookie") || "";
  const cookie = cookieHeader.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return cookie ? cookie.slice(name.length + 1) : null;
}

function sessionCookie(token: string): string {
  return `${AUTH_COOKIE_NAME}=${token}; Max-Age=${SESSION_MAX_AGE_SECONDS}; Path=/; HttpOnly; SameSite=None; Secure`;
}

export function expiredSessionCookie(): string {
  return `${AUTH_COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=None; Secure`;
}

export async function createSession(env: Env, userID: string): Promise<string> {
  if (!env.DB) throw new AuthError("Authentication is unavailable.", 503);
  const token = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1_000).toISOString();
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(new Date().toISOString()).run();
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(await hashToken(token), userID, expiresAt)
    .run();
  return sessionCookie(token);
}

export async function currentUser(env: Env, request: Request): Promise<AuthUser | null> {
  const token = readCookie(request, AUTH_COOKIE_NAME);
  return token ? sessionUser(env, token) : null;
}

// Shared session lookup; callers decide which credential transport they accept.
export async function sessionUser(env: Env, token: string): Promise<AuthUser | null> {
  if (!env.DB) return null;
  const row = await env.DB.prepare(
    `SELECT users.id, users.email, users.name, users.dob, users.google_sub, users.created_at
     FROM sessions JOIN users ON users.id = sessions.user_id
     WHERE sessions.token_hash = ? AND sessions.expires_at > ? LIMIT 1`,
  ).bind(await hashToken(token), new Date().toISOString()).first<AuthUser>();
  return row || null;
}

export async function revokeSession(env: Env, request: Request): Promise<void> {
  if (!env.DB) return;
  const token = readCookie(request, AUTH_COOKIE_NAME);
  if (!token) return;
  await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await hashToken(token)).run();
}
