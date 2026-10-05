import { handleAPIKeysRequest } from "./api-keys";
import { createOpenAPIApp } from "./openapi";
import { syncAccountEntitlement } from "../lib/container-service";
import { jsonResponse } from "../shared/http";
import { handleAuthRequest } from "./auth";
import { handleSubscriptionRequest } from "./subscription";
import { handleAdminRequest } from "./admin";
import { handleContainersRequest } from "./containers";
import { handleSSHRequest } from "./ssh";
import { handleImagesRequest, handleImageBuildRequest } from "./images";
import { handleTerminalRequest } from "./terminal";
import { handleCommandRequest } from "./commands";
import { handleFileRequest } from "./files";
import { handleCapabilitiesRequest } from './capabilities';
import { handleExecutionRequest } from './executions';
import { handleStatusRequest } from './status';

async function handleLegacyRequest(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === '/capabilities') return handleCapabilitiesRequest(request, env);
  if (['/status', '/status/history', '/internal/status/observations', '/internal/status/incidents'].includes(url.pathname)) return handleStatusRequest(request, env);
  if (url.pathname === '/containers/executions' || url.pathname.startsWith('/containers/executions/')) return handleExecutionRequest(request, env);

  if (url.pathname === "/api-keys") return handleAPIKeysRequest(request, env);

  if (url.pathname === "/images" || url.pathname.startsWith("/images/")) return handleImagesRequest(request, env);
  if (url.pathname.startsWith("/internal/image-builds/")) return handleImageBuildRequest(request, env);

  if (url.pathname === "/containers/terminal") return handleTerminalRequest(request, env);
  if (url.pathname === "/containers/exec") return handleCommandRequest(request, env);
  if (url.pathname === "/containers/files") return handleFileRequest(request, env);

  if (url.pathname === "/containers/ssh" || url.pathname.startsWith("/ssh/")) {
    return handleSSHRequest(request, env);
  }

  if (url.pathname === "/containers" || url.pathname.startsWith("/containers/")) {
    return handleContainersRequest(request, env, ctx);
  }

  if (url.pathname === "/subscription" || url.pathname.startsWith("/subscription/")) {
    return handleSubscriptionRequest(request, env, (userId, entitlement) => syncAccountEntitlement(env, userId, entitlement));
  }

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

export const app = createOpenAPIApp(handleLegacyRequest);

export async function handleRequest(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  // Hono supplies automatic HEAD handling; retain the existing method policy.
  if (request.method === "HEAD") return handleLegacyRequest(request, env, ctx);
  return app.fetch(request, env, ctx);
}
