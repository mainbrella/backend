import { authCorsHeaders, authJson, currentUser, hashToken, randomToken, type AuthUser } from "./auth-core";

export async function apiKeyUser(env: Env, token: string): Promise<AuthUser | null> {
  if (!env.DB) return null;
  const tokenHash = await hashToken(token);
  const user = await env.DB.prepare(
    `SELECT users.id, users.email, users.name, users.dob, users.google_sub, users.created_at
     FROM api_keys JOIN users ON users.id = api_keys.user_id WHERE api_keys.token_hash = ? LIMIT 1`,
  ).bind(tokenHash).first<AuthUser>();
  if (user) await env.DB.prepare("UPDATE api_keys SET last_used_at = ? WHERE token_hash = ?")
    .bind(new Date().toISOString(), tokenHash).run();
  return user || null;
}

export async function handleAPIKeysRequest(request: Request, env: Env): Promise<Response> {
  const cors = authCorsHeaders(request);
  if (cors === null) return authJson({ error: "origin_not_allowed" }, 403, {});
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (!["GET", "POST", "DELETE"].includes(request.method)) {
    return authJson({ error: "method_not_allowed" }, 405, { ...cors, allow: "GET, POST, DELETE, OPTIONS" });
  }
  // Key management requires a browser session and a trusted Origin for mutations.
  if (request.method !== "GET" && !request.headers.get("Origin")) return authJson({ error: "origin_required" }, 403, cors);
  try {
    const user = await currentUser(env, request);
    if (!user) return authJson({ error: "not_authenticated" }, 401, cors);
    const url = new URL(request.url);
    if (request.method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT id, name, prefix, created_at, last_used_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC, id DESC",
      ).bind(user.id).all();
      return authJson({ keys: results }, 200, cors);
    }
    if (request.method === "POST") {
      // Bound the body before parsing so an untrusted request cannot allocate arbitrary memory.
      if (Number(request.headers.get("Content-Length")) > 1024) return authJson({ error: "invalid_request" }, 400, cors);
      const text = await request.text();
      if (text.length > 1024) return authJson({ error: "invalid_request" }, 400, cors);
      const body = JSON.parse(text);
      if (!body || typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 80) {
        return authJson({ error: "invalid_request" }, 400, cors);
      }
      const token = `mb_${randomToken()}`;
      const key = { id: crypto.randomUUID(), name: body.name.trim(), prefix: token.slice(0, 11),
        created_at: new Date().toISOString(), last_used_at: null };
      // Atomic limit check also covers concurrent create requests.
      const result = await env.DB.prepare(
        `INSERT INTO api_keys (id, user_id, name, token_hash, prefix, created_at)
         SELECT ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM api_keys WHERE user_id = ?) < 20`,
      ).bind(key.id, user.id, key.name, await hashToken(token), key.prefix, key.created_at, user.id).run();
      if (!result.meta.changes) return authJson({ error: "api_key_limit" }, 429, cors);
      return authJson({ key, token }, 201, cors);
    }
    const id = url.searchParams.get("id");
    if (!id || url.searchParams.getAll("id").length !== 1) return authJson({ error: "invalid_request" }, 400, cors);
    const result = await env.DB.prepare("DELETE FROM api_keys WHERE id = ? AND user_id = ?").bind(id, user.id).run();
    return result.meta.changes ? authJson({ ok: true }, 200, cors) : authJson({ error: "not_found" }, 404, cors);
  } catch (error) {
    if (error instanceof SyntaxError) return authJson({ error: "invalid_request" }, 400, cors);
    console.error("api_keys_unavailable");
    return authJson({ error: "api_keys_unavailable" }, 503, cors);
  }
}
