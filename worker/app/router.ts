import { jsonResponse } from "../shared/http";
import { handleAuthRequest } from "./auth";
import { handleAdminRequest } from "./admin";

export async function handleRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname.startsWith("/auth/")) {
    return handleAuthRequest(request, env);
  }

  if (url.pathname.startsWith("/admin/")) {
    return handleAdminRequest(request, env);
  }

  if (url.pathname === "/health") {
    return jsonResponse({ ok: true });
  }

  if (url.pathname === "/state") {
    return handleState(request, env);
  }

  return jsonResponse({ error: "not_found" }, 404);
}

async function handleState(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") {
    return jsonResponse({ error: "method_not_allowed" }, 405, {
      allow: "GET",
    });
  }

  if (!env.APP_STATE) {
    return jsonResponse({ error: "durable_object_unavailable" }, 503);
  }

  const state = env.APP_STATE.get(env.APP_STATE.idFromName("global"));
  return state.fetch(new Request("https://internal/state", request));
}
