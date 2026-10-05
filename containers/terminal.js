import { ACCESS_LIMITS } from './plan-policy.js';
const MAX_FRAME = 64 * 1024;
const MAX_PENDING_STDIN = 256 * 1024;
const START_TIMEOUT_MS = 15_000;
const ACK_TIMEOUT_MS = 15_000;
const STOP_GRACE_MS = 1_000;
const MAX_TERMINALS = ACCESS_LIMITS.maxTerminalConnections;
const encoder = new TextEncoder();

function dimensions(value) {
  return Number.isInteger(value) && value >= 1 && value <= 500;
}

function send(socket, value) {
  socket.send(JSON.stringify(value));
}

function bytes(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

export async function upgradeTerminal(controller, request, active, options = {}) {
  const url = new URL(request.url);
  const browser = url.pathname === '/terminal';
  if (!browser && url.pathname !== '/ssh') return controller.respond({ error: 'Not found' }, 404);
  if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return controller.respond({ error: 'WebSocket required' }, 426);
  }
  const prefix = browser ? 'x-terminal' : 'x-ssh';
  const createdAt = request.headers.get(`${prefix}-created-at`);
  const expiryText = request.headers.get(`${prefix}-expires-at`);
  const expiry = expiryText && /^\d+$/.test(expiryText) ? Number(expiryText) : NaN;
  if (!createdAt || !Number.isSafeInteger(expiry)) {
    return controller.respond({ error: 'Forbidden' }, 403);
  }
  const metadata = await controller.getTerminalMetadata(createdAt, expiry);
  if (!metadata) return controller.respond({ error: 'Container unavailable' }, browser ? 409 : 403);
  const cols = Number(request.headers.get('x-terminal-cols'));
  const rows = Number(request.headers.get('x-terminal-rows'));
  if (browser && (!dimensions(cols) || !dimensions(rows) || rows > 200)) {
    return controller.respond({ error: 'Invalid dimensions' }, 400);
  }
  if (active.size >= MAX_TERMINALS) return controller.respond({ error: 'Too many terminals' }, 429);

  const pair = (options.pairFactory ?? (() => new WebSocketPair()))();
  const [client, server] = Object.values(pair);
  const session = new TerminalSession({
    socket: server,
    browser,
    controller,
    createdAt,
    expiresAt: Math.min(expiry, metadata.expiresAt),
    active,
    timers: options.timers ?? globalThis,
  });
  active.add(session);
  // The current Workers compatibility date defaults binary messages to Blob.
  // stdin consumes bytes, so request ArrayBuffer delivery before accepting.
  server.binaryType = 'arraybuffer';
  server.accept();
  session.open();
  if (browser) void session.onMessage(JSON.stringify({ type: 'start', pty: { cols, rows, term: 'xterm-256color' } }));
  return (options.responseFactory ?? ((webSocket) => new Response(null, { status: 101, webSocket })))(client);
}

export class TerminalSession {
  constructor({ socket, controller, createdAt, expiresAt, active, browser = false, timers = globalThis }) {
    Object.assign(this, { socket, controller, createdAt, expiresAt, active, browser, timers });
    this.abort = new AbortController();
    this.closed = false;
    this.started = false;
    this.processExited = false;
    this.pendingStdin = 0;
    this.inputTail = Promise.resolve();
    this.outputTail = Promise.resolve();
    this.ackWaiter = null;
    this.timersSet = new Set();
  }

  timer(callback, ms) {
    const id = this.timers.setTimeout(() => {
      this.timersSet.delete(id);
      callback();
    }, ms);
    this.timersSet.add(id);
    return id;
  }

  clearTimer(id) {
    if (id !== undefined) {
      this.timers.clearTimeout(id);
      this.timersSet.delete(id);
    }
  }

  open() {
    this.socket.addEventListener('message', (event) => { void this.onMessage(event.data); });
    this.socket.addEventListener('close', () => this.close());
    this.socket.addEventListener('error', () => this.close());
    this.startTimer = this.timer(() => this.fail('Terminal start timed out'), START_TIMEOUT_MS);
    const lifetime = this.expiresAt - this.controller.now();
    this.deadlineTimer = this.timer(() => this.close(1000, 'Session expired'), Math.max(0, lifetime));
  }

  async activity() {
    if (!await this.controller.touchTerminalActivity(this.createdAt)) {
      this.close(1000, 'Machine unavailable');
      return false;
    }
    return true;
  }

  async onMessage(data) {
    if (this.closed) return;
    if (typeof data !== 'string') {
      const input = bytes(data);
      if (!input || !this.started || !this.process || !input.byteLength || input.byteLength > MAX_FRAME) {
        this.fail('Invalid terminal input');
        return;
      }
      if (this.pendingStdin + input.byteLength > MAX_PENDING_STDIN || this.stdinClosed) {
        this.fail('Invalid terminal input');
        return;
      }
      this.pendingStdin += input.byteLength;
      // Copy before a transport can reuse the ArrayBuffer.
      const chunk = input.slice();
      this.inputTail = this.inputTail.then(async () => {
        if (this.closed || !await this.activity() || this.closed) return;
        await this.writer.write(chunk);
      }).catch(() => this.fail('Terminal input failed')).finally(() => {
        this.pendingStdin -= chunk.byteLength;
      });
      return;
    }
    if (encoder.encode(data).byteLength > 20 * 1024) return this.fail('Invalid terminal message');
    let message;
    try { message = JSON.parse(data); } catch { return this.fail('Invalid terminal message'); }
    if (!message || typeof message !== 'object' || Array.isArray(message)) return this.fail('Invalid terminal message');
    if (message.type === 'ack') {
      if (!this.ackWaiter) return this.fail('Unexpected terminal acknowledgement');
      const resolve = this.ackWaiter;
      this.ackWaiter = null;
      resolve();
      return;
    }
    if (this.browser && message.type === undefined && 'cols' in message && 'rows' in message) message.type = 'resize';
    if (message.type === 'start') {
      if (this.started || this.starting) return this.fail('Terminal already started');
      const { command, pty } = message;
      if ((command !== undefined && (typeof command !== 'string' || encoder.encode(command).byteLength > 16 * 1024))
        || (pty !== undefined && (!pty || typeof pty !== 'object' || Array.isArray(pty)
          || !dimensions(pty.cols) || !dimensions(pty.rows)
          || (pty.term !== undefined && (typeof pty.term !== 'string'
            || !/^[\x20-\x7e]{1,64}$/.test(pty.term)))))) {
        return this.fail('Invalid terminal start');
      }
      this.starting = true;
      try {
        const argv = this.browser ? ['tmux', 'new-session', '-A', '-s', 'main']
          : command === undefined ? ['/bin/bash', '-l'] : ['/bin/sh', '-lc', command];
        const execOptions = {
          stdin: 'pipe', stdout: 'pipe', stderr: pty ? 'combined' : 'pipe',
          signal: this.abort.signal,
        };
        if (this.browser) {
          execOptions.cwd = '/root';
          execOptions.env = { TERM: 'xterm-256color', HOME: '/root', LANG: 'C.UTF-8' };
        }
        if (pty) {
          execOptions.pty = { cols: pty.cols, rows: pty.rows };
          if (pty.term && !this.browser) execOptions.env = { TERM: pty.term };
        }
        this.process = await this.controller.startTerminalProcess(
          this.createdAt, this.expiresAt, argv, execOptions,
        );
        // Observe exit immediately, including a disconnect while exec was pending.
        void this.process.exitCode.then(() => { this.processExited = true; this.clearTimer(this.stopTimer); })
          .catch(() => { this.processExited = true; this.clearTimer(this.stopTimer); });
        if (this.closed) return this.stopProcess();
        this.started = true;
        this.writer = this.process.stdin?.getWriter();
        if (!this.writer || !this.process.stdout) throw new Error('Missing process streams');
        this.clearTimer(this.startTimer);
        send(this.socket, { type: 'ready' });
        const outputs = [this.pump(this.process.stdout, 1)];
        if (this.process.stderr) outputs.push(this.pump(this.process.stderr, 2));
        void Promise.all([this.process.exitCode, ...outputs]).then(([code]) => {
          this.processExited = true;
          if (!this.closed) {
            send(this.socket, { type: 'exit', code });
            this.close(1000, 'Process exited');
          }
        }).catch(() => this.fail('Terminal output failed'));
      } catch {
        this.fail('Unable to start terminal');
      }
      return;
    }
    if (!this.started || !this.process) return this.fail('Terminal not started');
    if (message.type === 'resize') {
      if (!dimensions(message.cols) || !dimensions(message.rows) || (this.browser && message.rows > 200) || !this.process.isPty) return this.fail('Invalid terminal resize');
      try { if (!this.processExited) this.process.resize(message.cols, message.rows); } catch { this.fail('Terminal resize failed'); }
      return;
    }
    if (this.browser) return this.fail('Invalid terminal message');
    if (message.type === 'signal') {
      if (!Number.isInteger(message.signal) || message.signal < 1 || message.signal > 64) return this.fail('Invalid terminal signal');
      try { if (!this.processExited) this.process.kill(message.signal); } catch { this.fail('Terminal signal failed'); }
      return;
    }
    if (message.type === 'eof') {
      if (this.stdinClosed) return this.fail('Terminal input closed');
      this.stdinClosed = true;
      this.inputTail = this.inputTail.then(() => this.writer.close()).catch(() => this.fail('Terminal input failed'));
      return;
    }
    this.fail('Invalid terminal message');
  }

  async pump(stream, prefix) {
    const reader = stream.getReader();
    try {
      while (!this.closed) {
        const { done, value } = await reader.read();
        if (done) break;
        for (let offset = 0; offset < value.byteLength && !this.closed; offset += MAX_FRAME) {
          const part = value.subarray(offset, offset + MAX_FRAME);
          const frame = new Uint8Array(part.byteLength + (this.browser ? 0 : 1));
          if (!this.browser) frame[0] = prefix;
          frame.set(part, this.browser ? 0 : 1);
          const previous = this.outputTail;
          let release;
          this.outputTail = new Promise((resolve) => { release = resolve; });
          await previous;
          try {
            if (this.closed || !await this.activity() || this.closed) return;
            this.socket.send(frame);
            await new Promise((resolve, reject) => {
              this.ackWaiter = resolve;
              this.ackTimer = this.timer(() => reject(new Error('Output acknowledgement timed out')), ACK_TIMEOUT_MS);
            });
            this.clearTimer(this.ackTimer);
          } finally { release(); }
        }
      }
    } finally {
      try { await reader.cancel(); } catch { /* stream already closed */ }
    }
  }

  stopProcess() {
    if (!this.process || this.processExited) return;
    try { this.process.kill(15); } catch { return; }
    this.stopTimer = this.timer(() => {
      if (!this.processExited) this.abort.abort();
    }, STOP_GRACE_MS);
  }

  fail(message) {
    if (this.closed) return;
    try { send(this.socket, { type: 'error', message }); } catch { /* connection closed */ }
    this.close(1002, message);
  }

  close(code, reason) {
    if (this.closed) return;
    this.closed = true;
    this.active.delete(this);
    for (const id of this.timersSet) this.timers.clearTimeout(id);
    this.timersSet.clear();
    if (this.ackWaiter) {
      const resolve = this.ackWaiter;
      this.ackWaiter = null;
      resolve();
    }
    this.stopProcess();
    if (!this.process && this.starting) this.abort.abort();
    try { this.socket.close(code, reason); } catch { /* already closed */ }
  }
}
