import { authCorsHeaders, authJson, currentUser } from "./auth-core";

// During development every authenticated user receives the fixed small-container
// limits enforced by BuilderMachine, independently of their billing tier.
export async function handleContainersRequest(request: Request, env: Env): Promise<Response> {
  const cors = authCorsHeaders(request);
  if (cors === null) return authJson({ error: "origin_not_allowed" }, 403, {});
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (new URL(request.url).pathname !== "/containers") {
    return authJson({ error: "not_found" }, 404, cors);
  }
  if (!["GET", "POST", "DELETE"].includes(request.method)) {
    return authJson({ error: "method_not_allowed" }, 405, { ...cors, allow: "GET, POST, DELETE, OPTIONS" });
  }
  if (request.method !== "GET" && !request.headers.get("Origin")) {
    return authJson({ error: "origin_required" }, 403, cors);
  }
  try {
    const user = await currentUser(env, request);
    if (!user) return authJson({ error: "not_authenticated" }, 401, cors);
    if (!env.BUILDER_MACHINE) return authJson({ error: "containers_unavailable" }, 503, cors);
    // A single slot per account. Never accept a machine ID, size, lease, or image
    // from the browser, and never pass session cookies to the container service.
    const machine = env.BUILDER_MACHINE.get(env.BUILDER_MACHINE.idFromName(`user:${user.id}`));
    const response = await machine.fetch(new Request("https://internal/container", { method: request.method }));
    const data = await response.json();
    if (response.status === 429) return authJson({ error: "container_quota_exceeded" }, 429, cors);
    if (!response.ok) throw new Error("machine_request_failed");
    return authJson(data, response.status, cors);
  } catch (error) {
    console.error("containers_request_failed", error instanceof Error ? error.message : "unknown");
    return authJson({ error: "containers_unavailable" }, 503, cors);
  }
}
