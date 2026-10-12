import { operatorAuthorized, infrastructureError } from '../lib/security-infrastructure';

export async function handleSecurityRelay(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== '/v1/egress' || url.search || request.method !== 'POST') return infrastructureError('egress_denied', 403);
  if (!await operatorAuthorized(request, env.EGRESS_RELAY_TOKEN)) return infrastructureError('egress_denied', 403);
  if (!env.EGRESS_RELAY) return infrastructureError('egress_unavailable', 503);
  try {
    // Authentication happens before touching the native runtime. The Node relay
    // performs envelope validation, DNS checks, IP pinning and TLS verification.
    return await env.EGRESS_RELAY.get(env.EGRESS_RELAY.idFromName('relay')).fetch(request);
  } catch { return infrastructureError('egress_unavailable', 503); }
}
