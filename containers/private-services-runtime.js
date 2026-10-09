import { validContainerId } from './container-account-core.js';
import { validPrivateMember, validServiceName, validPrivateGeneration, PRIVATE_TIMEOUT_MS,
  privateTarget, privateHeaders, boundedPrivateBody } from './private-services-contract.js';

const KEY = 'privateServiceRegistration';
const denied = () => Response.json({ error: 'private_service_denied' }, { status: 403 });

export async function relayPrivateService(request, env, props) {
  if (!privateTarget(request) || !env.CONTAINER_ACCOUNT || !props
    || !/^[A-Za-z0-9_-]{1,128}$/.test(props.userId ?? '') || !validContainerId(props.id ?? '')
    || !validPrivateGeneration(props.createdAt)) return denied();
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(PRIVATE_TIMEOUT_MS)]);
  let abort;
  const deadline = new Promise((_, reject) => {
    abort = () => reject(new Error('private_service_timeout'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  const operation = (async () => {
    const headers = privateHeaders(request.headers);
    // These attestations come from WorkerEntrypoint props installed by the DO,
    // never from guest headers or API credentials in the guest environment.
    headers.set('x-mainbrella-user', props.userId);
    headers.set('x-private-source-id', props.id);
    headers.set('x-private-source-generation', props.createdAt);
    const bytes = await boundedPrivateBody(request.body, undefined, signal);
    const account = env.CONTAINER_ACCOUNT.get(env.CONTAINER_ACCOUNT.idFromName(`account:${props.userId}`));
    return account.fetch(new Request(request.url, { method: request.method, headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : bytes,
      signal, redirect: 'manual' }));
  })();
  try {
    return await Promise.race([operation, deadline]);
  } catch (error) {
    return Response.json({ error: error.message === 'request_too_large' ? 'request_too_large' : 'private_service_unavailable' },
      { status: error.message === 'request_too_large' ? 413 : 502 });
  } finally { signal.removeEventListener('abort', abort); }
}

export class ContainerPrivateServices {
  constructor(controller, entrypoint) { this.controller = controller; this.entrypoint = entrypoint; }
  async restore() {
    const c = this.controller, registration = await c.ctx.storage.get(KEY), owner = await c.ctx.storage.get('activityOwner');
    if (!registration || !owner || !await this.metadata(registration.createdAt)) return;
    await c.container.interceptOutboundHttp('*.internal', this.entrypoint({ userId: owner.userId, id: owner.containerId, createdAt: registration.createdAt }));
  }
  async metadata(createdAt) {
    const c = this.controller, metadata = await c.ctx.storage.get('builderMachine');
    return metadata && c.container.running && await c.hasPaidAccess() && c.now() < c.deadline(metadata)
      && new Date(metadata.createdAt).toISOString() === createdAt ? metadata : null;
  }
  async manage(request) {
    const c = this.controller, path = new URL(request.url).pathname;
    return c.serialized(async () => {
      const createdAt = request.headers.get('x-private-generation');
      if (!await this.metadata(createdAt)) return c.respond({ error: 'container_not_running' }, 409);
      if (path === '/private-services/status' && request.method === 'GET') return c.respond({ running: true, createdAt });
      if (path !== '/private-services/configure' || request.method !== 'PUT') return c.respond({ error: 'not_found' }, 404);
      const body = await request.json(), { network, ...member } = body;
      const owner = await c.ctx.storage.get('activityOwner');
      if (!validServiceName(network) || !validPrivateMember(member) || !validContainerId(member.id)
        || member.createdAt !== createdAt || !owner || owner.containerId !== member.id
        || owner.userId !== request.headers.get('x-mainbrella-user')) return c.respond({ error: 'invalid_request' }, 400);
      if (typeof c.container.interceptOutboundHttp !== 'function') return c.respond({ error: 'private_services_unavailable' }, 503);
      // Native HTTP interception only; arbitrary TCP and HTTPS are not advertised.
      // Installing the handler does not enable a preview or change Internet policy.
      await c.container.interceptOutboundHttp('*.internal', this.entrypoint({ userId: owner.userId, id: member.id, createdAt }));
      await c.ctx.storage.put(KEY, { network, ...member });
      return c.respond({ configured: true });
    });
  }
  async forward(request) {
    const c = this.controller, target = privateTarget(request);
    if (!target) return denied();
    const createdAt = request.headers.get('x-private-generation');
    const network = request.headers.get('x-private-network');
    const name = request.headers.get('x-private-name');
    const port = Number(request.headers.get('x-private-port'));
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(PRIVATE_TIMEOUT_MS)]);
    let upstream;
    let abort;
    const deadline = new Promise((_, reject) => {
      abort = () => reject(new Error('private_service_timeout'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    const operation = (async () => {
      const bytes = await boundedPrivateBody(request.body, undefined, signal);
      const admission = await c.serialized(async () => {
        const registration = await c.ctx.storage.get(KEY);
        if (signal.aborted || !registration || !await this.metadata(createdAt) || registration.createdAt !== createdAt
          || registration.network !== network || registration.name !== name || target.name !== name
          || registration.port !== port) return null;
        const url = new URL(`http://container:${port}`);
        url.pathname = target.url.pathname; url.search = target.url.search;
        const forwarded = new Request(url, { method: request.method, headers: privateHeaders(request.headers),
          body: ['GET', 'HEAD'].includes(request.method) ? undefined : bytes, signal, redirect: 'manual' });
        const response = Promise.resolve(c.container.getTcpPort(port).fetch(forwarded));
        void response.catch(() => {});
        return { response, registration };
      });
      if (!admission) return denied();
      upstream = await admission.response;
      if (upstream.status === 101 || upstream.webSocket) { upstream.webSocket?.close(); return denied(); }
      if (signal.aborted) { void upstream.body?.cancel().catch(() => {}); throw new Error('private_service_timeout'); }
      const payload = await boundedPrivateBody(upstream.body, undefined, signal);
      // Validate, renew activity, and construct the response under one lifecycle
      // lock. Stop/replacement/configuration cannot slip between these steps.
      return c.serialized(async () => {
        if (signal.aborted || !await this.metadata(createdAt)
          || JSON.stringify(await c.ctx.storage.get(KEY)) !== JSON.stringify(admission.registration)
          || !await c.touchTerminalActivityLocked(createdAt) || signal.aborted) return denied();
        const headers = privateHeaders(upstream.headers);
        headers.set('cache-control', 'no-store');
        return new Response(['HEAD'].includes(request.method) || [204, 205, 304].includes(upstream.status) ? null : payload,
          { status: upstream.status, headers });
      });
    })();
    try { return await Promise.race([operation, deadline]); }
    catch (error) {
      void upstream?.body?.cancel().catch(() => {});
      return c.respond({ error: error.message === 'request_too_large' ? 'private_service_too_large' : 'private_service_unavailable' },
        error.message === 'request_too_large' ? 413 : 502);
    } finally { signal.removeEventListener('abort', abort); }
  }
}
