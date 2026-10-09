import { authCorsHeaders, authJson, currentUser } from "./auth-core";

export async function handleProjectsRequest(request: Request, env: Env): Promise<Response> {
  const cors = authCorsHeaders(request);
  if (cors === null) return authJson({ error: "origin_not_allowed" }, 403, {});
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (!["GET", "POST", "PATCH"].includes(request.method)) {
    return authJson({ error: "method_not_allowed" }, 405, { ...cors, allow: "GET, POST, PATCH, OPTIONS" });
  }
  if (request.method !== "GET" && !request.headers.get("Origin")) return authJson({ error: "origin_required" }, 403, cors);
  try {
    const user = await currentUser(env, request);
    if (!user) return authJson({ error: "not_authenticated" }, 401, cors);
    if (request.method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT id, name, created_at FROM projects WHERE user_id = ? ORDER BY created_at DESC, id DESC",
      ).bind(user.id).all();
      return authJson({ projects: results }, 200, cors);
    }
    const url = new URL(request.url);
    let projectId: string | null = null;
    if (request.method === "PATCH") {
      const ids = url.searchParams.getAll("id");
      if (ids.length !== 1 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ids[0])) {
        return authJson({ error: "invalid_request" }, 400, cors);
      }
      projectId = ids[0];
    }
    if (Number(request.headers.get("Content-Length")) > 1024) return authJson({ error: "invalid_request" }, 400, cors);
    const text = await request.text();
    if (new TextEncoder().encode(text).length > 1024) return authJson({ error: "invalid_request" }, 400, cors);
    const body = JSON.parse(text);
    if (!body || typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 80) {
      return authJson({ error: "invalid_request" }, 400, cors);
    }
    const name = body.name.trim();
    if (request.method === "PATCH") {
      const result = await env.DB.prepare("UPDATE projects SET name = ? WHERE id = ? AND user_id = ?")
        .bind(name, projectId, user.id).run();
      if (!result.meta.changes) return authJson({ error: "not_found" }, 404, cors);
      const project = await env.DB.prepare("SELECT id, name, created_at FROM projects WHERE id = ? AND user_id = ?")
        .bind(projectId, user.id).first();
      return authJson({ project }, 200, cors);
    }
    const project = { id: crypto.randomUUID(), name, created_at: new Date().toISOString() };
    await env.DB.prepare("INSERT INTO projects (id, user_id, name, created_at) VALUES (?, ?, ?, ?)")
      .bind(project.id, user.id, project.name, project.created_at).run();
    return authJson({ project }, 201, cors);
  } catch (error) {
    if (error instanceof SyntaxError) return authJson({ error: "invalid_request" }, 400, cors);
    console.error("projects_unavailable");
    return authJson({ error: "projects_unavailable" }, 503, cors);
  }
}
