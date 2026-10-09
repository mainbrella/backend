export const OBSERVATION_RETENTION_MS = 7 * 86400_000;
export const MAX_LIFECYCLE_EVENTS = 256;
export const MAX_EVENT_PAGE = 100;
const KEY = 'workloadLifecycle';
const publicEvent = ({ telemetryId, expiresAt, incarnation, ...event }) => event;

// A bounded journal belongs to one account-owned machine slot. Sequence numbers
// survive pruning/recreation, while every event retains its exact generation.
export class WorkloadObservations {
  constructor(controller) { this.controller = controller; this.tail = Promise.resolve(); }
  async serialized(fn) {
    const previous = this.tail; let release;
    this.tail = new Promise(resolve => { release = resolve; }); await previous;
    try { return await fn(); } finally { release(); }
  }
  async journal() { return await this.controller.ctx.storage.get(KEY) ?? { sequence: 0, events: [] }; }
  async prune() {
    return this.serialized(async () => {
      const journal = await this.journal();
      const events = journal.events.filter(event => event.retainUntil > this.controller.now());
      if (events.length !== journal.events.length) { journal.events = events; await this.controller.ctx.storage.put(KEY, journal); }
    });
  }
  async append(metadata, type, reason) {
    return this.serialized(async () => {
      const journal = await this.journal(), createdAt = new Date(metadata.createdAt).toISOString();
      if (journal.events.some(event => event.createdAt === createdAt && event.type === type && (metadata.lifecycle !== 'production' || event.incarnation === metadata.telemetryId))) return;
      const now = this.controller.now();
      const event = { id: crypto.randomUUID(), sequence: ++journal.sequence, createdAt, type,
        occurredAt: new Date(now).toISOString(), retainUntil: now + OBSERVATION_RETENTION_MS,
        size: metadata.size ?? 'lite', ...(metadata.lifecycle === 'production' ? { incarnation: metadata.telemetryId } : {}), ...(reason ? { reason } : {}),
        ...(type === 'starting' ? { telemetryId: metadata.telemetryId, expiresAt: metadata.expiresAt } : {}) };
      journal.events = [...journal.events.filter(entry => entry.retainUntil > now), event].slice(-MAX_LIFECYCLE_EVENTS);
      await this.controller.ctx.storage.put(KEY, journal);
      await this.onAppend?.(event);
    });
  }
  async nextCleanup() {
    const events = (await this.journal()).events;
    return events.length ? Math.min(...events.map(event => event.retainUntil)) : null;
  }
  async identity(createdAt) {
    const now = this.controller.now();
    const journal = await this.journal();
    const events = journal.events.filter(event => event.createdAt === createdAt && event.retainUntil > now);
    const metadata = await this.controller.ctx.storage.get('builderMachine');
    const matching = metadata && new Date(metadata.createdAt).toISOString() === createdAt
      && (metadata.lifecycle === 'production' && this.controller.container.running || Math.max(metadata.createdAt, metadata.computeStoppedAt ?? metadata.createdAt) > now - OBSERVATION_RETENTION_MS);
    if (!events.length && !matching) return null;
    const incarnation = matching ? metadata.telemetryId : events.findLast(event => event.type === 'starting')?.incarnation;
    const currentEvents = events.filter(event => !event.incarnation || event.incarnation === incarnation);
    const starting = currentEvents.findLast(event => event.type === 'starting');
    const stopped = currentEvents.findLast(event => event.type === 'stopped');
    return { createdAt, telemetryId: starting?.telemetryId ?? (matching ? metadata.telemetryId : undefined),
      endsAt: Math.min(now, stopped ? Date.parse(stopped.occurredAt) : Infinity,
        matching ? metadata.computeStoppedAt ?? metadata.expiresAt : starting?.expiresAt ?? now) };
  }
  async fetch(request) {
    const url = new URL(request.url), createdAt = request.headers.get('x-exec-created-at');
    if (request.method !== 'GET') return this.controller.respond({ error: 'method_not_allowed' }, 405);
    if (!createdAt || !Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) return this.controller.respond({ error: 'invalid_generation' }, 400);
    if (!['/observations/events', '/observations/identity'].includes(url.pathname)) return this.controller.respond({ error: 'not_found' }, 404);
    await this.prune();
    const identity = await this.identity(createdAt);
    if (!identity) return this.controller.respond({ error: 'generation_not_found' }, 404);
    if (url.pathname === '/observations/identity') return this.controller.respond(identity);
    const cursor = url.searchParams.get('cursor') ?? '0', limit = url.searchParams.get('limit') ?? '100';
    if (!/^\d+$/.test(cursor) || !Number.isSafeInteger(Number(cursor)) || !/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > MAX_EVENT_PAGE) return this.controller.respond({ error: 'invalid_request' }, 400);
    const journal = await this.journal();
    if (Number(cursor) > journal.sequence) return this.controller.respond({ error: 'invalid_cursor' }, 400);
    const generationEvents = journal.events.filter(event => event.createdAt === createdAt);
    if (!generationEvents.length && !identity) return this.controller.respond({ error: 'generation_not_found' }, 404);
    const remaining = generationEvents.filter(event => event.sequence > Number(cursor));
    const events = remaining.slice(0, Number(limit));
    return this.controller.respond({ events: events.map(publicEvent), nextCursor: events.at(-1)?.sequence ?? Number(cursor),
      hasMore: remaining.length > events.length, historyTruncated: generationEvents.length > 0 && !generationEvents.some(event => event.type === 'starting'),
      retainForMs: OBSERVATION_RETENTION_MS });
  }
}
