import { handleAdminRequest } from "./app/admin";
import { handleAccountingRequest } from "./app/accounting";
import { handleAdminAcquisitionRequest } from "./app/admin-acquisition";
import { handleAdminStorageBillingRequest } from "./app/admin-storage-billing";
import { jsonResponse } from "./shared/http";

export async function handleAdminServiceRequest(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === "/admin/acquisition/leads" || path === "/admin/acquisition/events") {
    return handleAdminAcquisitionRequest(request, env);
  }
  if (path === "/admin/accounting/storage-invoices") return handleAdminStorageBillingRequest(request, env);
  if (path.startsWith("/admin/accounting/")) return handleAccountingRequest(request, env);
  if (path.startsWith("/admin/") || path === "/api/get-marketing-users") return handleAdminRequest(request, env);
  return jsonResponse({ error: "not_found" }, 404);
}

export default {
  fetch: handleAdminServiceRequest,
} satisfies ExportedHandler<Env>;
