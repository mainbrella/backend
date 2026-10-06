import { validPreviewId, validPreviewToken } from '../containers/preview-contract.js';
import { previewDomain, previewsConfigured, previewTokenHash, prunePreviewRoutes, validPreviewGeneration,
  type PreviewRoute, type PreviewRoutingEnv } from './lib/preview-routing';

function unavailable(status = 404): Response {
  return new Response('Preview unavailable.', { status, headers: {
    'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store, no-transform',
    'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
  } });
}

export async function handlePreviewGateway(request: Request, env: PreviewRoutingEnv): Promise<Response> {
  const url = new URL(request.url);
  const domain = previewDomain(env);
  const host = request.headers.get('host');
  if (!domain || url.protocol !== 'https:' || url.port || (host && host.toLowerCase() !== url.host)) return unavailable();
  if (url.hostname === domain) {
    const target = new URL('https://mainbrella.com/');
    target.pathname = url.pathname;
    target.search = url.search;
    return Response.redirect(target.href, 308);
  }
  if (!previewsConfigured(env) || !url.hostname.endsWith(`.${domain}`)) return unavailable();
  const token = url.hostname.slice(0, -(domain.length + 1));
  if (!validPreviewToken(token)) return unavailable();
  try {
    const route = await env.PREVIEW_ROUTES!.prepare(`SELECT preview_id, container_name, created_at, expires_at
      FROM preview_routes WHERE token_hash = ? AND expires_at > ?`)
      .bind(await previewTokenHash(token), Date.now()).first<PreviewRoute>();
    if (!route || !validPreviewId(route.preview_id) || !validPreviewGeneration(route.created_at)
      || !Number.isSafeInteger(route.expires_at) || route.expires_at <= Date.now()
      || !/^user:[^\s]{1,200}$/.test(route.container_name)) return unavailable();
    const headers = new Headers(request.headers);
    for (const name of [...headers.keys()]) {
      if (name.startsWith('x-preview-') || name.startsWith('x-mainbrella-') || name.startsWith('x-exec-')
        || name.startsWith('x-terminal-') || name.startsWith('x-ssh-') || name.startsWith('cf-')
        || name.startsWith('x-forwarded-') || ['authorization', 'proxy-authorization', 'cookie', 'host',
          'forwarded', 'x-real-ip', 'referer'].includes(name)) headers.delete(name);
    }
    headers.set('x-preview-created-at', route.created_at);
    headers.set('x-preview-token', token);
    headers.set('x-preview-origin', url.origin);
    const target = new URL('https://internal');
    target.pathname = `/preview${url.pathname}`;
    target.search = url.search;
    const forwarded = new Request(target, { method: request.method, headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      signal: request.signal, redirect: 'manual', duplex: 'half' } as RequestInit);
    const stub = env.USER_CONTAINER!.get(env.USER_CONTAINER!.idFromName(route.container_name));
    // Preserve streaming bodies and Worker WebSocket responses. The private
    // runtime owns response sanitization, timeouts and active revocation.
    return await stub.fetch(forwarded);
  } catch {
    // Never log the request URL, hostname, token, DB exceptions or routing data.
    return unavailable(503);
  }
}

export default {
  fetch: handlePreviewGateway,
  async scheduled(_event: ScheduledController, env: PreviewRoutingEnv): Promise<void> {
    if (env.PREVIEW_ROUTES) await prunePreviewRoutes(env.PREVIEW_ROUTES).catch(() => {
      console.error('preview_cleanup_failed');
    });
  },
} satisfies ExportedHandler<PreviewRoutingEnv>;
