import { z } from "zod";
import { cookieSecurity, errors, jsonResponse, nativeSecurity, okSchema, register, requestBody, userSchema, type LegacyHandler, type OpenAPIApi } from "./openapi-shared";

const tokens = z.object({ access_token: z.string(), refresh_token: z.string(),
  token_type: z.literal("Bearer"), expires_in: z.number(), user: userSchema }).openapi("NativeTokens");
const refresh = z.object({ refresh_token: z.string() });

export function registerAuthRoutes(api: OpenAPIApi, handler: LegacyHandler): void {
  const credentials = {
    google: z.object({ credential: z.string() }),
    email: z.object({ email: z.string(), password: z.string() }),
    apple: z.object({ identity_token: z.string(), nonce: z.string(), name: z.string().optional() }),
  };
  for (const provider of ["google", "email"] as const) {
    register(api, "post", `/auth/${provider}`, {
      operationId: `${provider}Login`, tags: ["Authentication"], summary: `Sign in with ${provider} and create a browser session`,
      security: [],
      ...(provider === "email" ? { description: "Signs in an existing password account or creates an account when the email is unused. New passwords require 8–128 characters. Email is trimmed and lowercased. A welcome email is sent after account creation; delivery failures do not fail signup. No verification email is sent. Existing provider-only accounts must use their provider. Limited to 20 attempts per minute per IP." } : { description: "New accounts receive a welcome email; delivery failures do not fail signup. Existing accounts and provider linking do not send another welcome email." }),
      request: requestBody(provider === "email" ? z.object({ email: z.string().email().max(254), password: z.string().min(1).max(128) }) : credentials[provider]),
      responses: { 200: jsonResponse(z.object({ user: userSchema, created: z.boolean() })), ...errors(400, 401, 403, ...(provider === "email" ? [429] : [409]), 500, 503) },
    }, handler);
  }
  for (const provider of ["google", "email", "apple"] as const) {
    register(api, "post", `/auth/app/${provider}`, {
      operationId: `native${provider[0].toUpperCase()}${provider.slice(1)}Login`, tags: ["Authentication"], summary: `Sign in with ${provider} for a native app`,
      security: [],
      ...(provider !== "email" ? { description: "New accounts receive a welcome email; delivery failures do not fail signup. Existing accounts and provider linking do not send another welcome email." } : {}),
      request: requestBody(credentials[provider]), responses: { 200: jsonResponse(tokens), ...errors(400, 401, 403, 409, 500, 503) },
    }, handler);
  }
  register(api, "post", "/auth/app/anonymous", {
    operationId: "nativeAnonymousLogin", tags: ["Authentication"], summary: "Create an anonymous native account",
    responses: { 200: jsonResponse(tokens), ...errors(403, 429, 503) },
  }, handler);
  register(api, "get", "/auth/me", {
    operationId: "getBrowserUser", tags: ["Authentication"], summary: "Get the browser session user",
    description: "Returns user: null when there is no browser session.",
    security: [{}, ...cookieSecurity], responses: { 200: jsonResponse(z.object({ user: userSchema.nullable() })), ...errors(403, 503) },
  }, handler);
  register(api, "post", "/auth/logout", {
    operationId: "browserLogout", tags: ["Authentication"], summary: "Revoke the browser session", security: cookieSecurity,
    responses: { 200: jsonResponse(okSchema), ...errors(403, 503) },
  }, handler);
  register(api, "get", "/auth/app/me", {
    operationId: "getNativeUser", tags: ["Authentication"], summary: "Get the native app user", security: nativeSecurity,
    responses: { 200: jsonResponse(z.object({ user: userSchema })), ...errors(401, 403) },
  }, handler);
  register(api, "delete", "/auth/app/me", {
    operationId: "deleteNativeAccount", tags: ["Authentication"], summary: "Delete the native app account", security: nativeSecurity,
    description: "Linked providers require fresh provider credentials before deletion. Git R2 cleanup is queued durably in the same database transaction before deleting the account; retained financial evidence survives account deletion.",
    request: requestBody(z.object({ google_id_token: z.string().optional(), google_access_token: z.string().optional(),
      apple_identity_token: z.string().optional(), apple_nonce: z.string().optional(), apple_authorization_code: z.string().optional() }), false),
    responses: { 200: jsonResponse(z.object({ deleted: z.boolean() })), ...errors(401, 403, 409, 502, 503) },
  }, handler);
  register(api, "post", "/auth/app/refresh", {
    operationId: "refreshNativeTokens", tags: ["Authentication"], summary: "Rotate native app tokens", request: requestBody(refresh),
    responses: { 200: jsonResponse(tokens), ...errors(400, 401, 403, 503) },
  }, handler);
  register(api, "post", "/auth/app/logout", {
    operationId: "nativeLogout", tags: ["Authentication"], summary: "Revoke native app tokens",
    description: "Revokes the refresh token and, if supplied, the matching Bearer access token.",
    security: [{}, ...nativeSecurity], request: requestBody(refresh), responses: { 200: jsonResponse(okSchema), ...errors(400, 403, 503) },
  }, handler);
}
