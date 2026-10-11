import { authCorsHeaders, authJson, currentUser } from "./auth-core";

const projectColumns = `SELECT p.id, p.name, p.domain, p.created_at, a.id AS build_app_id,
  a.git_version_id, p.github_repo, p.github_branch, p.github_commit_id FROM projects p LEFT JOIN build_apps a ON a.project_id = p.id AND a.user_id = p.user_id`;
const readProject = (env: Env, userId: string, id: string) => env.DB.prepare(`${projectColumns} WHERE p.id = ? AND p.user_id = ?`).bind(id, userId).first();

// Enabling history creates an idle source workspace. Builds and storage writes
// still go through Builder's existing funding, concurrency and retention checks.
function gitWorkspace(env: Env, userId: string, id: string) {
  return env.DB.prepare(`INSERT INTO build_apps
    (id, project_id, user_id, create_key, initial_prompt, name, source_json, created_at, updated_at)
    SELECT p.id, p.id, p.user_id, 'project:' || p.id, '', p.name, '{}', p.created_at, ? FROM projects p
    WHERE p.id = ? AND p.user_id = ? AND NOT EXISTS (SELECT 1 FROM build_apps WHERE project_id = p.id)`)
    .bind(new Date().toISOString(), id, userId);
}

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
        `${projectColumns} WHERE p.user_id = ? ORDER BY p.created_at DESC, p.id DESC`,
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
    if (body.git !== undefined && typeof body.git !== 'boolean') return authJson({ error: 'invalid_request' }, 400, cors);
    let domain: string | null | undefined;
    if (body.domain !== undefined) {
      if (body.domain === null) {
        domain = null;
      } else if (typeof body.domain === "string") {
        const trimmedDomain = body.domain.trim();
        if (trimmedDomain.length > 253) return authJson({ error: "invalid_request" }, 400, cors);
        domain = trimmedDomain || null;
      } else {
        return authJson({ error: "invalid_request" }, 400, cors);
      }
    }
    if (request.method === "PATCH") {
      const owned = await readProject(env, user.id, projectId!);
      if (!owned) return authJson({ error: 'not_found' }, 404, cors);
      const update = domain === undefined
        ? env.DB.prepare("UPDATE projects SET name = ? WHERE id = ? AND user_id = ?")
          .bind(name, projectId, user.id)
        : env.DB.prepare("UPDATE projects SET name = ?, domain = ? WHERE id = ? AND user_id = ?")
          .bind(name, domain, projectId, user.id);
      if (body.git) await env.DB.batch([update, gitWorkspace(env, user.id, projectId!)]);
      else await update.run();
      const project = await readProject(env, user.id, projectId!);
      return authJson({ project }, 200, cors);
    }
    const project = { id: crypto.randomUUID(), name, domain: domain ?? null, created_at: new Date().toISOString() };
    const insert = env.DB.prepare("INSERT INTO projects (id, user_id, name, domain, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(project.id, user.id, project.name, project.domain, project.created_at);
    if (body.git) await env.DB.batch([insert, gitWorkspace(env, user.id, project.id)]);
    else await insert.run();
    return authJson({ project: await readProject(env, user.id, project.id) }, 201, cors);
  } catch (error) {
    if (error instanceof Error && error.message.includes('build_app_limit')) return authJson({ error: 'build_app_limit' }, 429, cors);
    if (error instanceof SyntaxError) return authJson({ error: "invalid_request" }, 400, cors);
    console.error("projects_unavailable");
    return authJson({ error: "projects_unavailable" }, 503, cors);
  }
}
