import { MAX_EXECUTIONS, MAX_OUTPUT_BYTES, readCommandBody } from './command-contract.js';
import { validIdempotencyKey } from './container-account-core.js';
import { startOperationProcess } from './process-supervisor.js';
import { FILE_TIMEOUT_MS, readFileBytes } from './file-contract.js';
import { MAX_MANAGED_TIMEOUT_MS, EXECUTION_RETENTION_MS, MAX_RETAINED_EXECUTIONS, MAX_EXECUTION_EVENTS,
  MAX_EXECUTION_STREAMS, EXECUTION_STREAM_MS, MAX_STDIN_CHUNK_BYTES, MAX_STDIN_BYTES, MAX_PENDING_STDIN_BYTES,
  EXECUTION_SIGNALS, executionFingerprintValues, validExecution, validExecutionId, validTerminalSize, terminalExecution } from './execution-contract.js';

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
    this.activityStatuses = new Map();
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
    this.activityStatuses.delete(record.id);
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
      const observationsAt = await this.controller.observations?.nextCleanup();
      if (observationsAt !== null && observationsAt !== undefined) times.push(Math.max(this.controller.now() + 1, observationsAt));
      const webhookAt = await this.controller.webhooks?.nextAlarm();
      if (webhookAt !== null && webhookAt !== undefined) times.push(Math.max(this.controller.now() + 1, webhookAt));
      const metadata = await this.ctx.storage.get('builderMachine');
      if (metadata && this.controller.container.running) times.push(Math.max(this.controller.now() + 1, this.controller.deadline(metadata)));
      if (times.length) await this.ctx.storage.setAlarm(Math.min(...times));
    });
  }
  async lifecycleFetch(request) {
    try { return await this.controller.fetch(request); }
    finally {
      // Lifecycle stop/revocation clears the VM alarm. Retained output still
      // needs maintenance even when no command or container remains active.
      await this.prune();
      await this.scheduleCleanup();
    }
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
        record.stdinClosed = true;
        record.finishedAt = new Date(this.controller.now()).toISOString();
        await this.save(record);
      }
    }
    if (interrupt && this.controller.container.running) await this.controller.destroy('Managed execution interrupted by runtime restart');
    await this.prune();
    await this.scheduleCleanup();
  }
  wake() { for (const listener of this.listeners) listener(); }
  async save(record, event) {
    if (event) {
      event.sequence = ++record.cursor;
      await this.ctx.storage.put({ [RECORD + record.id]: record, [eventKey(record.id, event.sequence)]: event });
    } else await this.ctx.storage.put(RECORD + record.id, record);
    this.wake();
    if (this.activityStatuses.get(record.id) !== record.status) {
      this.activityStatuses.set(record.id, record.status);
      this.onStatus?.(summary(record));
    }
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
      encoder.encode(JSON.stringify(executionFingerprintValues(body)))))].map(byte => byte.toString(16).padStart(2, '0')).join('');
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
        timedOut: false, outputTruncated: false, stdinEnabled: Boolean(body.stdin), stdinClosed: !body.stdin, stdinBytes: 0,
        ...(body.pty ? { pty: body.pty } : {}), key, fingerprint };
      let stop;
      let canceled = false;
      const session = { record, pendingInputBytes: 0, inputTail: Promise.resolve(),
        close: () => { canceled = true; stop?.('canceled'); } };
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
    let outcome;
    let rejectStopped;
    const stopped = new Promise((_, reject) => { rejectStopped = reject; });
    void stopped.catch(() => {});
    const stop = value => {
      if (reason) return;
      reason = value;
      if (!exited) abort.abort();
      try { process?.kill(9); } catch {}
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
    // Small writes (apt progress, for example) must not exhaust the event budget
    // while most of the byte allowance is unused. Reserve enough events to batch
    // the remaining bytes in 8 KiB pieces, plus decoder tails from both pipes.
    const immediateEvents = MAX_EXECUTION_EVENTS - Math.ceil(MAX_OUTPUT_BYTES / 8192) - 4;
    async function pump(stream, name, manager) {
      if (!stream) throw new Error('missing_stream');
      const reader = stream.getReader(); readers.push(reader);
      const decoder = new TextDecoder();
      let pending = '';
      async function publish(text, flush = false) {
        pending += text;
        while (pending && (flush || chunks < immediateEvents || pending.length >= 8192)) {
          let end = Math.min(8192, pending.length);
          // Do not split a UTF-16 surrogate pair between retained SSE events.
          if (end < pending.length && /[\uD800-\uDBFF]/.test(pending[end - 1])) end--;
          const data = pending.slice(0, end);
          pending = pending.slice(end);
          chunks++;
          await manager.output(record, name, data);
        }
      }
      try {
        while (!reason) {
          const { done, value } = await reader.read();
          if (done) break;
          for (let offset = 0; offset < value.byteLength && !reason; offset += 8192) {
            const remaining = MAX_OUTPUT_BYTES - record.outputBytes;
            const bytes = value.subarray(offset, offset + Math.min(8192, remaining));
            record.outputBytes += bytes.byteLength;
            if (bytes.byteLength) await publish(decoder.decode(bytes, { stream: true }));
            if (bytes.byteLength < Math.min(8192, value.byteLength - offset)) stop('output_limit');
          }
        }
      } finally {
        await publish(decoder.decode(), true);
      }
    }
    try {
      const starting = startOperationProcess(this.controller, record.createdAt, metadata.expiresAt,
        body.argv ?? ['/bin/sh', '-lc', body.command], { stdin: 'pipe', stdout: 'pipe', stderr: body.pty ? 'combined' : 'pipe', signal: abort.signal,
          ...(body.pty ? { pty: body.pty } : {}),
          ...(body.cwd !== undefined ? { cwd: body.cwd } : {}), ...(body.env !== undefined ? { env: body.env } : {}) },
        Math.min(body.timeoutMs ?? 30_000, MAX_MANAGED_TIMEOUT_MS, metadata.expiresAt - this.controller.now()));
      void starting.then(value => { if (reason) { try { value.kill(9); } catch {} } }).catch(() => {});
      process = await Promise.race([starting, stopped]);
      session.process = process;
      session.stopped = stopped;
      const exit = process.exitCode.then(code => { exited = true; return code; });
      if (!await this.controller.touchTerminalActivity(record.createdAt)) throw new Error('Machine unavailable');
      if (body.stdin) {
        if (!process.stdin) throw new Error('missing_stream');
        session.writer = process.stdin.getWriter();
      }
      record.status = 'running';
      await this.serialized(() => this.save(record));
      if (!body.stdin) await Promise.race([process.stdin?.close(), stopped]);
      pumps = [pump(process.stdout, 'stdout', this), ...(body.pty ? [] : [pump(process.stderr, 'stderr', this)])];
      const [code] = await Promise.race([Promise.all([exit, ...pumps]), stopped]);
      record.exitCode = code;
      outcome = code === 0 ? 'succeeded' : 'failed';
    } catch {
      outcome = reason ?? 'failed';
      record.timedOut = reason === 'timed_out';
      record.outputTruncated = reason === 'output_limit';
    } finally {
      this.timers.clearTimeout(timer);
      this.timers.clearInterval(heartbeat);
      if (!exited) { abort.abort(); try { process?.kill(9); } catch {} }
      // Pending writes must not outlive terminal state or keep pipe locks.
      session.inputFinished = true;
      if (session.writer) void session.writer.abort().catch(() => {});
      for (const reader of readers) await reader.cancel().catch(() => {});
      await Promise.allSettled(pumps);
      await process?.dispose?.();
      // All outstanding output writes precede the final record in the same lock.
      await this.serialized(async () => {
        record.status = outcome;
        record.stdinClosed = true;
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

  async input(record, request) {
    const session = this.sessions.get(record.id);
    if (!session || session.record.status !== 'running' || session.inputFinished || !session.writer) {
      return this.controller.respond({ error: record.stdinEnabled ? 'execution_not_running' : 'stdin_closed' }, 409);
    }
    if (session.record.stdinClosed) return this.controller.respond({ error: 'stdin_closed' }, 409);
    let bytes = new Uint8Array();
    if (request.method === 'POST') {
      const expiry = request.headers.get('x-exec-expires-at');
      if (!expiry || !/^\d+$/.test(expiry) || !await this.controller.getTerminalMetadata(record.createdAt, Number(expiry))) {
        return this.controller.respond({ error: 'container_not_running' }, 409);
      }
      try { bytes = await readFileBytes(request.body, MAX_STDIN_CHUNK_BYTES, request.signal); }
      catch (error) { return this.controller.respond({ error: error.message === 'file_too_large' ? 'stdin_too_large' : 'invalid_request' }, error.message === 'file_too_large' ? 413 : 400); }
      if (session.record.stdinBytes + bytes.byteLength > MAX_STDIN_BYTES || session.pendingInputBytes + bytes.byteLength > MAX_PENDING_STDIN_BYTES) {
        return this.controller.respond({ error: 'stdin_limit' }, 429);
      }
      // Reserve accepted bytes before any pipe write; ambiguous writes keep the
      // reservation. Input payloads are never stored or automatically replayed.
      session.record.stdinBytes += bytes.byteLength;
      session.pendingInputBytes += bytes.byteLength;
    }
    let timer, abortListener, resolveUnavailable;
    const unavailable = new Promise(resolve => { resolveUnavailable = resolve; });
    const work = session.inputTail.then(async () => {
      if (session.inputFinished || session.record.stdinClosed || request.signal.aborted) throw new Error('stdin_closed');
      await this.serialized(() => this.save(session.record));
      if (request.method === 'DELETE') {
        await session.writer.close();
        session.record.stdinClosed = true;
        await this.serialized(() => this.save(session.record));
      } else if (bytes.byteLength) await session.writer.write(bytes);
      if (!await this.controller.touchTerminalActivity(record.createdAt)) throw new Error('container_not_running');
      return { bytes: bytes.byteLength, stdinClosed: session.record.stdinClosed };
    });
    // Keep writes/EOF ordered without blocking output persistence or admission.
    session.inputTail = work.catch(() => {});
    void work.finally(() => { session.pendingInputBytes -= bytes.byteLength; }).catch(() => {});
    try {
      timer = this.timers.setTimeout(() => resolveUnavailable(null), FILE_TIMEOUT_MS);
      abortListener = () => resolveUnavailable(null);
      request.signal.addEventListener('abort', abortListener, { once: true });
      if (request.signal.aborted) abortListener();
      const result = await Promise.race([work, session.stopped.catch(() => null), unavailable]);
      if (!result) return this.controller.respond({ error: 'stdin_unavailable' }, 503);
      return this.controller.respond(result);
    } catch {
      return this.controller.respond({ error: session.inputFinished || session.record.stdinClosed ? 'stdin_closed' : 'stdin_unavailable' }, session.inputFinished || session.record.stdinClosed ? 409 : 503);
    } finally {
      this.timers.clearTimeout(timer);
      request.signal.removeEventListener('abort', abortListener);
    }
  }

  async signal(record, request) {
    let body;
    try { body = await readCommandBody(request); } catch { return this.controller.respond({ error: 'invalid_request' }, 400); }
    if (!body || Object.keys(body).length !== 1 || !EXECUTION_SIGNALS.includes(body.signal)) return this.controller.respond({ error: 'invalid_request' }, 400);
    const session = this.sessions.get(record.id);
    if (!session || session.record.status !== 'running' || session.inputFinished) return this.controller.respond({ error: 'execution_not_running' }, 409);
    if (body.signal === 'SIGKILL') { session.close(); return this.controller.respond(summary(session.record), 202); }
    const sent = await session.process.signal(body.signal === 'SIGINT' ? 2 : 15);
    if (!sent) return this.controller.respond({ error: 'execution_not_running' }, 409);
    return this.controller.respond(summary(session.record), 202);
  }
  async resize(record, request) {
    let body;
    try { body = await readCommandBody(request); } catch { return this.controller.respond({ error: 'invalid_request' }, 400); }
    if (!validTerminalSize(body)) return this.controller.respond({ error: 'invalid_request' }, 400);
    const session = this.sessions.get(record.id);
    if (!session || session.record.status !== 'running' || session.inputFinished || !session.record.pty) {
      return this.controller.respond({ error: 'pty_unavailable' }, 409);
    }
    const expiry = request.headers.get('x-exec-expires-at');
    if (!expiry || !/^\d+$/.test(expiry) || !await this.controller.getTerminalMetadata(record.createdAt, Number(expiry))) {
      return this.controller.respond({ error: 'container_not_running' }, 409);
    }
    try {
      session.process.resize(body.cols, body.rows);
      session.record.pty = body;
      await this.serialized(() => this.save(session.record));
    } catch { return this.controller.respond({ error: 'pty_unavailable' }, 409); }
    return this.controller.respond(summary(session.record));
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
    const match = /^\/executions(?:\/([a-f0-9-]+)(\/(?:events|stdin|signal|resize))?)?$/.exec(url.pathname);
    if (!match || match[1] && !validExecutionId(match[1])) return this.controller.respond({ error: 'not_found' }, 404);
    const createdAt = request.headers.get('x-exec-created-at');
    const expiry = request.headers.get('x-exec-expires-at');
    if (!createdAt) return this.controller.respond({ error: 'forbidden' }, 403);
    if (!match[1] && request.method === 'POST') {
      if (!expiry || !/^\d+$/.test(expiry) || !Number.isSafeInteger(Number(expiry))) return this.controller.respond({ error: 'forbidden' }, 403);
      return this.start(request, createdAt, Number(expiry));
    }
    if (!match[1] && request.method === 'GET') {
      const records = [...(await this.records()).values()].filter(record => record.createdAt === createdAt && record.retainUntil > this.controller.now());
      return this.controller.respond({ executions: records.map(summary) });
    }
    const input = match[2] === '/stdin', signaling = match[2] === '/signal', resizing = match[2] === '/resize';
    if (match[1] && (input && ['POST', 'DELETE'].includes(request.method) || (signaling || resizing) && request.method === 'POST')) {
      const record = await this.ctx.storage.get(RECORD + match[1]);
      if (!record || record.createdAt !== createdAt || record.retainUntil <= this.controller.now()) return this.controller.respond({ error: 'execution_not_found' }, 404);
      return input ? this.input(record, request) : resizing ? this.resize(record, request) : this.signal(record, request);
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
    if (match[2] && match[2] !== '/events') return this.controller.respond({ error: 'method_not_allowed' }, 405);
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
