import { z } from "zod";
import { marketingEmailSchema } from "../lib/marketing-email";
import { cookieSecurity, errors, jsonResponse, register, requestBody, type LegacyHandler, type OpenAPIApi } from "./openapi-shared";

export function registerMarketingEmailRoutes(api: OpenAPIApi, handler: LegacyHandler): void {
  register(api, "post", "/api/send-marketing-email", {
    operationId: "sendMarketingEmail",
    tags: ["Admin"],
    summary: "Send one marketing email using the Mainbrella template",
    description: "Requires a browser session for oneone@gmail.com and a trusted Origin header. The from field accepts one bare email address or Name <address> from an onboarded Cloudflare Email Sending domain. The message is plain text, escaped and inserted between the template header and footer with line breaks preserved; a plain-text alternative is included. Maximum JSON body size is 1 MiB. Waits for Email Sending to accept the message and returns its message ID, which does not confirm inbox delivery. No automatic retries. Local Wrangler development simulates sending.",
    security: cookieSecurity,
    request: {
      headers: z.object({ Origin: z.string().url().describe("Trusted browser origin, such as https://raindrop.mainbrella.com.") }),
      ...requestBody(marketingEmailSchema),
    },
    responses: {
      202: jsonResponse(z.object({ ok: z.literal(true), messageId: z.string() }), "Email accepted by Cloudflare Email Sending."),
      ...errors(400, 401, 403, 405, 413, 429, 502, 503),
    },
  }, handler);
}
