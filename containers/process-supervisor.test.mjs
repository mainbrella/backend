import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { startOperationProcess, finishOperationProcess } from './process-supervisor.js';
import { UserContainerController } from './user-container-core.js';
import { hostProcessGroups } from './test-process-group.js';

const createdAt = '2026-10-05T12:00:00.000Z', now = Date.parse(createdAt), expiresAt = now + 120_000;
const empty = () => new ReadableStream({ start(c) { c.close(); } });
const options = signal => ({ stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', signal });
const start = (controller, signal, argv = ['bash', '-c', 'true'], extra = {}) => startOperationProcess(controller,
  createdAt, expiresAt, argv, { ...options(signal), ...extra }, 3000, 'runtime-a');
function fake(chunkSize = 1, pty = false) {
  const calls = [], payload = new Uint8Array([0, 255, 13, 10, 30, 31, 128]);
  const controller = {
    async startTerminalProcess(_createdAt, _expiresAt, argv, _options, fence) {
      assert.deepEqual(fence, { incarnation: 'runtime-a' });
      const header = new TextEncoder().encode(`\x1emainbrella-group:${argv[7]}:123\x1f${pty ? '\r' : ''}\n`);
      const bytes = new Uint8Array([...header, ...payload]); let offset = 0;
      return { pid: 999, isPty: pty, stdin: new WritableStream(), stderr: empty(), exitCode: new Promise(() => {}),
        stdout: new ReadableStream({ pull(c) { if (offset === bytes.length) c.close(); else { c.enqueue(bytes.subarray(offset, offset + chunkSize)); offset += Math.min(chunkSize, bytes.length - offset); } } }),
        kill() { calls.push('raw-kill'); }, resize(cols, rows) { calls.push(['resize', cols, rows]); } };
    },
    async signalOperationGroup(...args) { calls.push(args); return true; },
    async stopOperationGeneration() { throw new Error('unexpected_generation_stop'); },
  };
  return { controller, calls, payload };
}
test('guest handshake strips fragmented pipe/PTY headers and preserves all binary output', async () => {
  for (const pty of [false, true]) for (const size of [1, 7, 4096]) {
    const f = fake(size, pty), abort = new AbortController(), process = await start(f.controller, abort.signal);
    assert.equal(process.pid, 999); assert.equal(process.groupId, 123);
    assert.deepEqual(new Uint8Array(await new Response(process.stdout).arrayBuffer()), f.payload);
    if (pty) { process.resize(120, 50); assert.deepEqual(f.calls.shift(), ['resize', 120, 50]); }
    assert.equal(await process.dispose(), true);
    assert.deepEqual(f.calls, [[createdAt, 123, 9, 'runtime-a']]);
    abort.abort(); assert.equal(f.calls.length, 1);
  }
});

test('forged, oversized or missing handshake cannot expose a process or free unconfirmed capacity', async () => {
  for (const bytes of [new TextEncoder().encode('customer output\n'), new Uint8Array(129), new Uint8Array()]) {
    const f = fake(); let stopped = 0;
    f.controller.startTerminalProcess = async () => ({ stdout: new Response(bytes).body, exitCode: Promise.resolve(0), kill() {} });
    f.controller.stopOperationGeneration = async (_createdAt, incarnation) => { assert.equal(incarnation, 'runtime-a'); stopped++; return false; };
    const starting = start(f.controller, new AbortController().signal), session = { close() {} }, active = new Set([session]);
    assert.ok(starting.operationProcess);
    await assert.rejects(starting, error => error.message === 'operation_group_unavailable' && error.operationProcess === starting.operationProcess);
    assert.equal(await finishOperationProcess(f.controller, createdAt, starting.operationProcess, active, session), false);
    assert.equal(active.size, 1); assert.equal(stopped, 1);
    f.controller.stopOperationGeneration = async () => true;
    assert.equal(await session.close(), true); assert.equal(active.size, 0);
  }
});

test('cancel before native startup settles retains cleanup ownership and kills late provider handles', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fake(); let resolveStart, rawKilled = 0, finalized = 0;
  f.controller.startTerminalProcess = () => new Promise(resolve => { resolveStart = resolve; });
  f.controller.stopOperationGeneration = async () => false;
  const abort = new AbortController(), starting = start(f.controller, abort.signal);
  const session = { close() { abort.abort(); } }, active = new Set([session]);
  abort.abort();
  t.mock.timers.tick(3000);
  assert.equal(await finishOperationProcess(f.controller, createdAt, starting.operationProcess, active, session, () => { finalized++; }), false);
  assert.equal(active.size, 1); assert.equal(finalized, 0);
  // Even a provider handle returned after cancellation is never exposed.
  resolveStart({ kill() { rawKilled++; } });
  await assert.rejects(starting, error => error.message === 'operation_cancelled' && error.operationProcess === starting.operationProcess);
  assert.equal(rawKilled, 1);
  f.controller.stopOperationGeneration = async () => true;
  assert.equal(await session.close(), true);
  assert.equal(active.size, 0); assert.equal(finalized, 1);
});

test('immediate cancellation still obtains a delayed healthy guest handshake without stopping the generation', async () => {
  const f = fake(); let resolveStart;
  const launch = f.controller.startTerminalProcess.bind(f.controller);
  f.controller.startTerminalProcess = (...args) => new Promise(resolve => { resolveStart = () => resolve(launch(...args)); });
  const abort = new AbortController(), starting = start(f.controller, abort.signal);
  const rejected = assert.rejects(starting, /operation_cancelled/);
  abort.abort(); resolveStart(); await rejected;
  assert.equal(await starting.operationProcess.dispose(), true);
  assert.deepEqual(f.calls, [[createdAt, 123, 9, 'runtime-a']]);
});

test('an already-aborted operation never launches native exec', async () => {
  const f = fake(); f.controller.startTerminalProcess = () => assert.fail('native launch');
  const abort = new AbortController(); abort.abort();
  await assert.rejects(start(f.controller, abort.signal), /operation_cancelled/);
});

test('startup deadline and hung provider cleanup stay bounded while retaining occupied capacity', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fake(); let killed = 0;
  f.controller.startTerminalProcess = async () => ({ stdout: new ReadableStream(), exitCode: new Promise(() => {}), kill() { killed++; } });
  f.controller.stopOperationGeneration = () => new Promise(() => {});
  const starting = start(f.controller, new AbortController().signal);
  // Observe rejection immediately, then advance only the real supervision timers.
  const rejected = assert.rejects(starting, error => error.message === 'operation_group_unavailable' && error.operationProcess === starting.operationProcess);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(3000);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(10_000);
  await rejected;
  const session = { close() {} }, active = new Set([session]);
  assert.equal(await finishOperationProcess(f.controller, createdAt, starting.operationProcess, active, session), false);
  assert.equal(active.size, 1); assert.equal(killed, 1);
});

function fixture(t, native = false) {
  const children = [], work = [], values = new Map([
    ['builderMachine', { createdAt: now, telemetryId: 'runtime-a', expiresAt, idleExpiresAt: expiresAt, idleTimeoutMs: 600_000 }],
    ['machineEntitlement', { plan: 'builder', active: true, validUntil: expiresAt, checkedAt: now }],
  ]);
  let alarm, destroyed = 0;
  const ctx = { waitUntil(promise) { work.push(promise); }, storage: {
    async get(key) { return structuredClone(values.get(key)); }, async put(key, value) { values.set(key, structuredClone(value)); },
    async setAlarm(at) { alarm = at; }, async deleteAlarm() {}, async list({ prefix }) { return new Map([...values].filter(([key]) => key.startsWith(prefix))); },
  }, container: { running: true, async setInactivityTimeout() {}, async destroy() { destroyed++; this.running = false; },
    async exec(argv, opts) {
      assert.ok(native);
      const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', opts.stdout === 'ignore' ? 'ignore' : 'pipe', opts.stderr === 'ignore' ? 'ignore' : 'pipe'] });
      children.push(child);
      return { pid: 99999999, stdin: Writable.toWeb(child.stdin), stdout: child.stdout && Readable.toWeb(child.stdout), stderr: child.stderr && Readable.toWeb(child.stderr),
        exitCode: new Promise(resolve => child.on('close', code => resolve(code ?? 137))), kill() { child.kill('SIGKILL'); } };
    } } };
  const controller = new UserContainerController(ctx, () => now);
  t.after(async () => { for (const child of children) child.kill('SIGKILL'); await Promise.allSettled(work); });
  return { controller, values, ctx, children, get destroyed() { return destroyed; }, get alarm() { return alarm; } };
}

test('physical incarnation fences startup, group signals and generation fallback even with reused createdAt', async t => {
  const f = fixture(t), metadata = f.values.get('builderMachine');
  metadata.telemetryId = 'runtime-b';
  await assert.rejects(start(f.controller, new AbortController().signal), /Machine unavailable/);
  assert.equal(await f.controller.signalOperationGroup(createdAt, 123, 9, 'runtime-a'), false);
  assert.equal(await f.controller.stopOperationGeneration(createdAt, 'runtime-a'), true);
  assert.equal(f.destroyed, 0); assert.equal(f.children.length, 0); assert.equal(f.ctx.container.running, true);
});

test('failed generation cleanup blocks admission and activity renewal, then alarm retries promptly', async t => {
  const f = fixture(t); let attempts = 0;
  f.controller.destroy = async () => { if (++attempts === 1) throw new Error('provider_unavailable'); f.ctx.container.running = false; };
  await assert.rejects(f.controller.stopOperationGeneration(createdAt, 'runtime-a'), /provider_unavailable/);
  assert.equal(f.values.get('builderMachine').operationCleanupPending, true);
  assert.equal(f.alarm, now + 1000);
  assert.equal(await f.controller.getTerminalMetadata(createdAt, expiresAt), null);
  assert.equal(await f.controller.touchTerminalActivity(createdAt), false);
  await assert.rejects(start(f.controller, new AbortController().signal), /Machine unavailable/);
  assert.equal(f.children.length, 0);
  await f.controller.alarm(); assert.equal(attempts, 2); assert.equal(f.ctx.container.running, false);
  await f.controller.recoverOperationCleanup();
  assert.equal(f.values.get('builderMachine').operationCleanupPending, undefined);
});

test('recovery cannot clear a replacement incarnation cleanup marker', async t => {
  const f = fixture(t); f.values.get('builderMachine').operationCleanupPending = true;
  f.controller.stopOperationGeneration = async () => { f.values.get('builderMachine').telemetryId = 'runtime-b'; return true; };
  await f.controller.recoverOperationCleanup();
  assert.equal(f.values.get('builderMachine').operationCleanupPending, true);
});

const linux = { skip: process.platform !== 'linux' && 'Production group absence proof requires Linux /proc.' };
test('real cancellation during native startup obtains the guest group and preserves the next operation', linux, async t => {
  const f = fixture(t, true), abort = new AbortController();
  const nativeStart = f.controller.startTerminalProcess.bind(f.controller);
  f.controller.startTerminalProcess = async (...args) => {
    const raw = await nativeStart(...args);
    // Cancel after provider exec returns, before the supervisor reads any header.
    abort.abort(); return raw;
  };
  const starting = start(f.controller, abort.signal, ['bash', '-c', 'exec sleep 30']);
  await assert.rejects(starting, /operation_cancelled/);
  assert.equal(await starting.operationProcess.dispose(), true);
  assert.notEqual(starting.operationProcess.groupId, starting.operationProcess.pid);
  assert.equal(f.destroyed, 0); assert.equal(f.ctx.container.running, true);
  f.controller.startTerminalProcess = nativeStart;
  const next = await start(f.controller, new AbortController().signal, ['bash', '-c', 'printf still-alive']);
  assert.equal(await new Response(next.stdout).text(), 'still-alive');
  await next.exitCode; assert.equal(await next.dispose(), true); assert.equal(f.destroyed, 0);
});

test('real guest group differs from provider PID and kills descendants after a successful parent exit', linux, async t => {
  const f = fixture(t, true), handle = await start(f.controller, new AbortController().signal,
    ['bash', '-c', 'sleep 30 >/dev/null 2>&1 & printf "%s" "$!"']);
  assert.notEqual(handle.groupId, handle.pid);
  const descendant = Number(await new Response(handle.stdout).text());
  assert.ok(descendant > 1); await handle.exitCode;
  const before = await readFile(`/proc/${descendant}/stat`, 'utf8');
  assert.equal(Number(before.slice(before.lastIndexOf(')') + 2).split(' ')[2]), handle.groupId);
  assert.equal(await handle.dispose(), true); assert.equal(f.destroyed, 0);
  for (let n = 0; n < 100; n++) {
    const state = await readFile(`/proc/${descendant}/stat`, 'utf8').catch(error =>
      ['ENOENT', 'ESRCH'].includes(error.code) ? '' : Promise.reject(error));
    if (!state || state.slice(state.lastIndexOf(')') + 2).startsWith('Z ')) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('descendant survived confirmed cleanup');
});

const timeoutAvailable = spawnSync('timeout', ['--version'], { encoding: 'utf8' }).stdout?.includes('GNU');
test('real PTY handshake stays private and resize/input reach the guest terminal', { skip: !timeoutAvailable && 'Requires GNU timeout.' }, async t => {
  const f = fixture(t);
  hostProcessGroups(f.controller);
  f.ctx.container.exec = async (argv, opts) => {
    const child = spawn('python3', [new URL('./test-pty-process.py', import.meta.url).pathname, JSON.stringify(opts.pty), JSON.stringify(argv)], { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    f.children.push(child); await new Promise(resolve => child.stdio[3].once('data', resolve));
    return { pid: 99999999, isPty: true, stdout: Readable.toWeb(child.stdout),
      stdin: new WritableStream({ write(data) { child.stdin.write(JSON.stringify({ data: Buffer.from(data).toString('base64') }) + '\n'); }, close() { child.stdin.end(); } }),
      resize(cols, rows) { child.stdin.write(JSON.stringify({ cols, rows }) + '\n'); }, kill() { child.kill('SIGKILL'); },
      exitCode: new Promise(resolve => child.on('close', code => resolve(code ?? 137))) };
  };
  const handle = await start(f.controller, new AbortController().signal,
    ['bash', '-c', 'read value; stty size; printf "value:%s" "$value"'], { pty: { cols: 80, rows: 24 }, stderr: 'combined' });
  assert.notEqual(handle.groupId, handle.pid); handle.resize(111, 37);
  const writer = handle.stdin.getWriter(); await writer.write(new TextEncoder().encode('hello\n'));
  const output = await new Response(handle.stdout).text();
  assert.match(output, /37 111\r?\n/); assert.match(output, /value:hello/); assert.ok(!output.includes('mainbrella-group'));
  await handle.exitCode; assert.equal(await handle.dispose(), true);
});
