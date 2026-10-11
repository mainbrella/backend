import { z } from "zod";
import { marketingEmailSchema, marketingUnsubscribeSchema } from "../lib/marketing-email";
import { cookieSecurity, errors, jsonResponse, register, requestBody, type LegacyHandler, type OpenAPIApi } from "./openapi-shared";

export function registerMarketingEmailRoutes(api: OpenAPIApi, handler: LegacyHandler): void {
  register(api, "post", "/api/send-marketing-email", {
    operationId: "sendMarketingEmail",
    tags: ["Admin"],
    summary: "Send one marketing email using the Mainbrella template",
    description: "Requires a browser session for oneone@gmail.com and a trusted Origin header. The from field accepts one bare email address or Name <address> from an onboarded Cloudflare Email Sending domain. The message is plain text, escaped and inserted between the template header and footer with line breaks preserved; a plain-text alternative is included. Both parts include an unsubscribe link to https://mainbrella.com/unsubscribe?email=<encoded recipient>. Checks the user's marketing_email_unsubscribed flag and the address opt-out before every send; opted-out recipients return 409 recipient_unsubscribed without sending. Preference lookup failures return 503 email_preferences_unavailable without sending. Maximum JSON body size is 1 MiB. Waits for Email Sending to accept the message and returns its message ID, which does not confirm inbox delivery. No automatic retries. Local Wrangler development simulates sending.",
    security: cookieSecurity,
    request: {
      headers: z.object({ Origin: z.string().url().describe("Trusted browser origin, such as https://raindrop.mainbrella.com.") }),
      ...requestBody(marketingEmailSchema),
    },
    responses: {
      202: jsonResponse(z.object({ ok: z.literal(true), messageId: z.string() }), "Email accepted by Cloudflare Email Sending."),
      ...errors(400, 401, 403, 405, 409, 413, 429, 502, 503),
    },
  }, handler);

  register(api, "post", "/api/unsubscribe", {
    operationId: "unsubscribeMarketingEmail",
    tags: ["Marketing"],
    summary: "Permanently unsubscribe an email address from marketing emails",
    description: "Public endpoint; no login, cookie or bearer token is required. The supplied email address is trimmed and lowercased, saved as a permanent address opt-out, and all matching users have marketing_email_unsubscribed set to true. The current session does not determine the recipient. Repeated requests are idempotent, and registered and unregistered addresses receive the same confirmation. The unsubscribe page calls this automatically using its email query parameter. Maximum JSON body size is 4 KiB. A supplied Origin must be trusted.",
    security: [],
    request: requestBody(marketingUnsubscribeSchema),
    responses: {
      200: jsonResponse(z.object({ ok: z.literal(true) }), "The address is unsubscribed from marketing emails."),
      ...errors(400, 403, 405, 413, 503),
    },
  }, handler);
}
