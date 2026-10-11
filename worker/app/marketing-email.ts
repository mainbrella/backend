import { boundedPrivateBody } from "../../containers/private-services-contract.js";
import { marketingEmailSchema, sendMarketingEmail } from "../lib/marketing-email";
import { ADMIN_EMAIL } from "./admin";
import { authCorsHeaders, authJson, currentUser } from "./auth-core";

const MAX_REQUEST_BYTES = 1024 * 1024;

export async function handleMarketingEmailRequest(request: Request, env: Env): Promise<Response> {
  const cors = authCorsHeaders(request);
  if (cors === null) return authJson({ error: "origin_not_allowed" }, 403, {});
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") {
    return authJson({ error: "method_not_allowed" }, 405, { ...cors, allow: "POST, OPTIONS" });
  }
  if (!request.headers.get("Origin")) return authJson({ error: "origin_required" }, 403, cors);

  let user;
  try {
    user = await currentUser(env, request);
  } catch (error) {
    console.error("marketing_email_auth_failed", error);
    return authJson({ error: "admin_unavailable" }, 503, cors);
  }
  if (!user) return authJson({ error: "unauthorized" }, 401, cors);
  if (user.email?.trim().toLowerCase() !== ADMIN_EMAIL) return authJson({ error: "forbidden" }, 403, cors);

  let body: unknown;
  try {
    if (Number(request.headers.get("content-length")) > MAX_REQUEST_BYTES) throw new Error("request_too_large");
    const bytes = await boundedPrivateBody(request.body, MAX_REQUEST_BYTES);
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    const tooLarge = error instanceof Error && error.message === "request_too_large";
    return authJson({ error: tooLarge ? "request_too_large" : "invalid_request" }, tooLarge ? 413 : 400, cors);
  }
  const input = marketingEmailSchema.safeParse(body);
  if (!input.success) return authJson({ error: "invalid_request" }, 400, cors);
  if (!env.MARKETING_EMAIL) return authJson({ error: "email_sending_unavailable" }, 503, cors);

  try {
    const result = await sendMarketingEmail(env.MARKETING_EMAIL, input.data);
    if (!result?.messageId) throw new Error("missing_message_id");
    // Acceptance by Email Sending does not confirm delivery to the inbox.
    return authJson({ ok: true, messageId: result.messageId }, 202, cors);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    console.error("marketing_email_send_failed", user.id, code);
    const limited = code === "E_RATE_LIMIT_EXCEEDED" || code === "E_DAILY_LIMIT_EXCEEDED";
    return authJson({ error: limited ? "email_rate_limited" : "email_send_failed" }, limited ? 429 : 502, cors);
  }
}
