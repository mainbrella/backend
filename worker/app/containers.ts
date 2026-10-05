import { authCorsHeaders, authJson } from "./auth-core";
import { ownedImage } from "./images";
import { containerUser } from "./container-auth";

// All authenticated users currently resolve to Builder. UserContainer enforces
// its policy atomically; client-supplied plan/resource overrides are ignored.
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
  if (request.method !== "GET" && !request.headers.get("Origin") && !request.headers.has("Authorization")) {
    return authJson({ error: "origin_required" }, 403, cors);
  }
  try {
    const user = await containerUser(env, request);
    if (!user) return authJson({ error: "not_authenticated" }, 401, cors);
    if (!env.USER_CONTAINER) return authJson({ error: "containers_unavailable" }, 503, cors);
    let selection: { imageKey: string; imageId: string; imageName: string } | undefined;
    if (request.method === "POST" && request.body) {
      const body = await request.json().catch(() => null) as { imageId?: unknown } | null;
      if (!body || typeof body !== "object" || Array.isArray(body)) return authJson({ error: "invalid_request" }, 400, cors);
      if (body.imageId !== undefined) {
        if (typeof body.imageId !== "string") return authJson({ error: "invalid_request" }, 400, cors);
        const image = await ownedImage(env, user.id, body.imageId);
        if (!image) return authJson({ error: "image_not_found" }, 404, cors);
        if (image.status !== "ready") return authJson({ error: "image_not_ready" }, 409, cors);
        selection = { imageKey: image.image_key, imageId: image.id, imageName: image.name };
      }
    }
    // A single slot per account. Never accept a machine ID, size, lease, or image
    // from the browser, and never pass session cookies to the container service.
    const machine = env.USER_CONTAINER.get(env.USER_CONTAINER.idFromName(`user:${user.id}`));
    const response = await machine.fetch(new Request("https://internal/container", { method: request.method, ...(selection ? { body: JSON.stringify(selection), headers: { "Content-Type": "application/json" } } : {}) }));
    const data = await response.json();
    if (response.status === 409) return authJson({ error: data.error === "image_not_available" ? "image_not_available" : "container_limit_exceeded" }, 409, cors);
    if (response.status === 429) return authJson({ error: "container_quota_exceeded" }, 429, cors);
    if (!response.ok) throw new Error("machine_request_failed");
    return authJson(data, response.status, cors);
  } catch (error) {
    console.error("containers_request_failed", error instanceof Error ? error.message : "unknown");
    return authJson({ error: "containers_unavailable" }, 503, cors);
  }
}
