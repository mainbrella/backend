import { jsonResponse } from "../shared/http";
import { handleAuthRequest } from "./auth";
import { handleIopRequest } from "./iop";
import { handleDirectoryRequest } from "./directory";
import { handleMapTileRequest } from "./map-tiles";
import { handleReviewsRequest } from "./reviews";
import { handleTourRequests } from "./tour-requests";
import { handleDirectoryHerdRequest } from "./directory-herd";
import { handleHerdRequest } from "./herds";
import { handleAppleIAPNotification } from "./apple-iap-notifications";
import { handleAdminRequest } from "./admin";

export async function handleRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/iap/apple/notifications") {
    return handleAppleIAPNotification(request, env);
  }

  if (url.pathname.startsWith("/map/")) {
    return handleMapTileRequest(request, env);
  }

  if (url.pathname.startsWith("/auth/")) {
    return handleAuthRequest(request, env);
  }

  if (url.pathname.startsWith("/admin/")) {
    return handleAdminRequest(request, env);
  }

  if (url.pathname.startsWith("/iop/")) {
    return handleIopRequest(request, env);
  }

  if (url.pathname === "/reviews" || url.pathname.startsWith("/reviews/")) {
    return handleReviewsRequest(request, env);
  }

  if (url.pathname === "/tour-requests" || url.pathname.startsWith("/tour-requests/")) {
    return handleTourRequests(request, env);
  }

  if (url.pathname.startsWith("/directory/")) {
    if (/^\/directory\/locations\/[^/]+\/herd(?:\/.*)?$/.test(url.pathname)) {
      return handleDirectoryHerdRequest(request, env);
    }
    return handleDirectoryRequest(request, env);
  }

  if (url.pathname === "/herds" || url.pathname.startsWith("/herds/")) {
    return handleHerdRequest(request, env);
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
