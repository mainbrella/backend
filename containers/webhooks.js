import { validContainerId } from './container-account-core.js';
import { validExecutionId } from './execution-contract.js';
import { MAX_WEBHOOK_CONFIGS, MAX_WEBHOOK_DELIVERIES, WEBHOOK_ATTEMPTS, WEBHOOK_RETRY_MS, webhookUrl, webhooksConfigured, readWebhookBody } from './webhook-contract.js';
const KEY = 'workloadWebhooks';
const hex = bytes => [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
const unhex = value => Uint8Array.from(value.match(/.{2}/g), pair => Number.parseInt(pair, 16));
const encoder = new TextEncoder();
const configView = config => ({ id: config.id, url: config.url, createdAt: config.createdAt, configuredAt: config.configuredAt, retainUntil: config.retainUntil });
const deliveryView = ({ configId, event, ...delivery }) => delivery;

export class WorkloadWebhooks {
  constructor(controller, env, fetcher = (...args) => fetch(...args)) { Object.assign(this, { controller, env, fetcher }); this.tail = Promise.resolve(); this.inflight = new Map(); }
  configured() { return webhooksConfigured(this.env) && /^[a-f0-9]{64}$/.test(this.env.WEBHOOK_ENCRYPTION_KEY ?? ''); }
  async serialized(fn) {
    const previous = this.tail; let release; this.tail = new Promise(resolve => { release = resolve; }); await previous;
    try { return await fn(); } finally { release(); }
  }
  async state() { return await this.controller.ctx.storage.get(KEY) ?? { configs: [], deliveries: [] }; }
  pruneState(state) {
    const now = this.controller.now();
    state.configs = state.configs.filter(config => config.retainUntil > now);
    state.deliveries = state.deliveries.filter(delivery => delivery.retainUntil > now && state.configs.some(config => config.id === delivery.configId));
  }
  async save(state) { await this.controller.ctx.storage.put(KEY, state); this.onChange?.(); }
  async crypt(secret, config, decrypt = false) {
    const key = await crypto.subtle.importKey('raw', unhex(this.env.WEBHOOK_ENCRYPTION_KEY), 'AES-GCM', false, [decrypt ? 'decrypt' : 'encrypt']);
    const iv = decrypt ? unhex(config.iv) : crypto.getRandomValues(new Uint8Array(12));
    const options = { name: 'AES-GCM', iv, additionalData: encoder.encode(`${config.createdAt}:${config.id}`) };
    const bytes = new Uint8Array(await crypto.subtle[decrypt ? 'decrypt' : 'encrypt'](options, key, decrypt ? unhex(config.secret) : encoder.encode(secret)));
    return decrypt ? new TextDecoder().decode(bytes) : { secret: hex(bytes), iv: hex(iv) };
  }
  addDelivery(state, config, event) {
    if (event.sequence <= config.afterCursor) return;
    if (state.deliveries.some(delivery => delivery.configId === config.id && delivery.id === event.id)) {
      config.afterCursor = event.sequence;
      return;
    }
    if (state.deliveries.length >= MAX_WEBHOOK_DELIVERIES) {
      const completed = state.deliveries.findIndex(delivery => ['delivered', 'exhausted'].includes(delivery.status));
      if (completed < 0) throw new Error('webhook_delivery_limit');
      state.deliveries.splice(completed, 1);
    }
    const payload = { id: event.id, sequence: event.sequence, type: event.type, occurredAt: event.occurredAt,
      container: { id: config.containerId, createdAt: event.createdAt, size: event.size }, ...(event.reason ? { reason: event.reason } : {}) };
    state.deliveries.push({ id: event.id, configId: config.id, event: payload, sequence: event.sequence, status: 'pending', attempts: 0,
      manualRetries: 0, nextAt: this.controller.now(), retainUntil: Math.min(config.retainUntil, event.retainUntil) });
    // Persist this watermark with the outbox entry. Retention or bounded
    // eviction must never cause an acknowledged lifecycle event to reappear.
    config.afterCursor = event.sequence;
  }
  async enqueue(event) {
    await this.serialized(async () => {
      const state = await this.state(); this.pruneState(state);
      const config = state.configs.find(config => config.createdAt === event.createdAt);
      if (!config) return;
      this.addDelivery(state, config, event); await this.save(state);
    });
  }
  async nextAlarm() {
    const state = await this.state(); this.pruneState(state);
    const times = [...state.configs.map(config => config.retainUntil), ...state.deliveries.map(delivery => ['pending', 'sending'].includes(delivery.status) ? Math.min(delivery.nextAt, delivery.retainUntil) : delivery.retainUntil)];
    return times.length ? Math.min(...times) : null;
  }
  async fetch(request) {
    const createdAt = request.headers.get('x-exec-created-at'), containerId = request.headers.get('x-exec-container-id');
    if (!createdAt || !Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt || !validContainerId(containerId)) return this.controller.respond({ error: 'invalid_request' }, 400);
    const url = new URL(request.url), deliveries = url.pathname === '/observations/webhook/deliveries', retry = url.pathname === '/observations/webhook/retry';
    if (!['/observations/webhook', '/observations/webhook/deliveries', '/observations/webhook/retry'].includes(url.pathname)) return this.controller.respond({ error: 'not_found' }, 404);
    const allowed = deliveries ? ['GET'] : retry ? ['POST'] : ['GET', 'PUT', 'DELETE'];
    if (!allowed.includes(request.method)) return this.controller.respond({ error: 'method_not_allowed' }, 405);
    let body;
    if (request.method === 'PUT' || retry) {
      try { body = await readWebhookBody(request); } catch { return this.controller.respond({ error: 'invalid_request' }, 400); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return this.controller.respond({ error: 'invalid_request' }, 400);
    }
    const operation = () => this.serialized(async () => {
      const state = await this.state(); this.pruneState(state);
      const config = state.configs.find(config => config.createdAt === createdAt);
      if (request.method === 'GET') return this.controller.respond(deliveries ? { deliveries: state.deliveries.filter(delivery => delivery.configId === config?.id).map(deliveryView) }
        : { webhook: config ? configView(config) : null });
      if (request.method === 'DELETE') {
        if (config) { this.inflight.get(config.id)?.forEach(abort => abort.abort()); state.configs = state.configs.filter(item => item.id !== config.id); state.deliveries = state.deliveries.filter(item => item.configId !== config.id); }
        await this.save(state); return this.controller.respond({ removed: true });
      }
      if (!this.configured()) return this.controller.respond({ error: 'webhooks_not_configured' }, 503);
      if (retry) {
        if (Object.keys(body).length !== 1 || !validExecutionId(body.eventId)) return this.controller.respond({ error: 'invalid_request' }, 400);
        const delivery = state.deliveries.find(item => item.configId === config?.id && item.id === body.eventId);
        if (!delivery) return this.controller.respond({ error: 'delivery_not_found' }, 404);
        if (delivery.status !== 'exhausted') return this.controller.respond({ error: 'delivery_not_retryable' }, 409);
        if (delivery.manualRetries >= 3) return this.controller.respond({ error: 'webhook_retry_limit' }, 429);
        delivery.manualRetries++; delivery.attempts = 0; delivery.status = 'pending'; delivery.nextAt = this.controller.now(); await this.save(state);
        return this.controller.respond(deliveryView(delivery), 202);
      }
      const target = webhookUrl(body.url, this.env.WEBHOOK_ALLOWED_HOSTS);
      if (!target || Object.keys(body).some(key => !['url', 'replayFromCursor'].includes(key))
        || body.replayFromCursor !== undefined && (!Number.isSafeInteger(body.replayFromCursor) || body.replayFromCursor < 0)) return this.controller.respond({ error: 'invalid_webhook' }, 400);
      const expiry = Number(request.headers.get('x-exec-expires-at'));
      if (!await this.controller.terminalMetadata(createdAt, expiry)) return this.controller.respond({ error: 'container_not_running' }, 409);
      const journal = await this.controller.observations.journal();
      if (body.replayFromCursor > journal.sequence) return this.controller.respond({ error: 'invalid_cursor' }, 400);
      if (!config && state.configs.length >= MAX_WEBHOOK_CONFIGS) return this.controller.respond({ error: 'webhook_limit' }, 429);
      const events = journal.events.filter(event => event.createdAt === createdAt && event.retainUntil > this.controller.now());
      const retainUntil = this.controller.now() + 7 * 86400_000;
      const next = { id: crypto.randomUUID(), createdAt, containerId, url: target, configuredAt: new Date(this.controller.now()).toISOString(), retainUntil,
        afterCursor: body.replayFromCursor ?? journal.sequence };
      const secret = `mbwh_${hex(crypto.getRandomValues(new Uint8Array(32)))}`;
      Object.assign(next, await this.crypt(secret, next));
      if (config) { this.inflight.get(config.id)?.forEach(abort => abort.abort()); state.configs = state.configs.filter(item => item.id !== config.id); state.deliveries = state.deliveries.filter(item => item.configId !== config.id); }
      state.configs.push(next);
      if (body.replayFromCursor !== undefined) for (const event of events.filter(event => event.sequence > body.replayFromCursor)) this.addDelivery(state, next, event);
      await this.save(state); return this.controller.respond({ webhook: configView(next), signingSecret: secret }, 201);
    });
    // Lifecycle writers append into this outbox while holding their lock. PUT
    // must acquire the same locks in that order, so stop and rotation cannot
    // deadlock or configure an already-stopped generation.
    return request.method === 'PUT' ? this.controller.serialized(operation) : operation();
  }
  async deliver(id, configId) {
    let delivery, config;
    await this.serialized(async () => {
      const state = await this.state(); this.pruneState(state);
      delivery = state.deliveries.find(item => item.id === id && item.configId === configId);
      config = state.configs.find(item => item.id === configId);
      if (!config || !delivery || !['pending', 'sending'].includes(delivery.status) || delivery.nextAt > this.controller.now()) { delivery = null; return; }
      if (delivery.attempts >= WEBHOOK_ATTEMPTS) { delivery.status = 'exhausted'; delivery.nextAt = null; await this.save(state); delivery = null; return; }
      delivery.status = 'sending'; delivery.attempts++; delivery.nextAt = this.controller.now() + 30_000; await this.save(state);
    });
    if (!delivery) return;
    const abort = new AbortController();
    if (!this.inflight.has(configId)) this.inflight.set(configId, new Set());
    this.inflight.get(configId).add(abort);
    let succeeded = false, status = null;
    try {
      const target = webhookUrl(config.url, this.env.WEBHOOK_ALLOWED_HOSTS);
      if (!target || !this.configured()) throw new Error('webhooks_not_configured');
      const secret = await this.crypt(null, config, true);
      const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const body = JSON.stringify(delivery.event), timestamp = Math.floor(this.controller.now() / 1000);
      const signature = hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${body}`))));
      let pending;
      await this.serialized(async () => {
        const current = await this.state();
        if (abort.signal.aborted || !current.configs.some(item => item.id === configId)) throw new Error('webhook_removed');
        // Launch under the short configuration lock, then await outside it so
        // removal can abort transport without waiting for the receiver.
        pending = this.fetcher(target, { method: 'POST', redirect: 'manual', credentials: 'omit',
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]),
          headers: { 'Content-Type': 'application/json', 'Mainbrella-Event-Id': delivery.id, 'Mainbrella-Signature': `t=${timestamp},v1=${signature}` }, body });
      });
      const response = await pending;
      status = response.status; succeeded = response.ok; void response.body?.cancel().catch(() => {});
    } catch {} finally { const set = this.inflight.get(configId); set?.delete(abort); if (!set?.size) this.inflight.delete(configId); }
    await this.serialized(async () => {
      const state = await this.state(); this.pruneState(state);
      const current = state.deliveries.find(item => item.id === id && item.configId === configId);
      if (!current || current.attempts !== delivery.attempts || current.manualRetries !== delivery.manualRetries) return;
      current.lastAttemptAt = this.controller.now(); current.httpStatus = status;
      current.status = succeeded ? 'delivered' : current.attempts >= WEBHOOK_ATTEMPTS ? 'exhausted' : 'pending';
      current.nextAt = succeeded || current.status === 'exhausted' ? null : this.controller.now() + WEBHOOK_RETRY_MS[current.attempts - 1];
      await this.save(state);
    });
  }
  async tick() {
    const journal = await this.controller.observations.journal();
    const state = await this.serialized(async () => {
      const current = await this.state(); this.pruneState(current);
      // Recover an event committed to the lifecycle journal before enqueue or
      // alarm scheduling completed. Already delivered IDs are never replayed.
      for (const config of current.configs) for (const event of journal.events.filter(event => event.createdAt === config.createdAt
        && event.sequence > config.afterCursor && event.retainUntil > this.controller.now())) this.addDelivery(current, config, event);
      await this.save(current); return current;
    });
    const due = state.deliveries.filter(delivery => ['pending', 'sending'].includes(delivery.status) && delivery.nextAt <= this.controller.now()).slice(0, 3);
    await Promise.allSettled(due.map(delivery => this.deliver(delivery.id, delivery.configId)));
  }
}
