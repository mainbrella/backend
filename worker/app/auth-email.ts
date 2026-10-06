import { scrypt, randomBytes, timingSafeEqual } from "node:crypto";
import { AuthError, type AuthUser } from "./auth-core";

// OWASP's 16 MiB scrypt setting fits within the Workers memory limit.
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 5, maxmem: 32 * 1024 * 1024 };
const HASH_PREFIX = "scrypt:16384:8:5";
type PasswordUser = AuthUser & { password_hash: string | null };

function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, SCRYPT_OPTIONS, (error, key) => error ? reject(error) : resolve(key));
  });
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  return `${HASH_PREFIX}:${salt}:${(await derive(password, salt)).toString("hex")}`;
}

async function verifyPassword(password: string, hash: string | null): Promise<boolean> {
  const parts = hash?.split(":");
  const valid = parts?.length === 6 && parts.slice(0, 4).join(":") === HASH_PREFIX
    && /^[a-f0-9]{32}$/.test(parts[4]) && /^[a-f0-9]{64}$/.test(parts[5]);
  // Provider-only accounts do the same expensive work before rejecting the password.
  const actual = await derive(password, valid ? parts[4] : "0".repeat(32));
  const expected = Buffer.from(valid ? parts[5] : "0".repeat(64), "hex");
  return timingSafeEqual(actual, expected) && Boolean(valid);
}

export async function signInOrCreateEmailUser(env: Env, email: unknown, password: unknown): Promise<AuthUser> {
  if (typeof email !== "string" || typeof password !== "string") throw new AuthError("invalid_request", 400);
  const normalizedEmail = email.trim().toLowerCase();
  if (normalizedEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)
    || password.length === 0 || password.length > 128) throw new AuthError("invalid_request", 400);
  if (!env.DB) throw new AuthError("auth_unavailable", 503);

  const readUser = () => env.DB.prepare(
    "SELECT id, email, name, dob, google_sub, created_at, password_hash FROM users WHERE lower(email) = ? LIMIT 1",
  ).bind(normalizedEmail).first<PasswordUser>();
  const existing = await readUser();
  if (existing) {
    if (!await verifyPassword(password, existing.password_hash)) throw new AuthError("invalid_credentials");
    return existing;
  }
  if (password.length < 8) throw new AuthError("weak_password", 400);
  const hash = await hashPassword(password);
  const user: AuthUser = {
    id: crypto.randomUUID(), email: normalizedEmail, name: normalizedEmail.split("@")[0].slice(0, 120),
    dob: null, google_sub: null, created_at: new Date().toISOString(),
  };
  try {
    // A single statement stores the account and its password atomically. The
    // conditional insert also respects provider accounts with mixed-case emails.
    await env.DB.prepare(
      `INSERT INTO users (id, email, name, password_hash)
       SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users WHERE lower(email) = ?)`,
    ).bind(user.id, user.email, user.name, hash, normalizedEmail).run();
  } catch (error) {
    if (!String(error instanceof Error ? error.message : error).toLowerCase().includes("unique")) throw error;
  }
  // A concurrent signup may have won; authenticate its password rather than
  // replacing it or issuing a session for credentials that did not win.
  const saved = await readUser();
  if (!saved) throw new AuthError("auth_unavailable", 503);
  if (saved.id !== user.id && !await verifyPassword(password, saved.password_hash)) {
    throw new AuthError("invalid_credentials");
  }
  return saved;
}
