import { z } from "zod";
import { cookieSecurity, errors, jsonResponse, okSchema, register, requestBody, type LegacyHandler, type OpenAPIApi } from "./openapi-shared";

const key = z.object({ id: z.string(), name: z.string(), prefix: z.string(), created_at: z.string(), last_used_at: z.string().nullable() });
export function registerAPIKeyRoutes(api: OpenAPIApi, handler: LegacyHandler): void {
  register(api, "get", "/api-keys", {
    operationId: "listAPIKeys", tags: ["API Keys"], summary: "List your API keys without secrets", security: cookieSecurity,
    responses: { 200: jsonResponse(z.object({ keys: z.array(key) })), ...errors(401, 403, 503) },
  }, handler);
  register(api, "post", "/api-keys", {
    operationId: "createAPIKey", tags: ["API Keys"], summary: "Create a named API key", security: cookieSecurity,
    description: "Requires a trusted Origin and browser session. Maximum 20 keys. The secret is returned once; it authorizes container, image and SSH operations until revoked, subject to account entitlements.",
    request: requestBody(z.object({ name: z.string().trim().min(1).max(80) })),
    responses: { 201: jsonResponse(z.object({ key, token: z.string() })), ...errors(400, 401, 403, 429, 503) },
  }, handler);
  register(api, "delete", "/api-keys", {
    operationId: "revokeAPIKey", tags: ["API Keys"], summary: "Revoke an API key", security: cookieSecurity,
    description: "Requires a trusted Origin and browser session. Revocation prevents subsequent API requests with this key.",
    request: { query: z.object({ id: z.string().min(1) }) },
    responses: { 200: jsonResponse(okSchema), ...errors(400, 401, 403, 404, 503) },
  }, handler);
}
