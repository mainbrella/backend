import { operatorAuthorized, infrastructureError } from '../lib/security-infrastructure';

export async function handleSecurityAcknowledgment(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const match = /^\/(runs|control)\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})(?:\/([a-z0-9-]+))?$/.exec(url.pathname);
  if (!match || url.search || !env.SECURITY_ACK) return infrastructureError('not_found', 404);
  if (match[1] === 'control' && !await operatorAuthorized(request, env.SECURITY_ACK_CONTROL_TOKEN)) return infrastructureError('not_authorized', 403);
  return env.SECURITY_ACK.get(env.SECURITY_ACK.idFromName(match[2])).fetch(request);
}
