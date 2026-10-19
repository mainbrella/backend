import { authCorsHeaders, authJson } from "../app/auth-core";

export async function forwardServiceRequest(request: Request, service: Fetcher | undefined, error: string, env: Env): Promise<Response> {
  if (service) {
    try {
      // Preserve cookies, Origin, method, query, and streaming bodies. The target
      // Worker owns authentication and validation and supplies its own context.
      return await service.fetch(request);
    } catch {
      console.error(error);
    }
  }
  const cors = authCorsHeaders(request, env);
  if (cors === null) return authJson({ error: "origin_not_allowed" }, 403, {});
  return authJson({ error }, 503, cors);
}
