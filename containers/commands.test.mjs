import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { executeCommand } from './commands.js';
import { MAX_OUTPUT_BYTES, readCommandBody } from './command-contract.js';
import { UserContainerController } from './user-container-core.js';

const createdAt = '2026-10-05T12:00:00.000Z';
const now = Date.parse(createdAt);
const expiresAt = now + 120_000;
function request(command = 'printf hello', timeoutMs = 3000, headers = {}, signal) {
  return new Request('https://internal/exec', { method: 'POST', signal,
    headers: { 'x-exec-created-at': createdAt, 'x-exec-expires-at': String(expiresAt), ...headers },
    body: JSON.stringify({ command, timeoutMs }) });
}
function fixture() {
  const children = [];
  const calls = [];
  const values = new Map([
    ['builderMachine', { createdAt: now, expiresAt, idleExpiresAt: expiresAt, idleTimeoutMs: 600_000 }],
    ['machineEntitlement', { plan: 'builder', active: true, validUntil: expiresAt, checkedAt: now }],
  ]);
  const ctx = {
    storage: { async get(key) { return structuredClone(values.get(key)); },
      async put(key, value) { values.set(key, structuredClone(value)); }, async setAlarm() {} },
    container: {
      running: true, async setInactivityTimeout() {},
      async exec(argv, options) {
        calls.push({ argv, options });
        const child = spawn(argv[0], argv.slice(1), { stdio: 'pipe' });
        children.push(child);
        const kill = () => { child.kill('SIGKILL'); };
        options.signal?.addEventListener('abort', kill, { once: true });
        if (options.signal?.aborted) kill();
        const exitCode = new Promise(resolve => child.on('close', code => {
          options.signal?.removeEventListener('abort', kill);
          resolve(code ?? 137);
        }));
        return { pid: child.pid, stdin: Writable.toWeb(child.stdin), stdout: Readable.toWeb(child.stdout),
          stderr: Readable.toWeb(child.stderr), exitCode, kill() { kill(); } };
      },
    },
  };
  const controller = new UserContainerController(ctx, () => now);
  const active = new Set();
  const run = req => executeCommand(controller, req, active);
  return { ctx, values, calls, children, controller, active, run };
}

test('real shell stdout, stderr, nonzero exit and EOF are returned separately', async () => {
  const f = fixture();
  const response = await f.run(request('read ignored; printf "héllo"; printf problem >&2; exit 7'));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { stdout: 'héllo', stderr: 'problem', exitCode: 7, timedOut: false, outputTruncated: false });
  assert.deepEqual(f.calls[0].argv.slice(-3), ['/bin/sh', '-lc', 'read ignored; printf "héllo"; printf problem >&2; exit 7']);
  assert.equal(f.active.size, 0);
});

test('invalid/stale/stopped/expired/unpaid generations never execute', async () => {
  for (const mode of ['missing', 'stale', 'expired', 'stopped', 'unpaid']) {
    const f = fixture();
    if (mode === 'missing') f.values.delete('builderMachine');
    if (mode === 'expired') f.values.get('builderMachine').idleExpiresAt = now;
    if (mode === 'stopped') f.ctx.container.running = false;
    if (mode === 'unpaid') f.values.get('machineEntitlement').active = false;
    const response = await f.run(request('echo bad', 3000, mode === 'stale' ? { 'x-exec-created-at': '2026-10-05T13:00:00.000Z' } : {}));
    assert.equal(response.status, 409, mode);
    assert.equal(f.calls.length, 0);
  }
  assert.equal((await fixture().run(request('echo bad', 3000, { 'x-exec-created-at': '' }))).status, 403);
});

test('timeout terminates a running process and returns partial output', async () => {
  const f = fixture();
  const response = await f.run(request('printf started; exec sleep 10', 100));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null);
  assert.equal(result.outputTruncated, false);
  assert.equal(result.stdout, 'started');
  assert.equal(f.active.size, 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(f.children[0].exitCode !== null || f.children[0].signalCode !== null);
});

test('combined output limit is bounded and stops an unbounded producer', async () => {
  const f = fixture();
  const response = await f.run(request('exec yes output'));
  const result = await response.json();
  assert.equal(result.outputTruncated, true);
  assert.equal(result.exitCode, null);
  assert.equal(result.timedOut, false);
  assert.equal(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr), MAX_OUTPUT_BYTES);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(f.children[0].exitCode !== null || f.children[0].signalCode !== null);
});

test('execution capacity rejects a fifth command without launching a process', async () => {
  const f = fixture();
  const pending = Array.from({ length: 4 }, () => f.run(request('exec sleep 10', 1000)));
  while (f.active.size < 4) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.run(request())).status, 429);
  for (const session of f.active) session.close();
  const responses = await Promise.all(pending);
  assert.ok(responses.every(response => response.status === 409));
  assert.equal(f.active.size, 0);
});

test('disconnect and container stop cancel work; process startup is bounded', async () => {
  for (const mode of ['disconnect', 'stop', 'startup_timeout']) {
    const f = fixture();
    if (mode === 'startup_timeout') f.controller.startTerminalProcess = () => new Promise(() => {});
    const abort = new AbortController();
    const pending = f.run(request('exec sleep 10', mode === 'startup_timeout' ? 10 : 3000, {}, abort.signal));
    if (mode !== 'startup_timeout') {
      while (!f.calls.length) await new Promise(resolve => setImmediate(resolve));
      if (mode === 'disconnect') abort.abort();
      else for (const session of f.active) session.close();
    }
    const response = await pending;
    assert.equal(response.status, mode === 'stop' ? 409 : mode === 'disconnect' ? 503 : 200);
    if (mode === 'startup_timeout') assert.equal((await response.json()).timedOut, true);
    assert.equal(f.active.size, 0);
  }
});

test('timeout terminates shell children that remain in the operation process group', async () => {
  const f = fixture();
  const response = await f.run(request('sleep 20 & printf "%s" "$!"; wait', 60));
  const result = await response.json();
  assert.equal(result.timedOut, true);
  const pid = Number(result.stdout); assert.ok(Number.isSafeInteger(pid) && pid > 1);
  await new Promise(resolve => setTimeout(resolve, 20));
  const state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
  assert.ok(!state || state.startsWith('Z'), `Child still running: ${state}`);
  assert.equal(f.active.size, 0);
});

test('generation is checked again between inspection and process launch', async () => {
  const f = fixture();
  const original = f.controller.getTerminalMetadata.bind(f.controller);
  f.controller.getTerminalMetadata = async (...args) => {
    const metadata = await original(...args);
    f.values.get('builderMachine').createdAt += 1;
    return metadata;
  };
  const response = await f.run(request());
  assert.equal(response.status, 409);
  assert.equal(f.calls.length, 0);
});

test('oversized streamed bodies are rejected without buffering the whole request', async () => {
  const request = new Request('https://internal/exec', { method: 'POST', duplex: 'half',
    body: new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(32769)); } }) });
  await assert.rejects(readCommandBody(request), /request_too_large/);
});
