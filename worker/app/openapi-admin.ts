import { z } from "zod";
import { cookieSecurity, errors, jsonResponse, register, userSchema, type LegacyHandler, type OpenAPIApi } from "./openapi-shared";

export function registerAdminRoutes(api: OpenAPIApi, handler: LegacyHandler): void {
  register(api, "get", "/admin/users", {
    operationId: "listAdminUsers",
    tags: ["Admin"],
    summary: "List all users, newest first",
    description: "Requires a browser session for oneone@gmail.com. Returns all users ordered by created_at descending, then id descending. Excludes credentials and provider identifiers.",
    security: cookieSecurity,
    responses: {
      200: jsonResponse(z.object({ users: z.array(userSchema) })),
      ...errors(401, 403, 405, 503),
    },
  }, handler);
}
