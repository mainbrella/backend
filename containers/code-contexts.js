import { MAX_EXECUTIONS, MAX_OUTPUT_BYTES, readCommandBody } from './command-contract.js';
import { MAX_CODE_CONTEXT_MS, MAX_CODE_RESULT_BYTES, validCodeContext, validCodeContextId, validCodeExecution } from './code-contract.js';
import { PYTHON_KERNEL } from './code-kernel.js';
import { startOperationProcess } from './process-supervisor.js';

const PREFIX = 'code-context:';
const encoder = new TextEncoder();
const MAX_PROTOCOL_BYTES = 2 * MAX_OUTPUT_BYTES;
const failure = code => new Error(code);
const publicContext = session => ({ id: session.id, language: 'python', createdAt: session.createdAt, expiresAt: session.expiresAt });

function boundedResult(message, nativeOutput) {
  let remaining = MAX_CODE_RESULT_BYTES, truncated = message.outputTruncated;
  const take = text => {
    const bytes = encoder.encode(text);
    if (bytes.byteLength > remaining) truncated = true;
    // Streaming decode discards an incomplete trailing UTF-8 sequence, avoiding
    // a replacement character that could itself exceed the remaining budget.
    const value = new TextDecoder().decode(bytes.subarray(0, remaining), { stream: true });
    remaining -= encoder.encode(value).byteLength;
    return value;
  };
  const result = { stdout: take(message.stdout), stderr: take(message.stderr), results: [], error: null, outputTruncated: false };
  for (const item of message.results) {
    const mimeBytes = encoder.encode(item.mimeType).byteLength;
    if (mimeBytes + encoder.encode(item.data).byteLength <= remaining) {
      remaining -= mimeBytes;
      result.results.push({ mimeType: item.mimeType, data: take(item.data) });
    } else {
      truncated = true;
      // JSON, HTML and PNG representations must remain complete. Only plain
      // text can be shortened without corrupting its content format.
      if (item.mimeType === 'text/plain' && mimeBytes < remaining) {
        remaining -= mimeBytes;
        result.results.push({ mimeType: item.mimeType, data: take(item.data) });
      }
    }
  }
  if (message.error !== null) result.error = {
    name: take(message.error.name), message: take(message.error.message), traceback: take(message.error.traceback),
  };
  result.stderr += take(nativeOutput);
  result.outputTruncated = truncated;
  // The content budget excludes JSON escaping/field names. Four MIME entries
  // and the fixed shape bound that overhead; also enforce the wire bound.
  if (encoder.encode(JSON.stringify(result)).byteLength > MAX_PROTOCOL_BYTES) throw failure('code_output_limit');
  return result;
}

export class CodeContexts {
  constructor(controller, active, ctx) {
    Object.assign(this, { controller, active, ctx });
    this.contexts = new Map();
  }
  async stopGeneration(createdAt) {
    await this.controller.serialized(async () => {
      const metadata = await this.ctx.storage.get('builderMachine');
      if (metadata && new Date(metadata.createdAt).toISOString() === createdAt && this.controller.container.running) {
        await this.controller.destroy('Code context cleanup failed during runtime restart');
      }
    });
  }
  async recover() {
    // Pipe handles cannot survive DO recovery. Never replay code or pretend the
    // old namespace was restored. Kill old process groups before clearing them.
    for (const [key, record] of await this.ctx.storage.list({ prefix: PREFIX })) {
      const metadata = await this.ctx.storage.get('builderMachine');
      if (metadata && new Date(metadata.createdAt).toISOString() === record.createdAt && this.controller.container.running) {
        const killed = record.pid && await this.controller.signalOperationGroup(record.createdAt, record.pid, 9).catch(() => false);
        if (!killed) await this.stopGeneration(record.createdAt);
      }
      await this.ctx.storage.delete(key);
    }
  }
  async close(session, code = 'code_context_closed') {
    if (session.closed) return session.cleanup;
    session.closed = true;
    this.contexts.delete(session.id);
    clearTimeout(session.timer);
    session.abort.abort();
    session.pending?.reject(failure(code));
    session.ready?.reject(failure(code));
    session.cleanup = (async () => {
      const process = session.process ?? await session.starting?.catch(() => null);
      process?.kill(9);
      const confirmed = await process?.dispose().catch(() => false);
      // A failed process-group kill must not free admission capacity while the
      // old interpreter still consumes compute. Stop the generation to confirm
      // cleanup; if that also fails, retain both capacity and recovery evidence.
      if (confirmed === false) await this.stopGeneration(session.createdAt);
      await this.ctx.storage.delete(PREFIX + session.id);
      this.active.delete(session);
      await Promise.allSettled([session.writer?.abort(), session.reader?.cancel(), session.stderrReader?.cancel()]);
    })();
    this.ctx.waitUntil(session.cleanup.catch(() => {}));
    return session.cleanup;
  }
  async pump(session) {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let text = '';
    while (!session.closed) {
      const { value, done } = await session.reader.read();
      if (done) throw failure('code_context_closed');
      text += decoder.decode(value, { stream: true });
      if (encoder.encode(text).byteLength > MAX_PROTOCOL_BYTES) throw failure('code_output_limit');
      let newline;
      while ((newline = text.indexOf('\n')) >= 0) {
        const message = JSON.parse(text.slice(0, newline));
        text = text.slice(newline + 1);
        if (message.ready === true && session.ready) { session.ready.resolve(); session.ready = null; continue; }
        const pending = session.pending;
        if (!pending || pending.completed || message.requestId !== pending.id || typeof message.stdout !== 'string'
          || typeof message.stderr !== 'string' || !Array.isArray(message.results) || message.results.length > 4
          || typeof message.outputTruncated !== 'boolean'
          || message.results.some(item => !item || !['text/plain', 'text/html', 'application/json', 'image/png'].includes(item.mimeType) || typeof item.data !== 'string')
          || message.error !== null && (!message.error || ['name', 'message', 'traceback'].some(key => typeof message.error[key] !== 'string'))) throw failure('code_context_unavailable');
        pending.result = message;
        this.complete(pending);
      }
    }
  }
  complete(pending) {
    if (!pending.result || !pending.nativeDone || pending.completed) return;
    const result = boundedResult(pending.result, pending.nativeOutput);
    pending.completed = true;
    pending.resolve(result);
  }
  async stderr(session) {
    const decoder = new TextDecoder();
    while (!session.closed) {
      const { value, done } = await session.stderrReader.read();
      if (done) return;
      const decoded = decoder.decode(value, { stream: true });
      const pending = session.pending;
      if (pending && !pending.nativeDone) {
        pending.nativeBytes += value.byteLength;
        if (pending.nativeBytes > MAX_OUTPUT_BYTES) throw failure('code_output_limit');
        pending.nativeOutput += decoded;
        const boundary = pending.nativeOutput.indexOf(`\x1e${pending.id}\x1f`);
        if (boundary !== -1) {
          pending.nativeOutput = pending.nativeOutput.slice(0, boundary);
          pending.nativeDone = true;
          this.complete(pending);
        }
      }
    }
  }
  async create(createdAt, expiresAt) {
    const metadata = await this.controller.getTerminalMetadata(createdAt, expiresAt);
    if (!metadata) return this.controller.respond({ error: 'container_not_running' }, 409);
    if (this.active.size >= MAX_EXECUTIONS) return this.controller.respond({ error: 'execution_limit' }, 429);
    const session = { id: crypto.randomUUID(), createdAt, expiresAt: Math.min(expiresAt, this.controller.now() + MAX_CODE_CONTEXT_MS),
      abort: new AbortController(), closed: false, close: () => this.close(session).catch(() => {}) };
    this.active.add(session);
    this.contexts.set(session.id, session);
    const ready = new Promise((resolve, reject) => { session.ready = { resolve, reject }; });
    void ready.catch(() => {});
    session.timer = setTimeout(session.close, session.expiresAt - this.controller.now());
    let startupTimer;
    try {
      await this.ctx.storage.put(PREFIX + session.id, { createdAt });
      if (session.closed) throw failure('code_context_closed');
      const starting = startOperationProcess(this.controller, createdAt, expiresAt, ['python3', '-u', '-c', PYTHON_KERNEL],
        { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', signal: session.abort.signal }, session.expiresAt - this.controller.now());
      session.starting = starting;
      startupTimer = setTimeout(() => { void this.close(session, 'code_context_unavailable').catch(() => {}); }, 10_000);
      session.process = await Promise.race([starting, ready]);
      if (session.closed || !session.process?.stdin || !session.process.stdout || !session.process.stderr) throw failure('code_context_unavailable');
      await this.ctx.storage.put(PREFIX + session.id, { createdAt, pid: session.process.pid });
      session.writer = session.process.stdin.getWriter();
      session.reader = session.process.stdout.getReader();
      session.stderrReader = session.process.stderr.getReader();
      void this.pump(session).catch(error => this.close(session, error.message)).catch(() => {});
      void this.stderr(session).catch(error => this.close(session, error.message)).catch(() => {});
      void session.process.exitCode.then(session.close, session.close);
      await ready;
      if (!await this.controller.touchTerminalActivity(createdAt) || session.closed) throw failure('container_not_running');
      return this.controller.respond(publicContext(session), 201);
    } catch {
      void session.close();
      return this.controller.respond({ error: 'code_context_unavailable' }, 503);
    } finally { clearTimeout(startupTimer); }
  }
  async execute(session, body, expiresAt, signal) {
    if (session.pending) return this.controller.respond({ error: 'code_context_busy' }, 409);
    // Reserve before awaiting authorization so simultaneous requests cannot run
    // or overwrite each other's correlation state.
    const result = new Promise((resolve, reject) => {
      session.pending = { id: crypto.randomUUID(), resolve, reject, nativeOutput: '', nativeBytes: 0, nativeDone: false };
    });
    void result.catch(() => {});
    const timeout = setTimeout(() => { void this.close(session, 'code_execution_timeout').catch(() => {}); },
      Math.min(body.timeoutMs ?? 30_000, session.expiresAt - this.controller.now()));
    const abort = () => { void session.close(); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const heartbeat = setInterval(() => {
      void this.controller.touchTerminalActivity(session.createdAt).then(ok => { if (!ok) abort(); }, abort);
    }, 15_000);
    try {
      const metadata = await this.controller.getTerminalMetadata(session.createdAt, expiresAt);
      if (!metadata || !await this.controller.touchTerminalActivity(session.createdAt) || session.closed) throw failure('container_not_running');
      await Promise.race([session.writer.write(encoder.encode(JSON.stringify({ code: body.code, requestId: session.pending.id }) + '\n')), result]);
      return this.controller.respond(await result);
    } catch (error) {
      await this.close(session);
      const code = ['container_not_running', 'code_execution_timeout', 'code_output_limit', 'code_context_closed'].includes(error.message)
        ? error.message : 'code_context_unavailable';
      return this.controller.respond({ error: code }, code === 'code_execution_timeout' ? 504 : code === 'code_output_limit' ? 413 : code === 'code_context_unavailable' ? 503 : 409);
    } finally {
      clearTimeout(timeout); clearInterval(heartbeat);
      signal.removeEventListener('abort', abort);
      session.pending = null;
    }
  }
  async fetch(request) {
    const match = /^\/code-contexts(?:\/([^/]+)(\/execute)?)?$/.exec(new URL(request.url).pathname);
    if (!match || match[1] && !validCodeContextId(match[1])) return this.controller.respond({ error: 'not_found' }, 404);
    const createdAt = request.headers.get('x-exec-created-at');
    if (!createdAt || !Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) return this.controller.respond({ error: 'invalid_generation' }, 400);
    if (!match[1] && request.method === 'GET') return this.controller.respond({ contexts: [...this.contexts.values()]
      .filter(session => session.createdAt === createdAt && !session.closed).map(publicContext) });
    if (!match[1] && request.method === 'POST' || match[2] && request.method === 'POST') {
      let body;
      try { body = await readCommandBody(request); } catch { return this.controller.respond({ error: 'invalid_request' }, 400); }
      if (!(match[1] ? validCodeExecution(body) : validCodeContext(body))) return this.controller.respond({ error: 'invalid_request' }, 400);
      const expiresAt = Number(request.headers.get('x-exec-expires-at'));
      if (!match[1]) return this.create(createdAt, expiresAt);
      const session = this.contexts.get(match[1]);
      if (!session || session.createdAt !== createdAt) return this.controller.respond({ error: 'code_context_not_found' }, 404);
      return this.execute(session, body, expiresAt, request.signal);
    }
    if (match[1] && !match[2] && request.method === 'DELETE') {
      const session = this.contexts.get(match[1]);
      if (!session || session.createdAt !== createdAt) return this.controller.respond({ error: 'code_context_not_found' }, 404);
      await this.close(session);
      return this.controller.respond({ closed: true });
    }
    return this.controller.respond({ error: 'method_not_allowed' }, 405);
  }
}
