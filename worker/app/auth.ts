import {
  authCorsHeaders,
  authJson,
  currentUser,
  expiredSessionCookie,
  publicUser,
  revokeSession,
} from "./auth-core";
import { handleEmailLogin, handleGoogleLogin } from "./auth-login";
import { handleNativeEmailLogin, handleNativeGoogleLogin } from "./auth-login";
import { handleAppAnonymous, handleAppDelete, handleAppLogout, handleAppMe, handleAppRefresh } from "./auth-app";
import { handleNativeAppleLogin } from "./auth-apple";

export async function handleAuthRequest(request: Request, env: Env): Promise<Response> {
  const corsHeaders = authCorsHeaders(request);
  if (corsHeaders === null) return authJson({ error: "origin_not_allowed" }, 403, {});
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  const { pathname } = new URL(request.url);
  if (pathname === "/auth/app/anonymous" && request.method === "POST") {
    const address = request.headers.get("CF-Connecting-IP");
    if (!address || !env.ANONYMOUS_SIGNUP_LIMIT) {
      return authJson({ error: "auth_unavailable" }, 503, corsHeaders);
    }
    const { success } = await env.ANONYMOUS_SIGNUP_LIMIT.limit({ key: `anonymous:${address}` });
    if (!success) {
      return authJson({ error: "rate_limited" }, 429, { ...corsHeaders, "retry-after": "60" });
    }
    return handleAppAnonymous(env, corsHeaders);
  }
  if (pathname === "/auth/google" && request.method === "POST") {
    return handleGoogleLogin(request, env, corsHeaders);
  }
  if (pathname === "/auth/email" && request.method === "POST") {
    const address = request.headers.get("CF-Connecting-IP");
    if (!env.EMAIL_AUTH_LIMIT || !address) return authJson({ error: "auth_unavailable" }, 503, corsHeaders);
    const { success } = await env.EMAIL_AUTH_LIMIT.limit({ key: `email:${address}` });
    if (!success) return authJson({ error: "rate_limited" }, 429, { ...corsHeaders, "retry-after": "60" });
    return handleEmailLogin(request, env, corsHeaders);
  }
  if (pathname === "/auth/app/google" && request.method === "POST") {
    return handleNativeGoogleLogin(request, env, corsHeaders);
  }
  if (pathname === "/auth/app/email" && request.method === "POST") {
    return handleNativeEmailLogin(request, env, corsHeaders);
  }
  if (pathname === "/auth/app/apple" && request.method === "POST") {
    return handleNativeAppleLogin(request, env, corsHeaders);
  }
  if (pathname === "/auth/app/me" && request.method === "GET") {
    return handleAppMe(request, env, corsHeaders);
  }
  if (pathname === "/auth/app/me" && request.method === "DELETE") {
    return handleAppDelete(request, env, corsHeaders);
  }
  if (pathname === "/auth/app/refresh" && request.method === "POST") {
    return handleAppRefresh(request, env, corsHeaders);
  }
  if (pathname === "/auth/app/logout" && request.method === "POST") {
    return handleAppLogout(request, env, corsHeaders);
  }
  if (pathname === "/auth/me" && request.method === "GET") {
    try {
      const user = await currentUser(env, request);
      return authJson({ user: user ? publicUser(user) : null }, 200, corsHeaders);
    } catch (error) {
      console.error("auth_me_error", error);
      return authJson({ error: "auth_unavailable" }, 503, corsHeaders);
    }
  }
  if (pathname === "/auth/logout" && request.method === "POST") {
    try {
      await revokeSession(env, request);
      return authJson({ ok: true }, 200, { ...corsHeaders, "set-cookie": expiredSessionCookie() });
    } catch (error) {
      console.error("auth_logout_error", error);
      return authJson({ error: "auth_unavailable" }, 503, corsHeaders);
    }
  }

  return authJson({ error: "not_found" }, 404, corsHeaders);
}
