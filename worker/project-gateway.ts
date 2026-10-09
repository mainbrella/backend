import { machineName, validContainerId } from '../containers/container-account-core.js';
import { projectHeaders, validProjectRevision } from '../containers/project-contract.js';
import { validPrivatePort, validServiceName } from '../containers/private-services-contract.js';
import { previewDomain, validPreviewGeneration } from './lib/preview-routing';
import { projectHostingConfigured, projectOrigin, validProjectId,
  type ProjectEndpointRoute, type ProjectHostingEnv } from './lib/project-hosting';

export type ProjectGatewayEnv = ProjectHostingEnv;
type ProjectHost = { hostname: string; project_id: string; status: string; verification_token: string };

function unavailable(status = 404): Response {
  return new Response('Project unavailable.', { status, headers: {
    'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store, no-transform',
    'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
  } });
}

function canonicalHost(host: string | null): host is string {
  return Boolean(host && host.length <= 253 && host === host.toLowerCase()
    && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host)
    && host !== 'mainbrella.com' && !host.endsWith('.mainbrella.com'));
}

function ingressAuthenticated(request: Request, env: ProjectGatewayEnv): boolean {
  const configured = env.PROJECT_INGRESS_SECRET;
  const supplied = request.headers.get('x-project-ingress-secret');
  if (!configured || configured.length < 32 || !supplied) return false;
  // Compare every configured byte without a matching-prefix early exit.
  let mismatch = supplied.length ^ configured.length;
  for (let i = 0; i < configured.length; i++) mismatch |= configured.charCodeAt(i) ^ (supplied.charCodeAt(i) || 0);
  return mismatch === 0;
}

async function projectHost(database: D1Database, hostname: string): Promise<ProjectHost | null> {
  const row = await database.prepare(`SELECT hostname, project_id, status, verification_token FROM project_hosts WHERE hostname = ?`)
    .bind(hostname).first<ProjectHost>();
  return row && row.hostname === hostname && validProjectId(row.project_id)
    && ['pending_tls', 'active'].includes(row.status)
    && typeof row.verification_token === 'string' && row.verification_token.startsWith('mainbrella-verification=')
    && validProjectId(row.verification_token.slice('mainbrella-verification='.length)) ? row : null;
}

async function routeTarget(route: ProjectEndpointRoute, env: ProjectGatewayEnv): Promise<boolean> {
  if (!validProjectId(route.project_id) || !validProjectRevision(route.revision)
    || !/^[a-zA-Z0-9_-]{1,128}$/.test(route.user_id) || !validPreviewGeneration(route.created_at)
    || !validPrivatePort(route.port)) return false;
  const target = JSON.parse(route.target_json);
  if (!target || typeof target !== 'object' || Array.isArray(target)) return false;
  const endpoint = target.kind === 'container' ? target : target.kind === 'network' ? target.snapshot : null;
  if (!endpoint || typeof endpoint !== 'object' || Array.isArray(endpoint) || !validContainerId(endpoint.id) || endpoint.createdAt !== route.created_at
    || endpoint.port !== route.port || machineName(route.user_id, endpoint.id) !== route.container_name) return false;
  if (target.kind === 'container') return Object.keys(target).length === 4;
  if (Object.keys(target).length !== 4 || Object.keys(endpoint).length !== 3
    || !validServiceName(target.network) || !validServiceName(target.service) || !env.CONTAINER_ACCOUNT) return false;
  const accounts = env.CONTAINER_ACCOUNT as unknown as {
    idFromName(name: string): DurableObjectId;
    get(id: DurableObjectId): { fetch(request: Request): Promise<Response> };
  };
  const account = accounts.get(accounts.idFromName(`account:${route.user_id}`));
  const response = await account.fetch(new Request('https://internal/private-services/networks', {
    headers: { 'x-mainbrella-user': route.user_id }, signal: AbortSignal.timeout(10_000),
  }));
  if (!response.ok) return false;
  const data = await response.json() as { networks?: { name: string; members?: { id: string; createdAt: string; name: string; port?: number }[] }[] };
  return Array.isArray(data.networks) && data.networks.some(network => network.name === target.network
    && Array.isArray(network.members) && network.members.some(member => member.name === target.service
      && member.id === endpoint.id && member.createdAt === route.created_at && member.port === route.port));
}

export async function handleProjectGateway(request: Request, env: ProjectGatewayEnv): Promise<Response> {
  const url = new URL(request.url);
  const hostHeader = request.headers.get('host');
  if (!projectHostingConfigured(env) || hostHeader && hostHeader.toLowerCase() !== url.host
    || env.LOCAL_DEV !== 'true' && (url.protocol !== 'https:' || url.port)) return unavailable();
  const domain = previewDomain(env)!;
  const ingress = canonicalHost(env.PROJECT_INGRESS_HOST ?? null) && url.hostname === env.PROJECT_INGRESS_HOST;
  if (ingress && !ingressAuthenticated(request, env)) return unavailable(403);
  try {
    if (ingress && url.pathname === '/internal/projects/certificate') {
      const hostname = url.searchParams.get('domain');
      if (request.method !== 'GET' || !canonicalHost(hostname) || url.searchParams.getAll('domain').length !== 1
        || [...url.searchParams.keys()].some(key => key !== 'domain') || hostname === domain || hostname.endsWith(`.${domain}`)) return unavailable(403);
      return await projectHost(env.PREVIEW_ROUTES!, hostname) ? new Response(null, { status: 200, headers: { 'cache-control': 'no-store' } }) : unavailable(403);
    }
    const hostname = ingress ? request.headers.get('x-project-original-host') : url.hostname;
    if (ingress && (!canonicalHost(hostname) || hostname === env.PROJECT_INGRESS_HOST)) return unavailable(403);
    let projectId: string;
    let origin: string;
    if (hostname?.endsWith(`.${domain}`)) {
      const label = hostname.slice(0, -(domain.length + 1));
      if (!/^p-[a-f0-9]{32}$/.test(label) || ingress) return unavailable();
      const id = label.slice(2);
      projectId = `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
      if (!validProjectId(projectId)) return unavailable();
      origin = projectOrigin(env, projectId);
      if (origin !== url.origin) return unavailable();
    } else {
      if (!canonicalHost(hostname) || hostname === domain) return unavailable();
      const customHost = await projectHost(env.PREVIEW_ROUTES!, hostname);
      if (!customHost) return unavailable();
      if (url.pathname === '/.well-known/mainbrella-domain-check') {
        if (request.method !== 'GET' && request.method !== 'HEAD') return unavailable();
        return new Response(request.method === 'HEAD' ? null : customHost.verification_token, { headers: {
          'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        } });
      }
      if (customHost.status !== 'active') return unavailable();
      projectId = customHost.project_id;
      origin = `https://${hostname}`;
    }
    const route = await env.PREVIEW_ROUTES!.prepare(`SELECT project_id, user_id, target_json, container_name, created_at, port, revision, updated_at
      FROM project_endpoints WHERE project_id = ?`).bind(projectId).first<ProjectEndpointRoute>();
    if (!route || route.project_id !== projectId || !await routeTarget(route, env)) return unavailable();
    const headers = projectHeaders(request.headers);
    headers.set('x-project-id', projectId);
    headers.set('x-project-revision', route.revision);
    headers.set('x-project-created-at', route.created_at);
    headers.set('x-project-origin', origin);
    const target = new URL('https://internal');
    target.pathname = `/project${url.pathname}`;
    target.search = url.search;
    const forwarded = new Request(target, { method: request.method, headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      signal: request.signal, redirect: 'manual', duplex: 'half' } as RequestInit);
    return await env.USER_CONTAINER!.get(env.USER_CONTAINER!.idFromName(route.container_name)).fetch(forwarded);
  } catch { return unavailable(503); }
}
