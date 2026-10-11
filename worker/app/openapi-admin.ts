import { z } from "zod";
import { cookieSecurity, errors, jsonResponse, register, userSchema, type LegacyHandler, type OpenAPIApi } from "./openapi-shared";
import { prepaidBalanceSchema } from "./openapi-prepaid-billing";

const adminUser = userSchema.extend({ plan: z.enum(["none", "builder", "pro", "scale"]) }).openapi("AdminUser");
const funding = z.object({ id: z.string(), createdAt: z.number(), amountCents: z.number(), revokedCents: z.number(), reason: z.enum(["refund", "dispute"]).nullable() });

export function registerAdminRoutes(api: OpenAPIApi, handler: LegacyHandler): void {
  register(api, "get", "/admin/users", {
    operationId: "listAdminUsers",
    tags: ["Admin"],
    summary: "List all users, newest first",
    description: "Requires a browser session for oneone@gmail.com. Returns all users ordered by created_at descending, then id descending. Plan is based on the last synced active subscription with an unexpired period, or an unexpired trial when no subscription is recorded; otherwise none. This administrative snapshot does not verify paid access with Stripe. Excludes credentials and provider identifiers.",
    security: cookieSecurity,
    responses: {
      200: jsonResponse(z.object({ users: z.array(adminUser) })),
      ...errors(401, 403, 405, 503),
    },
  }, handler);
  register(api, "get", "/admin/users/{userId}", {
    operationId: "getAdminUserDetail",
    tags: ["Admin"],
    summary: "Get a user's plan, prepaid balance and funding history",
    description: "Requires a browser session for oneone@gmail.com. Returns the same safe user fields as the admin user list, a current prepaid balance snapshot, and newest-first prepaid funding history. This read-only request accesses only the selected user's account service and makes no Stripe requests or billing mutations. It excludes account identifiers, saved payment details, credentials and provider identifiers.",
    security: cookieSecurity,
    request: {
      params: z.object({ userId: z.string().min(1).max(200) }),
      query: z.object({ limit: z.coerce.number().int().min(1).max(100).optional(), fundingCursor: z.string().min(1).max(200).optional() }),
    },
    responses: {
      200: jsonResponse(z.object({ user: adminUser, asOf: z.number(), balance: prepaidBalanceSchema,
        fundings: z.array(funding), nextFundingCursor: z.string().nullable() })),
      ...errors(400, 401, 403, 404, 405, 503),
    },
  }, handler);
}
