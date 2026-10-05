import test from 'node:test';
import assert from 'node:assert/strict';
import { upgradeTerminal } from './terminal.js';
import { UserContainerController } from './user-container-core.js';

const BASE = Date.UTC(2026, 9, 5, 12);
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

class Storage {
  values = new Map();
  alarmAt = null;
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async setAlarm(at) { this.alarmAt = at; }
  async deleteAlarm() { this.alarmAt = null; }
}

class Socket {
  binaryType = 'blob';
  listeners = new Map();
  sent = [];
  closed = false;
  accept() {}
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  send(data) { this.sent.push(data); }
  close(code, reason) { this.closed = true; this.closeCode = code; this.closeReason = reason; }
  receive(data) {
    if (data instanceof ArrayBuffer && this.binaryType === 'blob') data = new Blob([data]);
    this.listeners.get('message')?.({ data });
  }
  disconnect() { this.listeners.get('close')?.({}); }
  messages() { return this.sent.filter((x) => typeof x === 'string').map((x) => JSON.parse(x)); }
}

function fixture({ blockWrites = false } = {}) {
  let now = BASE;
  const output = deferred();
  const written = [];
  const writeGate = deferred();
  const signals = [];
  const sizes = [];
  let stdinClosed = false;
  let stdoutController;
  let stderrController;
  const process = {
    isPty: false,
    stdin: new WritableStream({ write(chunk) { written.push(chunk); return blockWrites ? writeGate.promise : undefined; }, close() { stdinClosed = true; } }),
    stdout: new ReadableStream({ start(c) { stdoutController = c; } }),
    stderr: new ReadableStream({ start(c) { stderrController = c; } }),
    exitCode: output.promise,
    kill(signal) { signals.push(signal); },
    resize(cols, rows) { sizes.push([cols, rows]); },
  };
  const calls = [];
  const container = {
    running: true,
    starts: 0,
    start() { this.starts++; this.running = true; },
    async destroy() { this.running = false; },
    inactivityTimeouts: [],
    async setInactivityTimeout(ms) { this.inactivityTimeouts.push(ms); },
    async exec(argv, options) { calls.push({ argv, options }); process.isPty = !!options.pty; if (options.pty) process.stderr = undefined; return process; },
  };
  const storage = new Storage();
  storage.values.set('machineEntitlement', { active: true, plan: 'builder', validUntil: BASE + 3_600_000, checkedAt: BASE });
  storage.values.set('builderMachine', {
    createdAt: BASE,
    expiresAt: BASE + 3_600_000,
    idleExpiresAt: BASE + 600_000,
  });
  const controller = new UserContainerController({ storage, container }, () => now);
  const active = new Set();
  controller.onStopped = () => { for (const session of active) session.close(1000, 'Container stopped'); };
  let server;
  const connect = async (headers = {}, options = {}) => {
    const request = new Request(`https://internal.test${options.browser ? '/terminal' : '/ssh'}`, {
      headers: {
        Upgrade: 'websocket',
        'x-ssh-created-at': new Date(BASE).toISOString(),
        'x-ssh-expires-at': String(BASE + 1_800_000),
        ...(options.browser ? {
          'x-terminal-created-at': new Date(BASE).toISOString(),
          'x-terminal-expires-at': String(BASE + 3_600_000),
          'x-terminal-cols': '80', 'x-terminal-rows': '24',
        } : {}),
        ...headers,
      },
    });
    return upgradeTerminal(controller, request, active, {
      pairFactory: () => {
        server = new Socket();
        return { 0: new Socket(), 1: server };
      },
      responseFactory: (socket) => ({ status: 101, webSocket: socket }),
      ...options,
    });
  };
  return {
    connect, controller, container, storage, active, process, calls, output,
    stdout: () => stdoutController, stderr: () => stderrController,
    written, signals, sizes, server: () => server,
    releaseWrites: () => writeGate.resolve(),
    stdinClosed: () => stdinClosed,
    setTime(value) { now = value; },
  };
}

test('upgrade rejects stopped, stale, malformed, and expired generations without exec', async () => {
  const f = fixture();
  assert.equal((await f.connect({ 'x-ssh-created-at': new Date(BASE + 1).toISOString() })).status, 403);
  assert.equal((await f.connect({ 'x-ssh-expires-at': 'NaN' })).status, 403);
  assert.equal((await f.connect({ 'x-ssh-expires-at': String(BASE + 3_600_001) })).status, 403);
  assert.equal((await f.connect({ 'x-ssh-expires-at': String(BASE) })).status, 403);
  f.container.running = false;
  assert.equal((await f.connect()).status, 403);
  f.container.running = true;
  f.setTime(BASE + 600_000);
  assert.equal((await f.connect()).status, 403);
  assert.equal(f.calls.length, 0);
});

test('max four terminals, shell options, PTY resize, signal, stdin, and EOF', async () => {
  const f = fixture();
  const sockets = [];
  for (let i = 0; i < 4; i++) {
    assert.equal((await f.connect()).status, 101);
    sockets.push(f.server());
  }
  assert.equal((await f.connect()).status, 429);
  const socket = sockets[0];
  socket.receive(JSON.stringify({ type: 'start', pty: { cols: 80, rows: 24, term: 'xterm-256color' } }));
  await tick();
  assert.deepEqual(f.calls[0].argv, ['/bin/bash', '-l']);
  assert.deepEqual(f.calls[0].options.pty, { cols: 80, rows: 24 });
  assert.deepEqual(f.calls[0].options.env, { TERM: 'xterm-256color' });
  assert.equal(f.calls[0].options.stderr, 'combined');
  assert.equal(f.calls[0].options.stdin, 'pipe');
  assert.deepEqual(socket.messages(), [{ type: 'ready' }]);
  socket.receive(JSON.stringify({ type: 'resize', cols: 120, rows: 36 }));
  socket.receive(JSON.stringify({ type: 'signal', signal: 2 }));
  socket.receive(new TextEncoder().encode('pwd\n').buffer);
  await tick();
  assert.deepEqual(f.sizes, [[120, 36]]);
  assert.deepEqual(f.signals, [2]);
  assert.equal(new TextDecoder().decode(f.written[0]), 'pwd\n');
  socket.receive(JSON.stringify({ type: 'eof' }));
  await tick();
  assert.equal(f.stdinClosed(), true);
  assert.equal(f.storage.alarmAt, BASE + 600_000);
  for (const item of sockets) item.disconnect();
  assert.equal(f.active.size, 0);
});

test('command mode preserves stream framing and waits for an acknowledgement before next output', async () => {
  const f = fixture();
  await f.connect();
  const socket = f.server();
  socket.receive(JSON.stringify({ type: 'start', command: 'echo hello' }));
  await tick();
  assert.deepEqual(f.calls[0].argv, ['/bin/sh', '-lc', 'echo hello']);
  assert.equal(f.calls[0].options.stderr, 'pipe');
  f.stdout().enqueue(new TextEncoder().encode('one'));
  f.stdout().enqueue(new TextEncoder().encode('two'));
  f.stderr().enqueue(new TextEncoder().encode('err'));
  await tick();
  assert.equal(socket.sent.filter((x) => x instanceof Uint8Array).length, 1);
  const first = socket.sent.find((x) => x instanceof Uint8Array);
  assert.equal(first[0], 1);
  assert.equal(new TextDecoder().decode(first.subarray(1)), 'one');
  socket.receive(JSON.stringify({ type: 'ack' }));
  await tick();
  assert.equal(socket.sent.filter((x) => x instanceof Uint8Array).length, 2);
  socket.receive(JSON.stringify({ type: 'ack' }));
  await tick();
  socket.receive(JSON.stringify({ type: 'ack' }));
  f.stdout().close();
  f.stderr().close();
  f.output.resolve(0);
  await tick();
  assert.deepEqual(socket.messages().at(-1), { type: 'exit', code: 0 });
  assert.equal(socket.closed, true);
});

test('activity extends idle deadline to hard cap; polling and idle socket do not', async () => {
  const f = fixture();
  await f.connect();
  assert.equal(f.storage.alarmAt, null);
  f.setTime(BASE + 500_000);
  f.server().receive(JSON.stringify({ type: 'start' }));
  await tick();
  assert.equal(f.storage.alarmAt, null);
  f.server().receive(new Uint8Array([65]).buffer);
  await tick();
  assert.equal(f.storage.alarmAt, BASE + 1_100_000);
  f.setTime(BASE + 3_500_000);
  // Simulate persisted activity from another channel so this connection is valid.
  const metadata = await f.storage.get('builderMachine');
  metadata.idleExpiresAt = BASE + 3_600_000;
  await f.storage.put('builderMachine', metadata);
  f.server().receive(new Uint8Array([66]).buffer);
  await tick();
  assert.equal(f.storage.alarmAt, BASE + 3_600_000);
  f.server().disconnect();
});

test('malformed start, oversize input, and duplicate start close only that terminal', async () => {
  const f = fixture();
  await f.connect();
  const first = f.server();
  first.receive('{');
  assert.equal(first.closed, true);
  assert.equal(f.calls.length, 0);
  await f.connect();
  const second = f.server();
  second.receive(JSON.stringify({ type: 'start', pty: { cols: 0, rows: 24 } }));
  assert.equal(second.closed, true);
  await f.connect();
  const third = f.server();
  third.receive(JSON.stringify({ type: 'start' }));
  await tick();
  third.receive(new Uint8Array(65_537).buffer);
  assert.equal(third.closed, true);
  await f.connect();
  const fourth = f.server();
  fourth.receive(JSON.stringify({ type: 'start' }));
  await tick();
  fourth.receive(JSON.stringify({ type: 'start' }));
  assert.equal(fourth.closed, true);
  assert.equal(f.container.running, true);
});

test('disconnect signals only the attached process and frees its slot', async () => {
  const f = fixture();
  await f.connect();
  const socket = f.server();
  socket.receive(JSON.stringify({ type: 'start' }));
  await tick();
  socket.disconnect();
  assert.deepEqual(f.signals, [15]);
  assert.equal(f.active.size, 0);
  assert.equal(f.container.running, true);
  assert.equal((await f.connect()).status, 101);
  f.server().disconnect();
});

test('pending stdin is capped at 256 KiB even when the process stalls', async () => {
  const f = fixture({ blockWrites: true });
  await f.connect();
  const socket = f.server();
  socket.receive(JSON.stringify({ type: 'start' }));
  await tick();
  for (let i = 0; i < 4; i++) socket.receive(new Uint8Array(65_536).buffer);
  assert.equal(socket.closed, false);
  socket.receive(new Uint8Array([1]).buffer);
  assert.equal(socket.closed, true);
  assert.equal(f.active.size, 0);
  f.releaseWrites();
});

test('start and output acknowledgement deadlines terminate a stalled session', async () => {
  class Timers {
    entries = new Map();
    nextId = 1;
    setTimeout(callback, ms) { const id = this.nextId++; this.entries.set(id, { callback, ms }); return id; }
    clearTimeout(id) { this.entries.delete(id); }
    fire(ms) {
      const entry = [...this.entries].find(([, value]) => value.ms === ms);
      assert.ok(entry, `timer ${ms} exists`);
      this.entries.delete(entry[0]);
      entry[1].callback();
    }
  }
  const f = fixture();
  const timers = new Timers();
  await f.connect({}, { timers });
  const first = f.server();
  timers.fire(15_000);
  assert.equal(first.closed, true);
  assert.equal(f.active.size, 0);
  await f.connect({}, { timers });
  const second = f.server();
  second.receive(JSON.stringify({ type: 'start' }));
  await tick();
  f.stdout().enqueue(new Uint8Array([42]));
  await tick();
  assert.equal(second.closed, false);
  timers.fire(15_000);
  await tick();
  assert.equal(second.closed, true);
  assert.deepEqual(f.signals, [15]);
});

test('browser terminal automatically attaches to fixed tmux session with PTY, raw bytes and resize', async () => {
  const f = fixture();
  const before = structuredClone(f.storage.values);
  assert.equal((await f.connect({}, { browser: true })).status, 101);
  await tick();
  assert.deepEqual(f.calls[0].argv, ['tmux', 'new-session', '-A', '-s', 'main']);
  assert.deepEqual(f.calls[0].options.pty, { cols: 80, rows: 24 });
  assert.equal(f.calls[0].options.stderr, 'combined');
  assert.equal(f.calls[0].options.cwd, '/root');
  assert.equal(f.calls[0].options.env.TERM, 'xterm-256color');
  assert.ok(f.calls[0].options.signal instanceof AbortSignal);
  assert.equal(f.process.stderr, undefined);
  assert.equal(f.container.starts, 0);
  assert.deepEqual(f.storage.values, before); // No monthly quota, idle, or hard lease changes on attach.
  const socket = f.server();
  socket.receive(new TextEncoder().encode('printf hello\n').buffer);
  socket.receive(JSON.stringify({ cols: 120, rows: 36 }));
  await tick();
  assert.deepEqual(f.sizes, [[120, 36]]);
  assert.equal(new TextDecoder().decode(f.written[0]), 'printf hello\n');
  f.stdout().enqueue(new TextEncoder().encode('hello'));
  await tick();
  const frame = socket.sent.find(value => value instanceof Uint8Array);
  assert.equal(new TextDecoder().decode(frame), 'hello'); // No SSH channel prefix on browser output.
  socket.receive(JSON.stringify({ type: 'ack' }));
  f.stdout().close();
  f.output.resolve(0);
  await tick();
  assert.equal(socket.closeCode, 1000);
  assert.deepEqual(socket.messages().at(-1), { type: 'exit', code: 0 });
  assert.deepEqual(f.signals, []); // Never signal an already-exited process.
});

test('browser terminal rejects stopped, stale, expired, or malformed attachments without starting', async () => {
  const f = fixture();
  assert.equal((await f.connect({ 'x-terminal-created-at': new Date(BASE + 1).toISOString() }, { browser: true })).status, 409);
  assert.equal((await f.connect({ 'x-terminal-cols': 'NaN' }, { browser: true })).status, 400);
  assert.equal((await f.connect({ 'x-terminal-rows': '201' }, { browser: true })).status, 400);
  f.container.running = false;
  assert.equal((await f.connect({}, { browser: true })).status, 409);
  f.container.running = true;
  f.setTime(BASE + 600_000);
  assert.equal((await f.connect({}, { browser: true })).status, 409);
  assert.equal(f.calls.length, 0);
  assert.equal(f.container.starts, 0);
});

test('browser disconnect kills only the tmux client; reconnect attaches to the same session', async () => {
  const f = fixture();
  await f.connect({}, { browser: true });
  await tick();
  const first = f.server();
  first.disconnect();
  assert.deepEqual(f.signals, [15]);
  assert.equal(f.container.running, true);
  assert.equal(f.active.size, 0);
  await f.connect({}, { browser: true });
  await tick();
  assert.deepEqual(f.calls.map(c => c.argv), [
    ['tmux', 'new-session', '-A', '-s', 'main'], ['tmux', 'new-session', '-A', '-s', 'main'],
  ]);
  assert.equal(f.container.starts, 0);
  f.server().disconnect();
});

test('browser activity cannot move hard deadline; expiration alarm destroys container and closes socket', async () => {
  const f = fixture();
  await f.connect({}, { browser: true });
  await tick();
  for (let minute = 1; minute < 60; minute += 5) {
    f.setTime(BASE + minute * 60_000);
    f.server().receive(new Uint8Array([65]).buffer);
    await tick();
  }
  const metadata = await f.storage.get('builderMachine');
  assert.equal(metadata.expiresAt, BASE + 3_600_000);
  assert.equal(metadata.idleExpiresAt, BASE + 3_600_000);
  assert.equal(f.storage.alarmAt, BASE + 3_600_000);
  f.setTime(BASE + 3_600_000);
  await f.controller.alarm();
  assert.equal(f.container.running, false);
  assert.equal(f.server().closed, true);
  assert.equal(f.server().closeCode, 1000);
  assert.equal(f.active.size, 0);
  assert.equal((await f.connect({}, { browser: true })).status, 409);
  assert.equal(f.container.starts, 0);
});

test('payment revocation closes browser and SSH sockets even when VM destruction fails', async () => {
  for (const browser of [false, true]) {
    const f = fixture();
    await f.connect({}, { browser });
    if (!browser) f.server().receive(JSON.stringify({ type: 'start' }));
    await tick();
    const socket = f.server();
    f.container.destroy = async () => { throw new Error('platform unavailable'); };
    f.setTime(BASE + 1);
    await assert.rejects(f.controller.fetch(new Request('https://internal/container', {
      method: 'DELETE', headers: { 'x-mainbrella-checked-at': String(BASE + 1) },
    })), /platform unavailable/);
    assert.equal(f.container.running, true);
    assert.equal(socket.closed, true);
    assert.equal(f.active.size, 0);
    assert.deepEqual(f.signals, [15]);
    assert.equal((await f.connect({}, { browser })).status, browser ? 409 : 403);
    assert.equal(f.calls.length, 1);
  }
});

test('open idle browser terminal does not prevent the ten-minute alarm or manual stop', async () => {
  for (const stop of ['idle', 'manual']) {
    const f = fixture();
    await f.connect({}, { browser: true });
    await tick();
    assert.equal(f.storage.alarmAt, null); // Attaching does not renew idle lease.
    if (stop === 'idle') {
      f.setTime(BASE + 600_000);
      await f.controller.alarm();
    } else {
      await f.controller.fetch(new Request('https://internal/container', { method: 'DELETE' }));
    }
    assert.equal(f.container.running, false);
    assert.equal(f.server().closed, true);
    assert.equal(f.active.size, 0);
  }
});

test('browser protocol forbids commands, alternative sessions, and malformed resize', async () => {
  for (const frame of [{ type: 'start', command: 'whoami', session: 'other' }, { cols: Infinity, rows: 24 }, { cols: 80, rows: 201 }, { type: 'signal', signal: 9 }]) {
    const f = fixture();
    await f.connect({}, { browser: true });
    await tick();
    f.server().receive(JSON.stringify(frame));
    assert.equal(f.server().closed, true);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.calls[0].argv, ['tmux', 'new-session', '-A', '-s', 'main']);
    assert.equal(f.container.running, true);
  }
});

test('terminal hard deadline closes an active browser socket even before the DO alarm runs', async () => {
  const f = fixture();
  const entries = new Map();
  let nextId = 0;
  const timers = {
    setTimeout(callback, ms) { const id = ++nextId; entries.set(id, { callback, ms }); return id; },
    clearTimeout(id) { entries.delete(id); },
  };
  await f.connect({}, { browser: true, timers });
  await tick();
  const hardDeadline = [...entries.values()].find(entry => entry.ms === 3_600_000);
  assert.ok(hardDeadline);
  hardDeadline.callback();
  assert.equal(f.server().closed, true);
  assert.equal(f.server().closeCode, 1000);
  assert.equal(f.active.size, 0);
  assert.deepEqual(f.signals, [15]);
  // Socket deadline does not replace the independent container destruction alarm.
  assert.equal(f.container.running, true);
  f.setTime(BASE + 3_600_000);
  await f.controller.alarm();
  assert.equal(f.container.running, false);
});
