import { authJson, hashToken, publicUser, randomToken, readJSON, type AuthUser, type StringHeaders } from "./auth-core";
import { deletionProvider, revokeDeletionProvider } from "./provider-revocation";

const ACCESS_MAX_AGE_SECONDS = 15 * 60;
const REFRESH_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;

function bearerToken(request: Request): string | null {
  const match = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get("Authorization") || "");
  return match?.[1] ?? null;
}

export async function currentNativeAppUser(env: Env, request: Request): Promise<AuthUser | null> {
  const token = bearerToken(request);
  if (!token || !env.DB) return null;
  return await env.DB.prepare(
    `SELECT users.id, users.email, users.name, users.dob, users.google_sub, users.created_at
     FROM app_access_tokens AS tokens JOIN users ON users.id = tokens.user_id
     WHERE tokens.token_hash = ? AND tokens.expires_at > ? LIMIT 1`,
  ).bind(await hashToken(token), new Date().toISOString()).first<AuthUser>();
}

export async function issueAppTokens(env: Env, user: AuthUser): Promise<Record<string, unknown>> {
  if (!env.DB) throw new Error("database_unavailable");
  const accessToken = randomToken();
  const refreshToken = randomToken();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM app_access_tokens WHERE expires_at <= ?").bind(new Date(now).toISOString()),
    env.DB.prepare("DELETE FROM app_refresh_tokens WHERE expires_at <= ? OR revoked_at IS NOT NULL")
      .bind(new Date(now).toISOString()),
    env.DB.prepare("INSERT INTO app_access_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
      .bind(await hashToken(accessToken), user.id, new Date(now + ACCESS_MAX_AGE_SECONDS * 1000).toISOString()),
    env.DB.prepare("INSERT INTO app_refresh_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
      .bind(await hashToken(refreshToken), user.id, new Date(now + REFRESH_MAX_AGE_SECONDS * 1000).toISOString()),
  ]);
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_in: ACCESS_MAX_AGE_SECONDS,
    user: publicUser(user),
  };
}

export async function handleAppAnonymous(env: Env, headers: StringHeaders): Promise<Response> {
  if (!env.DB) return authJson({ error: "auth_unavailable" }, 503, headers);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO users (id, name, metadata) VALUES (?, 'Groupicorn member', '{"native_anonymous":true}')`,
  ).bind(id).run();
  const user = await env.DB.prepare(
    "SELECT id, email, name, dob, google_sub, created_at FROM users WHERE id = ?",
  ).bind(id).first<AuthUser>();
  return authJson(await issueAppTokens(env, user!), 200, headers);
}

export async function handleAppMe(request: Request, env: Env, headers: StringHeaders): Promise<Response> {
  const user = await currentNativeAppUser(env, request);
  if (user) {
    await env.DB.prepare(
      `UPDATE users SET supabase_transfer_confirmed_at = ?
       WHERE id = ? AND supabase_user_id IS NOT NULL AND supabase_transfer_confirmed_at IS NULL`,
    ).bind(new Date().toISOString(), user.id).run();
  }
  return user ? authJson({ user: publicUser(user) }, 200, headers)
    : authJson({ error: "unauthorized" }, 401, headers);
}

export async function handleAppDelete(request: Request, env: Env, headers: StringHeaders): Promise<Response> {
  if (!env.DB) return authJson({ error: "auth_unavailable" }, 503, headers);
  const user = await currentNativeAppUser(env, request);
  if (!user) return authJson({ error: "unauthorized" }, 401, headers);
  const legacy = await env.DB.prepare("SELECT supabase_user_id FROM users WHERE id = ?")
    .bind(user.id).first<{ supabase_user_id: string | null }>();
  const legacyKey = (env as Env & { SUPABASE_SERVICE_ROLE_KEY?: string }).SUPABASE_SERVICE_ROLE_KEY;
  if (legacy?.supabase_user_id && (!legacyKey || !env.SUPABASE_URL)) {
    return authJson({ error: "legacy_deletion_unavailable" }, 503, headers);
  }
  const provider = await deletionProvider(env, user.id);
  if (provider) {
    const body = await readJSON(request, 20_000);
    if (!body) return authJson({ error: "provider_reauthentication_required", provider }, 409, headers);
    try { await revokeDeletionProvider(env, user.id, provider, body); }
    catch (error) {
      console.error("provider_revocation_error", error);
      return authJson({ error: "provider_revocation_failed", provider }, 502, headers);
    }
  }
  if (legacy?.supabase_user_id) {
    try {
      await deleteLegacyAccount(env.SUPABASE_URL!, legacyKey!, legacy.supabase_user_id);
    } catch (error) {
      console.error("legacy_account_deletion_error", error);
      return authJson({ error: "legacy_deletion_failed" }, 503, headers);
    }
  }
  const photos = await env.DB.prepare(
    `SELECT image_path FROM herd_chat_messages WHERE user_id = ? AND image_path IS NOT NULL
     UNION SELECT image_path FROM herd_direct_messages WHERE sender_id = ? AND image_path IS NOT NULL`,
  ).bind(user.id, user.id).all<{ image_path: string }>();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM subherd_neigh_replies WHERE user_id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM subherd_neighs WHERE user_id = ?").bind(user.id),
    env.DB.prepare("UPDATE subherds SET created_by = NULL WHERE created_by = ?").bind(user.id),
    env.DB.prepare("DELETE FROM herd_chat_messages WHERE user_id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM herd_direct_messages WHERE sender_id = ? OR recipient_id = ?")
      .bind(user.id, user.id),
    env.DB.prepare("DELETE FROM chat_message_reports WHERE reporting_user_id = ? OR reported_user_id = ?")
      .bind(user.id, user.id),
    env.DB.prepare("DELETE FROM herd_member_endorsements WHERE endorser_user_id = ? OR endorsed_user_id = ?")
      .bind(user.id, user.id),
    env.DB.prepare("DELETE FROM herd_meetup_confirmations WHERE member_one_user_id = ? OR member_two_user_id = ?")
      .bind(user.id, user.id),
    env.DB.prepare("DELETE FROM herd_member_presence WHERE user_id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM herd_push_notification_state WHERE user_id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM push_notification_events WHERE target_user_id = ? OR actor_id = ?")
      .bind(user.id, user.id),
    env.DB.prepare("DELETE FROM community_typicorn_slots WHERE user_id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM blocked_users WHERE blocking_user_id = ? OR blocked_user_id = ?")
      .bind(user.id, user.id),
    env.DB.prepare("DELETE FROM user_linked_accounts WHERE user_id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM herd_memberships WHERE user_id = ?").bind(user.id),
    env.DB.prepare("UPDATE herd_media_subscriptions SET sponsor_user_id = NULL WHERE sponsor_user_id = ?")
      .bind(user.id),
    env.DB.prepare("UPDATE herds SET created_by = NULL, media_subscription_sponsor_id = NULL WHERE created_by = ?")
      .bind(user.id),
    env.DB.prepare("UPDATE herds SET media_subscription_sponsor_id = NULL WHERE media_subscription_sponsor_id = ?")
      .bind(user.id),
    env.DB.prepare("DELETE FROM users WHERE id = ?").bind(user.id),
  ]);
  const bucket = env.BUCKET;
  if (bucket) {
    await Promise.all(photos.results.map((row) => bucket.delete(`herd_media/${row.image_path}`)));
  }
  return authJson({ deleted: true }, 200, headers);
}

async function deleteLegacyAccount(baseURL: string, key: string, sourceUserID: string): Promise<void> {
  const headers = { apikey: key, authorization: `Bearer ${key}` };
  const photoPaths = new Set<string>();
  for (const [table, userColumn] of [["herd_chat_messages", "user_id"],
    ["herd_direct_messages", "sender_id"]] as const) {
    for (let offset = 0; ; offset += 1_000) {
      const url = new URL(`${baseURL}/rest/v1/${table}`);
      url.searchParams.set("select", "image_path");
      url.searchParams.set(userColumn, `eq.${sourceUserID}`);
      url.searchParams.set("image_path", "not.is.null");
      url.searchParams.set("order", "id.asc");
      url.searchParams.set("limit", "1000");
      url.searchParams.set("offset", String(offset));
      const response = await fetch(url, { headers });
      if (!response.ok) throw new Error(`legacy_photo_lookup_failed:${response.status}`);
      const rows = await response.json() as Array<{ image_path: string }>;
      if (!Array.isArray(rows)) throw new Error("legacy_photo_lookup_invalid");
      for (const row of rows) if (typeof row.image_path === "string") photoPaths.add(row.image_path);
      if (rows.length < 1_000) break;
    }
  }
  const paths = [...photoPaths];
  for (let offset = 0; offset < paths.length; offset += 1_000) {
    const response = await fetch(`${baseURL}/storage/v1/object/herd_media`, {
      method: "DELETE", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ prefixes: paths.slice(offset, offset + 1_000) }),
    });
    if (!response.ok) throw new Error(`legacy_photo_deletion_failed:${response.status}`);
  }
  const response = await fetch(`${baseURL}/auth/v1/admin/users/${sourceUserID}`, {
    method: "DELETE", headers,
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`legacy_auth_deletion_failed:${response.status}`);
  }
}

export async function handleAppRefresh(request: Request, env: Env, headers: StringHeaders): Promise<Response> {
  if (!env.DB) return authJson({ error: "auth_unavailable" }, 503, headers);
  const body = await readJSON(request, 2_000);
  const token = body?.refresh_token;
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) {
    return authJson({ error: "invalid_request" }, 400, headers);
  }
  const tokenHash = await hashToken(token);
  const now = new Date().toISOString();
  const claimed = await env.DB.prepare(
    `UPDATE app_refresh_tokens SET revoked_at = ?
     WHERE token_hash = ? AND expires_at > ? AND revoked_at IS NULL`,
  ).bind(now, tokenHash, now).run();
  if (Number(claimed.meta.changes) !== 1) return authJson({ error: "invalid_refresh_token" }, 401, headers);
  const user = await env.DB.prepare(
    `SELECT users.id, users.email, users.name, users.dob, users.google_sub, users.created_at
     FROM app_refresh_tokens AS tokens JOIN users ON users.id = tokens.user_id
     WHERE tokens.token_hash = ? LIMIT 1`,
  ).bind(tokenHash).first<AuthUser>();
  if (!user) return authJson({ error: "invalid_refresh_token" }, 401, headers);
  return authJson(await issueAppTokens(env, user), 200, headers);
}

export async function handleAppLogout(request: Request, env: Env, headers: StringHeaders): Promise<Response> {
  if (!env.DB) return authJson({ error: "auth_unavailable" }, 503, headers);
  const body = await readJSON(request, 2_000);
  const token = body?.refresh_token;
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) {
    return authJson({ error: "invalid_request" }, 400, headers);
  }
  const tokenHash = await hashToken(token);
  const row = await env.DB.prepare("SELECT user_id FROM app_refresh_tokens WHERE token_hash = ? LIMIT 1")
    .bind(tokenHash).first<{ user_id: string }>();
  if (row) {
    const accessToken = bearerToken(request);
    await env.DB.prepare("DELETE FROM app_refresh_tokens WHERE token_hash = ?").bind(tokenHash).run();
    if (accessToken) {
      await env.DB.prepare("DELETE FROM app_access_tokens WHERE token_hash = ? AND user_id = ?")
        .bind(await hashToken(accessToken), row.user_id).run();
    }
  }
  return authJson({ ok: true }, 200, headers);
}
