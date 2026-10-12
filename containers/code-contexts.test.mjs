import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { CodeContexts } from './code-contexts.js';
import { MAX_CODE_RESULT_BYTES, validCodeContext, validCodeExecution } from './code-contract.js';

const createdAt = '2026-10-11T00:00:00.000Z';
const expiresAt = Date.parse(createdAt) + 3600_000;
const request = (path = '', method = 'GET', body, signal, generation = createdAt) => new Request(`https://internal/code-contexts${path}`, {
  method, signal, body: body === undefined ? undefined : JSON.stringify(body),
  headers: { 'x-exec-created-at': generation, 'x-exec-expires-at': String(expiresAt) },
});
function fixture(t) {
  const active = new Set(), records = new Map(), children = [], work = [];
  const kill = child => { if (child.guestGroup) { try { process.kill(-child.pid, 9); } catch {} } child.kill('SIGKILL'); };
  records.set('builderMachine', { createdAt: Date.parse(createdAt) });
  const ctx = { waitUntil(promise) { work.push(promise); }, storage: {
    async put(key, value) { records.set(key, value); }, async get(key) { return records.get(key); },
    async delete(key) { records.delete(key); }, async list({ prefix }) { return new Map([...records].filter(([key]) => key.startsWith(prefix))); },
  } };
  const controller = { now: () => Date.parse(createdAt), serialized: fn => fn(), respond: (data, status = 200) => Response.json(data, { status }),
    container: { running: true }, async getTerminalMetadata(generation, expiry) {
      return this.container.running && generation === createdAt && expiry === expiresAt ? { expiresAt } : null;
    }, async touchTerminalActivity() { return this.container.running; },
    async destroy() { this.container.running = false; for (const child of children) kill(child); },
    async startTerminalProcess(generation, expiry, argv, options) {
      assert.equal(generation, createdAt); assert.equal(expiry, expiresAt);
      // Linux uses the real GNU-owned group when testing supervised cleanup.
      // Legacy Python-only adapters also run on macOS without GNU timeout.
      assert.equal(argv[0], 'timeout');
      const grouped = process.platform === 'linux' && typeof this.signalOperationGroup === 'function';
      const child = grouped ? spawn(argv[0], argv.slice(1)) : spawn(argv[3], argv.slice(4));
      child.guestGroup = grouped; children.push(child);
      child.stdin.on('error', () => {});
      options.signal.addEventListener('abort', () => kill(child), { once: true });
      return { stdin: Writable.toWeb(child.stdin), stdout: Readable.toWeb(child.stdout), stderr: Readable.toWeb(child.stderr),
        exitCode: new Promise(resolve => child.on('close', code => resolve(code ?? 137))), kill: () => kill(child) };
    },
  };
  const manager = new CodeContexts(controller, active, ctx);
  t.after(async () => { await Promise.all([...active].map(session => session.close())); for (const child of children) kill(child); await Promise.allSettled(work); });
  return { manager, active, records, controller, ctx };
}
async function create(f) {
  const response = await f.manager.fetch(request('', 'POST', { language: 'python' }));
  const result = await response.json();
  assert.equal(response.status, 201, JSON.stringify(result));
  return result;
}
const execute = (f, id, code, timeoutMs = 1000, signal) => f.manager.fetch(request(`/${id}/execute`, 'POST', { code, timeoutMs }, signal));

test('real Python contexts preserve variables, isolate namespaces, return rich results and survive exceptions', async t => {
  const f = fixture(t), first = await create(f), second = await create(f);
  let result = await (await execute(f, first.id, 'items = [1, 2]\nprint("héllo")\nitems')).json();
  assert.equal(result.stdout, 'héllo\n'); assert.equal(result.error, null);
  assert.deepEqual(result.results, [{ mimeType: 'text/plain', data: '[1, 2]' }, { mimeType: 'application/json', data: '[1, 2]' }]);
  result = await (await execute(f, first.id, 'items.append(3)\nitems')).json();
  assert.equal(result.results[0].data, '[1, 2, 3]');
  result = await (await execute(f, second.id, 'items')).json();
  assert.equal(result.error.name, 'NameError');
  result = await (await execute(f, first.id, 'raise ValueError("test")')).json();
  assert.equal(result.error.name, 'ValueError'); assert.match(result.error.traceback, /ValueError: test/);
  result = await (await execute(f, first.id, 'len(items)')).json(); assert.equal(result.results[0].data, '3');
  result = await (await execute(f, first.id, 'class Display:\n def _repr_html_(self): return "<b>hello</b>"\nDisplay()')).json();
  assert.deepEqual(result.results.at(-1), { mimeType: 'text/html', data: '<b>hello</b>' });
  const listed = await (await f.manager.fetch(request())).json(); assert.equal(listed.contexts.length, 2);
  assert.equal((await f.manager.fetch(request(`/${first.id}`, 'DELETE'))).status, 200);
  assert.equal((await execute(f, first.id, 'items')).status, 404); assert.equal(f.active.size, 1);
});

test('timeout destroys a namespace and overlapping requests fail without corrupting execution', async t => {
  const f = fixture(t), context = await create(f);
  const running = execute(f, context.id, 'while True: pass', 100);
  const overlapping = await execute(f, context.id, 'print("must not execute")');
  assert.equal(overlapping.status, 409); assert.deepEqual(await overlapping.json(), { error: 'code_context_busy' });
  const response = await running;
  assert.equal(response.status, 504); assert.deepEqual(await response.json(), { error: 'code_execution_timeout' });
  assert.equal(f.active.size, 0); assert.equal((await execute(f, context.id, '1')).status, 404);
});

test('bounded Unicode output, native subprocess output and protocol isolation', async t => {
  const f = fixture(t), context = await create(f);
  const result = await (await execute(f, context.id, 'print("🦄" * 100000)')).json();
  assert.equal(result.outputTruncated, true); assert.ok(Buffer.byteLength(result.stdout) <= MAX_CODE_RESULT_BYTES);
  assert.equal(result.stdout.includes('\ufffd'), false);
  const native = await (await execute(f, context.id, 'import subprocess\nsubprocess.run(["/bin/echo", "native-output"])')).json();
  assert.match(native.stderr, /native-output/);
  const next = await (await execute(f, context.id, '42')).json(); assert.equal(next.results[0].data, '42');
});

function resultBytes(result) {
  return [result.stdout, result.stderr, ...result.results.flatMap(item => [item.mimeType, item.data]),
    ...result.error ? [result.error.name, result.error.message, result.error.traceback] : []]
    .reduce((bytes, value) => bytes + Buffer.byteLength(value), 0);
}

test('Python, native output, rich results and exception strings share one UTF-8 budget', async t => {
  const f = fixture(t), context = await create(f);
  const code = 'import os, sys\nprint("🦄" * 20000, end="")\nprint("é" * 10000, end="", file=sys.stderr)\nos.write(1, ("界" * 70000).encode())\n{"value": "r" * 2000}';
  const response = await execute(f, context.id, code);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.outputTruncated, true);
  assert.ok(resultBytes(result) <= MAX_CODE_RESULT_BYTES);
  assert.ok(resultBytes(result) >= MAX_CODE_RESULT_BYTES - 3);
  assert.equal(result.stderr.includes('\ufffd'), false);
  assert.match(result.stderr, /界/);
  assert.equal(JSON.parse(result.results.find(item => item.mimeType === 'application/json').data).value.length, 2000);
  const error = await (await execute(f, context.id, 'print("x" * 100000, end="")\nos.write(2, b"n" * 200000)\nraise ValueError("m" * 100000)')).json();
  assert.equal(error.outputTruncated, true);
  assert.equal(error.error.name, 'ValueError');
  assert.ok(resultBytes(error) <= MAX_CODE_RESULT_BYTES);
  assert.equal((await (await execute(f, context.id, '42')).json()).results[0].data, '42');
});

test('guest-forged results cannot add fields or bypass the public output budget', async t => {
  const f = fixture(t), context = await create(f);
  const code = String.raw`import __main__, json, os
request_id = __main__.request['requestId']
message = {'requestId': request_id, 'stdout': 'x' * 100000, 'stderr': '',
 'results': [{'mimeType': 'text/plain', 'data': 'y' * 200000, 'hidden': 'drop'}],
 'error': {'name': 'GuestError', 'message': 'message', 'traceback': 'trace', 'hidden': 'drop'},
 'outputTruncated': False, 'hidden': 'z' * 10000}
os.write(2, ('\x1e' + request_id + '\x1f').encode())
__main__.protocol.write(json.dumps(message) + '\n')
while True: pass`;
  const response = await execute(f, context.id, code);
  assert.equal(response.status, 200);
  const wire = await response.text(), result = JSON.parse(wire);
  assert.deepEqual(Object.keys(result).sort(), ['error', 'outputTruncated', 'results', 'stderr', 'stdout']);
  assert.deepEqual(Object.keys(result.results[0]).sort(), ['data', 'mimeType']);
  assert.deepEqual(Object.keys(result.error).sort(), ['message', 'name', 'traceback']);
  assert.equal(result.outputTruncated, true);
  assert.ok(resultBytes(result) <= MAX_CODE_RESULT_BYTES);
  assert.ok(Buffer.byteLength(wire) <= 2 * 1024 * 1024);
  assert.equal((await f.manager.fetch(request(`/${context.id}`, 'DELETE'))).status, 200);
});

test('shared capacity, exact generation and lifecycle closure are enforced', async t => {
  const f = fixture(t), context = await create(f);
  for (let i = 0; i < 3; i++) f.active.add({ close() {} });
  assert.equal((await f.manager.fetch(request('', 'POST', { language: 'python' }))).status, 429);
  assert.equal((await f.manager.fetch(request(`/${context.id}/execute`, 'POST', { code: '1' }, undefined, '2026-10-12T00:00:00.000Z'))).status, 404);
  assert.equal((await f.manager.fetch(request('', 'POST', { language: 'python' }, undefined, '2026-10-12T00:00:00.000Z'))).status, 409);
  f.controller.container.running = false;
  assert.equal((await execute(f, context.id, '1')).status, 409);
});

test('disconnect cancels a running context and recovery never replays Python', async t => {
  const f = fixture(t), context = await create(f), abort = new AbortController();
  const running = execute(f, context.id, 'while True: pass', 2000, abort.signal);
  abort.abort();
  assert.equal((await running).status, 409); assert.equal(f.active.size, 0);
  f.records.set('code-context:orphan', { createdAt, groupId: 123, incarnation: 'runtime-a' });
  f.records.get('builderMachine').telemetryId = 'runtime-a';
  let signaled;
  f.controller.signalOperationGroup = async (...args) => { signaled = args; return true; };
  await new CodeContexts(f.controller, f.active, f.ctx).recover();
  assert.deepEqual(signaled, [createdAt, 123, 9, 'runtime-a']); assert.equal(f.records.has('code-context:orphan'), false);
  assert.equal((await f.manager.fetch(request())).status, 200);
});

test('contracts reject unsupported languages, oversized code and unknown options', () => {
  assert.equal(validCodeContext({ language: 'javascript' }), false);
  assert.equal(validCodeExecution({ code: '🦄'.repeat(5000) }), false);
  assert.equal(validCodeExecution({ code: '1', timeoutMs: 60001 }), false);
  assert.equal(validCodeExecution({ code: '1', shell: true }), false);
  assert.equal(validCodeExecution({ code: '1', timeoutMs: 60000 }), true);
});

test('context recovery fences physical incarnations and distrusts legacy guest IDs without an incarnation', async t => {
  const f = fixture(t); f.records.get('builderMachine').telemetryId = 'runtime-b';
  f.controller.signalOperationGroup = async () => assert.fail('must not signal untrusted or obsolete group');
  f.records.set('code-context:old', { createdAt, groupId: 123, incarnation: 'runtime-a' });
  await f.manager.recover(); assert.equal(f.controller.container.running, true);
  f.records.set('code-context:legacy', { createdAt, groupId: 123 });
  await f.manager.recover(); assert.equal(f.controller.container.running, false);
  assert.equal(f.records.has('code-context:legacy'), false);
});

test('a hung final generation fallback retains context evidence and capacity, and deletion remains retryable', async t => {
  const f = fixture(t); t.mock.timers.enable({ apis: ['setTimeout'] });
  f.controller.stopOperationGeneration = (_createdAt, incarnation) => { assert.equal(incarnation, 'runtime-a'); return new Promise(() => {}); };
  const session = { id: crypto.randomUUID(), createdAt, incarnation: 'runtime-a', abort: new AbortController(),
    process: { kill() {}, async dispose() { return false; } }, close() {} };
  f.active.add(session); f.manager.contexts.set(session.id, session);
  f.records.set('code-context:' + session.id, { createdAt, incarnation: 'runtime-a' });
  const closing = assert.rejects(f.manager.close(session), /code_cleanup_unconfirmed/);
  await new Promise(resolve => setImmediate(resolve)); t.mock.timers.tick(10_000); await closing;
  assert.equal(f.active.size, 1); assert.equal(f.records.has('code-context:' + session.id), true);
  assert.equal(f.manager.contexts.has(session.id), true); assert.equal(session.cleanup, undefined);
  f.controller.stopOperationGeneration = async () => true;
  await f.manager.close(session);
  assert.equal(f.active.size, 0); assert.equal(f.records.has('code-context:' + session.id), false);
});

test('unconfirmed process cleanup destroys the generation before releasing admission capacity', async t => {
  const f = fixture(t);
  const start = f.controller.startTerminalProcess.bind(f.controller);
  f.controller.startTerminalProcess = async (...args) => ({ ...await start(...args), pid: 123 });
  f.controller.signalOperationGroup = async () => false;
  const context = await create(f);
  assert.equal((await f.manager.fetch(request(`/${context.id}`, 'DELETE'))).status, 200);
  assert.equal(f.controller.container.running, false);
  assert.equal(f.active.size, 0);
  assert.equal(f.records.has('code-context:' + context.id), false);
});

test('failed generation cleanup retains occupied capacity and recovery evidence', async t => {
  const f = fixture(t);
  const start = f.controller.startTerminalProcess.bind(f.controller);
  f.controller.startTerminalProcess = async (...args) => ({ ...await start(...args), pid: 123 });
  f.controller.signalOperationGroup = async () => false;
  f.controller.destroy = async () => { throw new Error('provider_unavailable'); };
  const context = await create(f);
  await assert.rejects(f.manager.fetch(request(`/${context.id}`, 'DELETE')), /provider_unavailable/);
  assert.equal(f.active.size, 1);
  assert.equal(f.records.has('code-context:' + context.id), true);
});

test('failed context deletion remains addressable, blocks execution and retries confirmed cleanup', async t => {
  const f = fixture(t);
  const start = f.controller.startTerminalProcess.bind(f.controller);
  const destroy = f.controller.destroy.bind(f.controller);
  f.controller.startTerminalProcess = async (...args) => ({ ...await start(...args), pid: 123 });
  f.controller.signalOperationGroup = async () => false;
  let attempts = 0;
  f.controller.destroy = async () => {
    if (++attempts === 1) throw new Error('provider_unavailable');
    await destroy();
  };
  const context = await create(f);
  await assert.rejects(f.manager.fetch(request(`/${context.id}`, 'DELETE')), /provider_unavailable/);
  assert.equal(f.manager.contexts.has(context.id), true);
  assert.equal(f.active.size, 1);
  assert.equal(f.records.has('code-context:' + context.id), true);
  const blocked = await execute(f, context.id, 'print("must not execute")');
  assert.equal(blocked.status, 409);
  assert.deepEqual(await blocked.json(), { error: 'code_context_closed' });
  assert.deepEqual(await (await f.manager.fetch(request())).json(), { contexts: [] });
  const retried = await f.manager.fetch(request(`/${context.id}`, 'DELETE'));
  assert.equal(retried.status, 200);
  assert.deepEqual(await retried.json(), { closed: true });
  assert.equal(attempts, 2);
  assert.equal(f.controller.container.running, false);
  assert.equal(f.manager.contexts.has(context.id), false);
  assert.equal(f.active.size, 0);
  assert.equal(f.records.has('code-context:' + context.id), false);
  assert.equal((await f.manager.fetch(request(`/${context.id}`, 'DELETE'))).status, 404);
});

test('concurrent deletes await one cleanup attempt and keep the context until it finishes', async t => {
  const f = fixture(t), context = await create(f);
  const session = f.manager.contexts.get(context.id);
  const dispose = session.process.dispose.bind(session.process);
  let release, entered;
  const barrier = new Promise(resolve => { release = resolve; });
  const reached = new Promise(resolve => { entered = resolve; });
  let disposals = 0;
  session.process.dispose = async () => { disposals++; entered(); await barrier; return dispose(); };
  const first = f.manager.fetch(request(`/${context.id}`, 'DELETE'));
  await reached;
  let secondSettled = false;
  const second = f.manager.fetch(request(`/${context.id}`, 'DELETE')).finally(() => { secondSettled = true; });
  await Promise.resolve();
  assert.equal(secondSettled, false);
  assert.equal(f.manager.contexts.has(context.id), true);
  assert.equal(f.active.size, 1);
  assert.equal(f.records.has('code-context:' + context.id), true);
  assert.equal(disposals, 1);
  release();
  const responses = await Promise.all([first, second]);
  assert.deepEqual(responses.map(response => response.status), [200, 200]);
  assert.equal(disposals, 1);
  assert.equal(f.manager.contexts.has(context.id), false);
  assert.equal(f.active.size, 0);
});

test('storage cleanup failure retains a retryable context without freeing capacity', async t => {
  const f = fixture(t), context = await create(f);
  const remove = f.ctx.storage.delete.bind(f.ctx.storage);
  let attempts = 0;
  f.ctx.storage.delete = async key => {
    if (key === 'code-context:' + context.id && ++attempts === 1) throw new Error('storage_unavailable');
    return remove(key);
  };
  await assert.rejects(f.manager.fetch(request(`/${context.id}`, 'DELETE')), /storage_unavailable/);
  assert.equal(f.manager.contexts.has(context.id), true);
  assert.equal(f.records.has('code-context:' + context.id), true);
  assert.equal(f.active.size, 1);
  assert.equal((await f.manager.fetch(request(`/${context.id}`, 'DELETE'))).status, 200);
  assert.equal(f.manager.contexts.has(context.id), false);
  assert.equal(f.records.has('code-context:' + context.id), false);
  assert.equal(f.active.size, 0);
});

test('late failed process cleanup cannot stop a replacement generation', async t => {
  const f = fixture(t);
  const start = f.controller.startTerminalProcess.bind(f.controller);
  f.controller.startTerminalProcess = async (...args) => ({ ...await start(...args), pid: 123 });
  f.controller.signalOperationGroup = async () => {
    f.records.set('builderMachine', { createdAt: Date.parse(createdAt) + 1 });
    return false;
  };
  const context = await create(f);
  assert.equal((await f.manager.fetch(request(`/${context.id}`, 'DELETE'))).status, 200);
  assert.equal(f.controller.container.running, true);
  assert.equal(f.active.size, 0);
});
