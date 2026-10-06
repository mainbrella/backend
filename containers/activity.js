import { readFileBytes } from './file-contract.js';
import { validContainerId } from './container-account-core.js';
import { validExecutionId } from './execution-contract.js';

export const MAX_ACTIVITY_CONNECTIONS = 8;
export const ACTIVITY_CONNECTION_MS = 5 * 60_000;
export const MAX_ACTIVITY_MESSAGE_BYTES = 512;
export const validActivityUser = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
export const validActivityChange = value => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => ['resource', 'containerId', 'createdAt', 'executionId'].includes(key))
  && ['containers', 'executions', 'previews'].includes(value.resource)
  && validContainerId(value.containerId)
  && typeof value.createdAt === 'string' && value.createdAt.length <= 32
  && Number.isFinite(Date.parse(value.createdAt)) && new Date(value.createdAt).toISOString() === value.createdAt
  && (value.executionId === undefined || value.resource === 'executions' && validExecutionId(value.executionId));

export async function publishActivity(env, userId, change) {
  if (!env.ACCOUNT_ACTIVITY || !validActivityUser(userId) || !validActivityChange(change)) return;
  const hub = env.ACCOUNT_ACTIVITY.get(env.ACCOUNT_ACTIVITY.idFromName(`activity:${userId}`));
  const response = await hub.fetch(new Request('https://internal/activity/change', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-mainbrella-user': userId }, body: JSON.stringify(change),
  }));
  if (!response.ok) throw new Error('activity_delivery_failed');
}

// Only private Worker bindings can reach this controller. Public authentication
// and browser Origin checks happen before selecting this account's namespace.
export class AccountActivityController {
  constructor(ctx, options = {}) {
    this.ctx = ctx;
    this.now = options.now ?? (() => Date.now());
    this.pairFactory = options.pairFactory ?? (() => new WebSocketPair());
    this.responseFactory = options.responseFactory ?? (webSocket => new Response(null, { status: 101, webSocket }));
    this.tail = Promise.resolve();
  }
  async serialized(operation) {
    const previous = this.tail; let release;
    this.tail = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }
  respond(error, status) { return Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } }); }
  sockets() { return this.ctx.getWebSockets().filter(socket => socket.readyState === 1); }
  async expire() {
    let next = Infinity;
    for (const socket of this.sockets()) {
      const expiry = socket.deserializeAttachment()?.expiresAt;
      if (!Number.isSafeInteger(expiry) || expiry <= this.now()) socket.close(1000, 'Reconnect to renew authentication');
      else next = Math.min(next, expiry);
    }
    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(next);
    else await this.ctx.storage.deleteAlarm();
  }
  fetch(request) {
    return this.serialized(async () => {
      const url = new URL(request.url), userId = request.headers.get('x-mainbrella-user');
      if (!validActivityUser(userId)) return this.respond('not_authenticated', 401);
      if (url.search || !['/activity', '/activity/change'].includes(url.pathname)) return this.respond('not_found', 404);
      const owner = await this.ctx.storage.get('activityOwner');
      if (owner && owner !== userId) return this.respond('account_mismatch', 403);
      if (!owner) await this.ctx.storage.put('activityOwner', userId);
      await this.expire();
      if (url.pathname === '/activity/change') {
        if (request.method !== 'POST') return this.respond('method_not_allowed', 405);
        let change;
        try { change = JSON.parse(new TextDecoder().decode(await readFileBytes(request.body, MAX_ACTIVITY_MESSAGE_BYTES, request.signal))); }
        catch { return this.respond('invalid_request', 400); }
        if (!validActivityChange(change)) return this.respond('invalid_request', 400);
        const data = JSON.stringify({ type: 'changed', id: crypto.randomUUID(), ...change });
        for (const socket of this.sockets()) {
          try { socket.send(data); } catch { socket.close(1011, 'Connection unavailable'); }
        }
        return Response.json({ ok: true });
      }
      if (request.method !== 'GET') return this.respond('method_not_allowed', 405);
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return this.respond('websocket_required', 426);
      if (this.sockets().length >= MAX_ACTIVITY_CONNECTIONS) return this.respond('activity_connection_limit', 429);
      const [client, server] = Object.values(this.pairFactory());
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ expiresAt: this.now() + ACTIVITY_CONNECTION_MS });
      server.send(JSON.stringify({ type: 'ready' }));
      await this.expire();
      return this.responseFactory(client);
    });
  }
  alarm() { return this.serialized(() => this.expire()); }
  async webSocketMessage(socket, message) {
    // Transport ping/pong is automatic. The public stream is read-only.
    socket.close(1008, 'Activity stream is read-only');
    await this.alarm();
  }
  async webSocketClose(socket) { await this.alarm(); }
  async webSocketError(socket) { socket.close(1011, 'Connection unavailable'); await this.alarm(); }
}
