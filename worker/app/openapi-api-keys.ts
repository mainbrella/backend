import { z } from "zod";
import { cookieSecurity, errors, jsonResponse, okSchema, register, requestBody, type LegacyHandler, type OpenAPIApi } from "./openapi-shared";

const key = z.object({ id: z.string(), name: z.string(), prefix: z.string(), scope: z.enum(['account', 'bff']), created_at: z.string(), last_used_at: z.string().nullable() });
export function registerAPIKeyRoutes(api: OpenAPIApi, handler: LegacyHandler): void {
  register(api, "get", "/api-keys/me", {
    operationId: "getAPIKeyAccount", tags: ["API Keys"], summary: "Get the account identity authenticated by an API key",
    description: "Returns a stable account ID for recovery ownership checks, including after key rotation. Requires an account API key Bearer credential; scoped BFF browser keys and browser cookies do not authenticate this endpoint. Does not return personal details or the key secret.",
    security: [{ apiKeyBearer: [] }],
    responses: { 200: jsonResponse(z.object({ accountId: z.string() })), ...errors(401, 403, 503) },
  }, handler);
  register(api, "get", "/api-keys", {
    operationId: "listAPIKeys", tags: ["API Keys"], summary: "List your API keys without secrets", security: cookieSecurity,
    description: "Lists account keys and scoped BFF browser keys in the shared key store. Scope identifies account-wide automation versus project-specific BFF grants. Full tokens and hashes are never returned.",
    responses: { 200: jsonResponse(z.object({ keys: z.array(key) })), ...errors(401, 403, 503) },
  }, handler);
  register(api, "post", "/api-keys", {
    operationId: "createAPIKey", tags: ["API Keys"], summary: "Create a named API key", security: cookieSecurity,
    description: "Requires a trusted Origin and browser session. Maximum 20 account keys; scoped BFF keys have separate per-project limits. The secret is returned once; it authorizes container, image, SSH and BFF owner operations until revoked, subject to account entitlements. Account keys belong on trusted servers, not in public browser apps.",
    request: requestBody(z.object({ name: z.string().trim().min(1).max(80) })),
    responses: { 201: jsonResponse(z.object({ key, token: z.string() })), ...errors(400, 401, 403, 429, 503) },
  }, handler);
  register(api, "delete", "/api-keys", {
    operationId: "revokeAPIKey", tags: ["API Keys"], summary: "Revoke an API key", security: cookieSecurity,
    description: "Requires a trusted Origin and browser session. Revocation prevents subsequent API requests with this key, including BFF requests. Revoking a scoped BFF key also removes its project grants.",
    request: { query: z.object({ id: z.string().min(1) }) },
    responses: { 200: jsonResponse(okSchema), ...errors(400, 401, 403, 404, 503) },
  }, handler);
}
