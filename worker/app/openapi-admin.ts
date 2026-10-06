import { z } from "zod";
import { cookieSecurity, errors, jsonResponse, register, userSchema, type LegacyHandler, type OpenAPIApi } from "./openapi-shared";

export function registerAdminRoutes(api: OpenAPIApi, handler: LegacyHandler): void {
  register(api, "get", "/admin/users", {
    operationId: "listAdminUsers",
    tags: ["Admin"],
    summary: "List all users, newest first",
    description: "Requires a browser session for oneone@gmail.com. Returns all users ordered by created_at descending, then id descending. Plan is based on the last synced active subscription with an unexpired period, or an unexpired trial when no subscription is recorded; otherwise none. This administrative snapshot does not verify paid access with Stripe. Excludes credentials and provider identifiers.",
    security: cookieSecurity,
    responses: {
      200: jsonResponse(z.object({ users: z.array(userSchema.extend({
        plan: z.enum(["none", "builder", "pro", "scale"]),
      }).openapi("AdminUser")) })),
      ...errors(401, 403, 405, 503),
    },
  }, handler);
}
