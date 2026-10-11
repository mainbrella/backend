import { handleMarketingEmailRequest, handleMarketingUnsubscribeRequest } from "./app/marketing-email";
import { jsonResponse } from "./shared/http";

export async function handleMarketingServiceRequest(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === "/api/send-marketing-email") return handleMarketingEmailRequest(request, env);
  if (path === "/api/unsubscribe") return handleMarketingUnsubscribeRequest(request, env);
  return jsonResponse({ error: "not_found" }, 404);
}

export default {
  fetch: handleMarketingServiceRequest,
} satisfies ExportedHandler<Env>;
