import { MAX_EXECUTIONS, MAX_OUTPUT_BYTES, readCommandBody } from './command-contract.js';
import { validIdempotencyKey } from './container-account-core.js';
import { MAX_MANAGED_TIMEOUT_MS, EXECUTION_RETENTION_MS, MAX_RETAINED_EXECUTIONS, MAX_EXECUTION_EVENTS,
  MAX_EXECUTION_STREAMS, EXECUTION_STREAM_MS, validExecution, validExecutionId, terminalExecution } from './execution-contract.js';

const RECORD = 'execution-record:';
const eventPrefix = id => `execution-event:${id}:`;
const eventKey = (id, sequence) => eventPrefix(id) + String(sequence).padStart(8, '0');
const encoder = new TextEncoder();
const summary = record => {
  const { key, fingerprint, ...publicRecord } = record;
  return publicRecord;
};

// Records/events are durable, process handles are not. Recovery interrupts the
// affected generation rather than silently replaying a command with side effects.
export class ManagedExecutions {
  constructor(controller, active, ctx, timers = globalThis) {
    Object.assign(this, { controller, active, ctx, timers });
    this.sessions = new Map();
    this.listeners = new Set();
    this.streams = 0;
    this.tail = Promise.resolve();
  }
  async serialized(fn) {
    const previous = this.tail;
    let release;
    this.tail = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await fn(); } finally { release(); }
  }
  async records() { return this.ctx.storage.list({ prefix: RECORD, limit: MAX_RETAINED_EXECUTIONS + 1 }); }
  async erase(record) {
    const events = await this.ctx.storage.list({ prefix: eventPrefix(record.id), limit: MAX_EXECUTION_EVENTS + 2 });
    await this.ctx.storage.delete([...events.keys(), RECORD + record.id]);
  }
  async prune() {
    for (const record of (await this.records()).values()) {
      if (terminalExecution(record) && record.retainUntil <= this.controller.now()) await this.erase(record);
    }
  }
  async scheduleCleanup() {
    await this.controller.serialized(async () => {
      const records = [...(await this.records()).values()];
      const times = records.map(record => record.retainUntil).filter(at => at > this.controller.now());
      const metadata = await this.ctx.storage.get('builderMachine');
      if (metadata && this.controller.container.running) times.push(Math.max(this.controller.now() + 1, this.controller.deadline(metadata)));
      if (times.length) await this.ctx.storage.setAlarm(Math.min(...times));
    });
  }
  async recover() {
    const records = await this.records();
    const metadata = await this.ctx.storage.get('builderMachine');
    let interrupt = false;
    for (const record of records.values()) {
      if (record.retainUntil <= this.controller.now() && terminalExecution(record)) { await this.erase(record); continue; }
      if (!terminalExecution(record)) {
        if (metadata && new Date(metadata.createdAt).toISOString() === record.createdAt) interrupt = true;
        record.status = 'interrupted';
        record.finishedAt = new Date(this.controller.now()).toISOString();
        await this.ctx.storage.put(RECORD + record.id, record);
      }
    }
    if (interrupt && this.controller.container.running) await this.controller.destroy('Managed execution interrupted by runtime restart');
  }
  wake() { for (const listener of this.listeners) listener(); }
  async save(record, event) {
    if (event) {
      event.sequence = ++record.cursor;
      await this.ctx.storage.put({ [RECORD + record.id]: record, [eventKey(record.id, event.sequence)]: event });
    } else await this.ctx.storage.put(RECORD + record.id, record);
    this.wake();
  }
  async output(record, stream, text) {
    if (!text) return;
    await this.serialized(async () => {
      await this.save(record, { type: stream, data: text });
    });
  }
  async start(request, createdAt, expiresAt) {
    let body;
    try { body = await readCommandBody(request); } catch { return this.controller.respond({ error: 'invalid_request' }, 400); }
    if (!validExecution(body)) return this.controller.respond({ error: 'invalid_request' }, 400);
    const key = request.headers.get('Idempotency-Key');
    if (!validIdempotencyKey(key)) return this.controller.respond({ error: 'invalid_idempotency_key' }, 400);
    const fingerprint = [...new Uint8Array(await crypto.subtle.digest('SHA-256',
      encoder.encode(JSON.stringify([body.command, body.timeoutMs ?? 30_000]))))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    return this.serialized(async () => {
      const records = await this.records();
      for (const [id, record] of records) {
        if (record.retainUntil <= this.controller.now() && terminalExecution(record)) { await this.erase(record); records.delete(id); }
      }
      const existing = [...records.values()].find(record => record.key === key && record.createdAt === createdAt);
      if (existing) return existing.fingerprint === fingerprint
        ? this.controller.respond(summary(existing), 202) : this.controller.respond({ error: 'idempotency_key_conflict' }, 409);
      const metadata = await this.controller.getTerminalMetadata(createdAt, expiresAt);
      if (!metadata) return this.controller.respond({ error: 'container_not_running' }, 409);
      if (this.active.size >= MAX_EXECUTIONS) return this.controller.respond({ error: 'execution_limit' }, 429);
      // Reject admission instead of evicting an unexpired idempotency identity.
      if (records.size >= MAX_RETAINED_EXECUTIONS) return this.controller.respond({ error: 'execution_history_limit' }, 429);
      const now = this.controller.now();
      const record = { id: crypto.randomUUID(), createdAt, startedAt: new Date(now).toISOString(), status: 'starting',
        retainUntil: now + EXECUTION_RETENTION_MS, cursor: 0, outputBytes: 0, exitCode: null,
        timedOut: false, outputTruncated: false, key, fingerprint };
      let stop;
      let canceled = false;
      const session = { close: () => { canceled = true; stop?.('canceled'); } };
      this.active.add(session);
      this.sessions.set(record.id, session);
      try { await this.save(record); } catch (error) {
        this.active.delete(session); this.sessions.delete(record.id); throw error;
      }
      // run() starts after this admission lock releases. Request abort never owns
      // the managed process lifetime; the durable identity is already committed.
      const work = Promise.resolve().then(() => this.run(record, body, metadata, session, fn => { stop = fn; if (canceled) stop('canceled'); }));
      this.ctx.waitUntil(work.catch(() => { console.error('managed_execution_persistence_failed'); }));
      return this.controller.respond(summary(record), 202);
    });
  }
  async run(record, body, metadata, session, setStop) {
    const abort = new AbortController();
    let process;
    let exited = false;
    let reason;
    let rejectStopped;
    const stopped = new Promise((_, reject) => { rejectStopped = reject; });
    void stopped.catch(() => {});
    const stop = value => {
      if (reason) return;
      reason = value;
      if (!exited) { abort.abort(); try { process?.kill(9); } catch {} }
      rejectStopped(new Error(value));
    };
    setStop(stop);
    const timer = this.timers.setTimeout(() => stop('timed_out'), Math.max(0,
      Math.min(body.timeoutMs ?? 30_000, MAX_MANAGED_TIMEOUT_MS, metadata.expiresAt - this.controller.now())));
    const heartbeat = this.timers.setInterval(() => {
      void this.controller.touchTerminalActivity(record.createdAt).then(ok => { if (!ok) stop('canceled'); }, () => stop('failed'));
    }, 15_000);
    const readers = [];
    let pumps = [];
    let chunks = 0;
    async function pump(stream, name, manager) {
      if (!stream) throw new Error('missing_stream');
      const reader = stream.getReader(); readers.push(reader);
      const decoder = new TextDecoder();
      while (!reason) {
        const { done, value } = await reader.read();
        if (done) break;
        for (let offset = 0; offset < value.byteLength && !reason; offset += 8192) {
          const remaining = MAX_OUTPUT_BYTES - record.outputBytes;
          const bytes = value.subarray(offset, offset + Math.min(8192, remaining));
          record.outputBytes += bytes.byteLength;
          if (bytes.byteLength) await manager.output(record, name, decoder.decode(bytes, { stream: true }));
          if (++chunks >= MAX_EXECUTION_EVENTS - 2 || bytes.byteLength < Math.min(8192, value.byteLength - offset)) stop('output_limit');
        }
      }
      await manager.output(record, name, decoder.decode());
    }
    try {
      const starting = this.controller.startTerminalProcess(record.createdAt, metadata.expiresAt,
        ['/bin/sh', '-lc', body.command], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', signal: abort.signal });
      void starting.then(value => { if (reason) { try { value.kill(9); } catch {} } }).catch(() => {});
      process = await Promise.race([starting, stopped]);
      const exit = process.exitCode.then(code => { exited = true; return code; });
      if (!await this.controller.touchTerminalActivity(record.createdAt)) throw new Error('Machine unavailable');
      record.status = 'running';
      await this.serialized(() => this.save(record));
      await Promise.race([process.stdin?.close(), stopped]);
      pumps = [pump(process.stdout, 'stdout', this), pump(process.stderr, 'stderr', this)];
      const [code] = await Promise.race([Promise.all([exit, ...pumps]), stopped]);
      record.exitCode = code;
      record.status = code === 0 ? 'succeeded' : 'failed';
    } catch {
      record.status = reason ?? 'failed';
      record.timedOut = reason === 'timed_out';
      record.outputTruncated = reason === 'output_limit';
    } finally {
      this.timers.clearTimeout(timer);
      this.timers.clearInterval(heartbeat);
      if (!exited) { abort.abort(); try { process?.kill(9); } catch {} }
      for (const reader of readers) await reader.cancel().catch(() => {});
      await Promise.allSettled(pumps);
      // All outstanding output writes precede the final record in the same lock.
      await this.serialized(async () => {
        record.finishedAt = new Date(this.controller.now()).toISOString();
        await this.save(record);
      });
      this.active.delete(session);
      this.sessions.delete(record.id);
      await this.scheduleCleanup();
    }
  }
  async events(record, cursor = 0) {
    const result = await this.ctx.storage.list({ prefix: eventPrefix(record.id), startAfter: eventKey(record.id, cursor), limit: MAX_EXECUTION_EVENTS + 2 });
    return [...result.values()];
  }
  async stream(record, cursor, request) {
    if (this.streams >= MAX_EXECUTION_STREAMS) return this.controller.respond({ error: 'execution_stream_limit' }, 429);
    this.streams++;
    const manager = this;
    let closed = false;
    let wake;
    const deadline = this.controller.now() + EXECUTION_STREAM_MS;
    const close = () => {
      if (closed) return;
      closed = true;
      manager.streams--;
      manager.listeners.delete(wake);
      request.signal.removeEventListener('abort', close);
      wake?.();
    };
    request.signal.addEventListener('abort', close, { once: true });
    const body = new ReadableStream({
      async pull(controller) {
        try {
          if (request.signal.aborted || closed) { close(); controller.close(); return; }
          const latest = await manager.ctx.storage.get(RECORD + record.id);
          if (!latest) { close(); controller.close(); return; }
          const events = await manager.events(latest, cursor);
          for (const event of events) {
            cursor = event.sequence;
            controller.enqueue(encoder.encode(`id: ${cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
          }
          if (terminalExecution(latest) || manager.controller.now() >= deadline) {
            controller.enqueue(encoder.encode(`event: status\ndata: ${JSON.stringify(summary(latest))}\n\n`));
            close(); controller.close(); return;
          }
          // Register before rereading to avoid missing an update between the
          // storage read and listener registration. Heartbeats bound quiet waits.
          let timer;
          await new Promise(resolve => {
            wake = resolve; manager.listeners.add(wake);
            timer = manager.timers.setTimeout(resolve, 1000);
            void manager.ctx.storage.get(RECORD + record.id).then(check => {
              if (closed || !check || check.cursor > cursor || terminalExecution(check)) resolve();
            }, resolve);
          });
          manager.timers.clearTimeout(timer);
          manager.listeners.delete(wake);
          if (!closed) controller.enqueue(encoder.encode(': heartbeat\n\n'));
        } catch { close(); controller.error(new Error('execution_unavailable')); }
      },
      cancel: close,
    });
    return new Response(body, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  }
  async fetch(request) {
    const url = new URL(request.url);
    const match = /^\/executions(?:\/([a-f0-9-]+)(\/events)?)?$/.exec(url.pathname);
    if (!match || match[1] && !validExecutionId(match[1])) return this.controller.respond({ error: 'not_found' }, 404);
    const createdAt = request.headers.get('x-exec-created-at');
    const expiry = request.headers.get('x-exec-expires-at');
    if (!createdAt) return this.controller.respond({ error: 'forbidden' }, 403);
    if (!match[1] && request.method === 'POST') {
      if (!expiry || !/^\d+$/.test(expiry) || !Number.isSafeInteger(Number(expiry))) return this.controller.respond({ error: 'forbidden' }, 403);
      return this.start(request, createdAt, Number(expiry));
    }
    if (!match[1] || !['GET', 'DELETE'].includes(request.method) || match[2] && request.method !== 'GET') {
      return this.controller.respond({ error: 'method_not_allowed' }, 405);
    }
    const record = await this.ctx.storage.get(RECORD + match[1]);
    if (!record || record.createdAt !== createdAt || record.retainUntil <= this.controller.now()) return this.controller.respond({ error: 'execution_not_found' }, 404);
    if (request.method === 'DELETE') {
      this.sessions.get(record.id)?.close();
      return this.controller.respond(summary(record), 202);
    }
    if (match[2]) {
      const cursor = Number(url.searchParams.get('cursor') ?? '0');
      if (!/^\d+$/.test(url.searchParams.get('cursor') ?? '0') || !Number.isSafeInteger(cursor) || cursor > record.cursor) return this.controller.respond({ error: 'invalid_cursor' }, 400);
      return this.stream(record, cursor, request);
    }
    const result = { ...summary(record), stdout: '', stderr: '' };
    for (const event of await this.events(record)) result[event.type] += event.data;
    return this.controller.respond(result);
  }
}
