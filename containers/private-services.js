import { MAX_PRIVATE_NETWORKS, MAX_PRIVATE_MEMBERS, PRIVATE_TIMEOUT_MS, validServiceName,
  validPrivateMember, privateTarget, privateHeaders } from './private-services-contract.js';
import { validContainerId } from './container-account-core.js';

const KEY = 'privateServiceNetworks';
const respond = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

// Account DO storage is the authority. Machines retain only a generation-bound
// registration to fence an accepted request against subsequent slot reuse.
export class PrivateServicesController {
  constructor(ctx, machineFor, now = Date.now) {
    this.ctx = ctx; this.machineFor = machineFor; this.now = now; this.tail = Promise.resolve();
  }
  async serialized(fn) {
    const previous = this.tail;
    let release;
    this.tail = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await fn(); } finally { release(); }
  }
  machine(userId, member) { return this.machineFor(userId, member.id); }
  internal(path, userId, member, method = 'GET', body) {
    return new Request(`https://internal/private-services/${path}`, { method,
      headers: { 'x-mainbrella-user': userId, 'x-mainbrella-container': member.id,
        'x-private-generation': member.createdAt, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async live(userId, member) {
    const response = await this.machine(userId, member).fetch(this.internal('status', userId, member));
    if (!response.ok) return false;
    const data = await response.json();
    return data.createdAt === member.createdAt && data.running === true;
  }
  async fetch(request) {
    const userId = request.headers.get('x-mainbrella-user');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(userId ?? '')) return respond({ error: 'not_authenticated' }, 401);
    const path = new URL(request.url).pathname;
    if (path === '/private-services/route') return this.route(request, userId);
    return this.serialized(async () => {
      const networks = (await this.ctx.storage.get(KEY)) ?? [];
      const owner = await this.ctx.storage.get('privateServiceOwner');
      if (owner && owner !== userId) return respond({ error: 'account_mismatch' }, 403);
      if (!owner) await this.ctx.storage.put('privateServiceOwner', userId);
      const url = new URL(request.url), networkName = url.searchParams.get('network');
      if (path === '/private-services/networks') {
        if (request.method === 'GET') return respond({ networks });
        if (request.method === 'POST') {
          const body = await request.json();
          if (!body || Object.keys(body).length !== 1 || !validServiceName(body.name)) return respond({ error: 'invalid_request' }, 400);
          if (networks.some(network => network.name === body.name)) return respond({ error: 'network_name_conflict' }, 409);
          if (networks.length >= MAX_PRIVATE_NETWORKS) return respond({ error: 'network_limit' }, 429);
          const network = { name: body.name, members: [] };
          await this.ctx.storage.put(KEY, [...networks, network]);
          return respond(network, 201);
        }
        if (request.method === 'DELETE') {
          const network = networks.find(value => value.name === networkName);
          if (!network) return respond({ deleted: true });
          if (network.members.length) return respond({ error: 'network_not_empty' }, 409);
          await this.ctx.storage.put(KEY, networks.filter(value => value !== network));
          return respond({ deleted: true });
        }
      }
      if (path !== '/private-services/members') return respond({ error: 'not_found' }, 404);
      const network = networks.find(value => value.name === networkName);
      if (!network) return respond({ error: 'network_not_found' }, 404);
      const body = await request.json();
      if (!validPrivateMember(body) || !validContainerId(body.id)) return respond({ error: 'invalid_request' }, 400);
      if (!['PUT', 'DELETE'].includes(request.method)) return respond({ error: 'method_not_allowed' }, 405);
      const existing = network.members.find(value => value.id === body.id);
      if (request.method === 'DELETE') {
        // An old detach cannot revoke the registration of a replacement.
        network.members = network.members.filter(value => value.id !== body.id || value.createdAt !== body.createdAt);
        await this.ctx.storage.put(KEY, networks);
        return respond({ detached: true });
      }
      if (network.members.some(value => value.name === body.name && value.id !== body.id)) return respond({ error: 'service_name_conflict' }, 409);
      if (networks.some(value => value !== network && value.members.some(member => member.id === body.id && member.createdAt === body.createdAt))) return respond({ error: 'machine_already_attached' }, 409);
      if (!existing && network.members.length >= MAX_PRIVATE_MEMBERS) return respond({ error: 'network_member_limit' }, 429);
      if (!await this.live(userId, body)) return respond({ error: 'container_not_running' }, 409);
      const configured = await this.machine(userId, body).fetch(this.internal('configure', userId, body, 'PUT', { network: networkName, ...body }));
      if (!configured.ok) return configured;
      network.members = [...network.members.filter(value => value.id !== body.id), body];
      await this.ctx.storage.put(KEY, networks);
      return respond({ network: networkName, ...body });
    }).catch(() => respond({ error: 'private_services_unavailable' }, 503));
  }
  async route(request, userId) {
    const target = privateTarget(request);
    const source = { id: request.headers.get('x-private-source-id'), createdAt: request.headers.get('x-private-source-generation') };
    if (!target || !validContainerId(source.id ?? '') || typeof source.createdAt !== 'string') return respond({ error: 'private_service_denied' }, 403);
    try {
      const admission = await this.serialized(async () => {
        if (await this.ctx.storage.get('privateServiceOwner') !== userId) return null;
        const networks = (await this.ctx.storage.get(KEY)) ?? [];
        const network = networks.find(value => value.members.some(member => member.id === source.id && member.createdAt === source.createdAt));
        const destination = network?.members.find(member => member.name === target.name && member.port !== undefined);
        if (!destination || !await this.live(userId, source)) return null;
        const headers = privateHeaders(request.headers);
        headers.set('x-private-generation', destination.createdAt);
        headers.set('x-private-network', network.name);
        headers.set('x-private-name', destination.name);
        headers.set('x-private-port', String(destination.port));
        // Generation is checked under the destination lifecycle lock immediately
        // before opening its application port. No implicit start or preview.
        const forwarded = new Request(request.url, { method: request.method, headers,
          body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body, duplex: 'half',
          redirect: 'manual', signal: AbortSignal.any([request.signal, AbortSignal.timeout(PRIVATE_TIMEOUT_MS)]) });
        const response = Promise.resolve(this.machine(userId, destination).fetch(forwarded));
        void response.catch(() => {});
        return { response, network: network.name, destination };
      });
      if (!admission) return respond({ error: 'private_service_denied' }, 403);
      const response = await admission.response;
      // The runtime buffers bounded HTTP responses; recheck source and registry
      // before releasing bytes when a stop/detach races the application.
      const current = (await this.ctx.storage.get(KEY)) ?? [];
      const network = current.find(value => value.name === admission.network);
      if (!network?.members.some(value => value.id === source.id && value.createdAt === source.createdAt)
        || !network.members.some(value => JSON.stringify(value) === JSON.stringify(admission.destination))
        || !await this.live(userId, source)) {
        void response.body?.cancel().catch(() => {});
        return respond({ error: 'private_service_denied' }, 403);
      }
      return response;
    } catch { return respond({ error: 'private_service_unavailable' }, 502); }
  }
}
