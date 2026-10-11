import { handleRequest as handleAPIRequest } from './router';
import { handleAdminServiceRequest } from '../admin';
import { handleMarketingServiceRequest } from '../marketing';

// Feature tests use the production gateway and the actual target handlers.
// Bind against the current fixture so credential/binding changes remain visible.
export function handleRequest(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  return handleAPIRequest(request, {
    ...env,
    ADMIN_API: { fetch: (request: Request) => handleAdminServiceRequest(request, env) } as unknown as Fetcher,
    MARKETING_API: { fetch: (request: Request) => handleMarketingServiceRequest(request, env) } as unknown as Fetcher,
  }, ctx);
}
