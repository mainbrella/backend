import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { ManagedExecutions } from './executions.js';
import { UserContainerController } from './user-container-core.js';
import { MAX_OUTPUT_BYTES } from './command-contract.js';
import { MAX_RETAINED_EXECUTIONS, MAX_STDIN_CHUNK_BYTES, MAX_STDIN_BYTES, MAX_PENDING_STDIN_BYTES, validExecution } from './execution-contract.js';

const createdAt = '2026-10-05T12:00:00.000Z';
const now = Date.parse(createdAt);
const expiresAt = now + 120_000;
function request(path = '', method = 'GET', body, key = 'one', generation = createdAt, signal) {
  return new Request(`https://internal/executions${path}`, { method, body: body ? JSON.stringify(body) : undefined, signal,
    headers: { 'x-exec-created-at': generation, 'x-exec-expires-at': String(expiresAt), 'Idempotency-Key': key } });
}
function fixture(t) {
  const children = [], work = [], values = new Map([
    ['builderMachine', { createdAt: now, expiresAt, idleExpiresAt: expiresAt, idleTimeoutMs: 600_000 }],
    ['machineEntitlement', { plan: 'builder', active: true, validUntil: expiresAt, checkedAt: now }],
  ]);
  let killsAfterExit = 0, time = now, alarm = null;
  const ctx = {
    waitUntil(promise) { work.push(promise); },
    storage: { async get(key) { return structuredClone(values.get(key)); }, async put(key, value) {
      if (typeof key === 'object') { for (const [k, v] of Object.entries(key)) values.set(k, structuredClone(v)); }
      else values.set(key, structuredClone(value));
    }, async delete(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key); },
    async list({ prefix, startAfter, limit }) { return new Map([...values].filter(([key]) => key.startsWith(prefix) && (!startAfter || key > startAfter)).sort().slice(0, limit).map(([k,v]) => [k, structuredClone(v)])); },
    async setAlarm(at) { alarm = at; }, async deleteAlarm() { alarm = null; } },
    container: { running: true, async setInactivityTimeout() {}, async destroy() { this.running = false; for (const child of children) child.kill('SIGKILL'); },
      async exec(argv, options) {
        if (options.pty) {
          const child = spawn('python3', [new URL('./test-pty-process.py', import.meta.url).pathname,
            JSON.stringify(options.pty), JSON.stringify(argv)], { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] }); children.push(child);
          const pid = await new Promise(resolve => child.stdio[3].once('data', data => resolve(Number(data.toString().trim()))));
          const stdin = new WritableStream({ write(data) { return new Promise((resolve, reject) => child.stdin.write(JSON.stringify({ data: Buffer.from(data).toString('base64') }) + '\n', error => error ? reject(error) : resolve())); },
            close() { child.stdin.end(); }, abort() { child.stdin.end(); } });
          const exitCode = new Promise(resolve => child.on('close', code => resolve(code ?? 137)));
          return { pid, isPty: true, stdin, stdout: Readable.toWeb(child.stdout), stderr: undefined, exitCode,
            resize(cols, rows) { child.stdin.write(JSON.stringify({ cols, rows }) + '\n'); }, kill() { child.kill('SIGKILL'); } };
        }
        const child = spawn(argv[0], argv.slice(1), { stdio: 'pipe', cwd: options.cwd, env: { ...process.env, ...options.env } }); children.push(child);
        let exited = false;
        const kill = () => { if (exited) killsAfterExit++; else child.kill('SIGKILL'); };
        options.signal?.addEventListener('abort', kill, { once: true });
        const exitCode = new Promise(resolve => child.on('close', code => { exited = true; resolve(code ?? 137); }));
        return { pid: child.pid, stdin: Writable.toWeb(child.stdin), stdout: Readable.toWeb(child.stdout), stderr: Readable.toWeb(child.stderr), exitCode, kill };
      } },
  };
  const controller = new UserContainerController(ctx, () => time);
  const active = new Set();
  const manager = new ManagedExecutions(controller, active, ctx);
  t.after(async () => { for (const session of active) session.close(); for (const child of children) child.kill('SIGKILL'); await Promise.all(work); });
  return { ctx, values, children, active, manager, work, setTime(at) { time = at; },
    get alarm() { return alarm; }, get killsAfterExit() { return killsAfterExit; } };
}

test('managed creation is idempotent across concurrent retries and returns real retained output', async t => {
  const f = fixture(t);
  const start = () => f.manager.fetch(request('', 'POST', { command: 'printf "héllo"; printf problem >&2; exit 7' }));
  const responses = await Promise.all([start(), start(), start()]);
  const records = await Promise.all(responses.map(r => r.json()));
  assert.equal(new Set(records.map(r => r.id)).size, 1);
  await Promise.all(f.work);
  const response = await f.manager.fetch(request(`/${records[0].id}`));
  const result = await response.json();
  assert.equal(result.status, 'failed'); assert.equal(result.exitCode, 7);
  assert.equal(result.stdout, 'héllo'); assert.equal(result.stderr, 'problem');
  assert.equal(f.children.length, 1); assert.equal(f.killsAfterExit, 0); assert.equal(f.active.size, 0);
  assert.ok(!('key' in result)); assert.ok(!('fingerprint' in result));
  assert.equal((await f.manager.fetch(request('', 'POST', { command: 'changed' }))).status, 409);
});

test('disconnect detaches, SSE replays by cursor, and cancellation is generation-bound', async t => {
  const f = fixture(t), abort = new AbortController();
  const record = await (await f.manager.fetch(request('', 'POST', { command: 'printf first; exec sleep 10' }, 'detach', createdAt, abort.signal))).json();
  abort.abort();
  const stream = await f.manager.fetch(request(`/${record.id}/events?cursor=0`));
  const reader = stream.body.getReader();
  let output = '';
  while (!output.includes('first')) output += new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  assert.equal(f.active.size, 1); assert.equal(f.manager.streams, 0);
  assert.equal((await f.manager.fetch(request(`/${record.id}`, 'DELETE', undefined, '', '2099-01-01T00:00:00.000Z'))).status, 404);
  assert.equal((await f.manager.fetch(request(`/${record.id}`, 'DELETE'))).status, 202);
  await Promise.all(f.work);
  const result = await (await f.manager.fetch(request(`/${record.id}`))).json();
  assert.equal(result.status, 'canceled');
  const replay = await (await f.manager.fetch(request(`/${record.id}/events?cursor=0`))).text();
  assert.match(replay, /event: stdout/); assert.match(replay, /event: status/);
  const after = await (await f.manager.fetch(request(`/${record.id}/events?cursor=${result.cursor}`))).text();
  assert.ok(!after.includes('event: stdout'));
  assert.equal((await f.manager.fetch(request(`/${record.id}/events?cursor=${result.cursor + 1}`))).status, 400);
});

test('timeouts, output bounds, shared capacity and stale generations do not leak processes', async t => {
  const f = fixture(t);
  const timeout = await (await f.manager.fetch(request('', 'POST', { command: 'exec sleep 10', timeoutMs: 20 }, 'timeout'))).json();
  await Promise.all(f.work);
  assert.equal((await (await f.manager.fetch(request(`/${timeout.id}`))).json()).status, 'timed_out');
  const noisy = await (await f.manager.fetch(request('', 'POST', { command: 'yes x', timeoutMs: 3000 }, 'noisy'))).json();
  await Promise.all(f.work);
  const result = await (await f.manager.fetch(request(`/${noisy.id}`))).json();
  assert.equal(result.status, 'output_limit'); assert.ok(result.outputBytes <= MAX_OUTPUT_BYTES);
  for (let i = 0; i < 4; i++) f.active.add({ close() {} });
  assert.equal((await f.manager.fetch(request('', 'POST', { command: 'echo nope' }, 'full'))).status, 429);
  f.active.clear();
  assert.equal((await f.manager.fetch(request('', 'POST', { command: 'echo nope' }, 'stale', '2099-01-01T00:00:00.000Z'))).status, 409);
});

test('managed cancellation terminates ordinary child processes without signaling a replacement generation', async t => {
  const f = fixture(t);
  const record = await (await f.manager.fetch(request('', 'POST', { command: 'sleep 20 & printf "%s" "$!"; wait' }, 'children'))).json();
  let pid;
  for (let n = 0; n < 100; n++) {
    const current = await (await f.manager.fetch(request(`/${record.id}`))).json();
    if (current.stdout) { pid = Number(current.stdout); break; }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  await f.manager.fetch(request(`/${record.id}`, 'DELETE'));
  await Promise.all(f.work);
  await new Promise(resolve => setTimeout(resolve, 20));
  const state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
  assert.ok(!state || state.startsWith('Z'), `Child still running: ${state}`);
  const before = f.children.length;
  f.values.get('builderMachine').createdAt += 1;
  assert.equal(await f.manager.controller.signalOperationGroup(createdAt, f.children[0].pid, 9), false);
  assert.equal(f.children.length, before);
  assert.equal(f.killsAfterExit, 0);
});

async function running(f, id) {
  for (let n = 0; n < 100; n++) {
    const record = await (await f.manager.fetch(request(`/${id}`))).json();
    if (record.status === 'running') return record;
    if (record.status !== 'starting') throw new Error(`Unexpected terminal state: ${record.status}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Job did not become ready');
}

function inputRequest(id, bytes, generation = createdAt) {
  return new Request(`https://internal/executions/${id}/stdin`, { method: 'POST', body: bytes,
    headers: { 'x-exec-created-at': generation, 'x-exec-expires-at': String(expiresAt) } });
}

test('managed stdin preserves binary chunks, ordered writes and EOF without retaining input payloads', async t => {
  const f = fixture(t);
  const record = await (await f.manager.fetch(request('', 'POST', { argv: ['/bin/cat'], stdin: true }, 'input'))).json();
  await running(f, record.id);
  const chunks = [new TextEncoder().encode('héllo '), new TextEncoder().encode('界\0done')];
  const responses = await Promise.all(chunks.map(bytes => f.manager.fetch(inputRequest(record.id, bytes))));
  for (let i = 0; i < responses.length; i++) assert.deepEqual(await responses[i].json(), { bytes: chunks[i].byteLength, stdinClosed: false });
  const closed = await f.manager.fetch(request(`/${record.id}/stdin`, 'DELETE'));
  assert.equal(closed.status, 200); assert.equal((await closed.json()).stdinClosed, true);
  await Promise.all(f.work);
  const result = await (await f.manager.fetch(request(`/${record.id}`))).json();
  assert.equal(result.status, 'succeeded'); assert.equal(result.stdout, 'héllo 界\0done');
  assert.equal(result.stdinBytes, chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  assert.equal(result.stdinClosed, true); assert.equal(f.active.size, 0); assert.equal(f.killsAfterExit, 0);
  assert.ok(!('argv' in result)); assert.ok(!('stdinData' in result));
  assert.equal((await f.manager.fetch(inputRequest(record.id, chunks[0]))).status, 409);
});

test('managed stdin limits, closed/default input and foreign generations do not reach an input pipe', async t => {
  const f = fixture(t);
  const record = await (await f.manager.fetch(request('', 'POST', { argv: ['/bin/cat'], stdin: true }, 'limits'))).json();
  await running(f, record.id);
  assert.equal((await f.manager.fetch(inputRequest(record.id, new Uint8Array(MAX_STDIN_CHUNK_BYTES + 1)))).status, 413);
  assert.equal((await f.manager.fetch(inputRequest(record.id, new Uint8Array([1]), '2099-01-01T00:00:00.000Z'))).status, 404);
  const session = f.manager.sessions.get(record.id);
  session.record.stdinBytes = MAX_STDIN_BYTES;
  assert.equal((await f.manager.fetch(inputRequest(record.id, new Uint8Array([1])))).status, 429);
  session.record.stdinBytes = 0; session.pendingInputBytes = MAX_PENDING_STDIN_BYTES;
  assert.equal((await f.manager.fetch(inputRequest(record.id, new Uint8Array([1])))).status, 429);
  session.pendingInputBytes = 0;
  f.values.get('builderMachine').createdAt += 1;
  assert.equal((await f.manager.fetch(inputRequest(record.id, new Uint8Array([1])))).status, 409);
  f.values.get('builderMachine').createdAt -= 1;
  await f.manager.fetch(request(`/${record.id}`, 'DELETE')); await Promise.all(f.work);
  const noInput = await (await f.manager.fetch(request('', 'POST', { command: 'exec sleep 5' }, 'no-input'))).json();
  await running(f, noInput.id);
  const response = await f.manager.fetch(inputRequest(noInput.id, new Uint8Array([1])));
  assert.deepEqual(await response.json(), { error: 'stdin_closed' });
  await f.manager.fetch(request(`/${noInput.id}`, 'DELETE')); await Promise.all(f.work);
});

test('direct argv, cwd and env participate in stable idempotency without exposing their values', async t => {
  const f = fixture(t);
  const options = { argv: ['/bin/sh', '-c', 'printf "%s|%s" "$MAINBRELLA_TEST_VALUE" "$1"', 'literal', '$(touch SHOULD_NOT_EXIST)'],
    cwd: '/tmp', env: { MAINBRELLA_TEST_VALUE: 'private-value', MAINBRELLA_TEST_OTHER: 'other' } };
  const first = await (await f.manager.fetch(request('', 'POST', options, 'argv'))).json();
  const reordered = await (await f.manager.fetch(request('', 'POST', { ...options, env: { MAINBRELLA_TEST_OTHER: 'other', MAINBRELLA_TEST_VALUE: 'private-value' } }, 'argv'))).json();
  assert.equal(first.id, reordered.id);
  assert.equal((await f.manager.fetch(request('', 'POST', { ...options, stdin: true }, 'argv'))).status, 409);
  assert.equal((await f.manager.fetch(request('', 'POST', { ...options, cwd: '/' }, 'argv'))).status, 409);
  await Promise.all(f.work);
  const result = await (await f.manager.fetch(request(`/${first.id}`))).json();
  assert.equal(result.stdout, 'private-value|$(touch SHOULD_NOT_EXIST)');
  assert.ok(!('env' in first)); assert.ok(!('argv' in first));
  for (const invalid of [{ argv: [] }, { argv: [''] }, { command: 'x', argv: ['x'] }, { argv: [true] }, { command: 'x', stdin: 'true' },
    { command: 'x', cwd: '/tmp/../' }, { command: 'x', env: { 'bad=name': 'x' } }, { command: 'x', env: { OK: 1 } }]) assert.equal(Boolean(validExecution(invalid)), false);
});

test('managed listing excludes other/expired generations and signals bind only live execution identities', async t => {
  const f = fixture(t);
  const record = await (await f.manager.fetch(request('', 'POST', { command: 'exec sleep 5' }, 'signals'))).json();
  await running(f, record.id);
  const foreign = crypto.randomUUID(), expired = crypto.randomUUID();
  f.values.set('execution-record:' + foreign, { id: foreign, createdAt: '2099-01-01T00:00:00.000Z', status: 'running', retainUntil: now + 1000 });
  f.values.set('execution-record:' + expired, { id: expired, createdAt, status: 'succeeded', retainUntil: now });
  const listed = await (await f.manager.fetch(request())).json();
  assert.deepEqual(listed.executions.map(item => item.id), [record.id]);
  assert.equal((await f.manager.fetch(request(`/${record.id}/signal`, 'POST', { signal: 'SIGSTOP' }))).status, 400);
  assert.equal((await f.manager.fetch(request(`/${record.id}/signal`, 'POST', { signal: 'SIGKILL', pid: 1 }))).status, 400);
  const count = f.children.length;
  f.values.get('builderMachine').createdAt += 1;
  assert.equal((await f.manager.fetch(request(`/${record.id}/signal`, 'POST', { signal: 'SIGTERM' }))).status, 409);
  assert.equal(f.children.length, count);
  f.values.get('builderMachine').createdAt -= 1;
  assert.equal((await f.manager.fetch(request(`/${record.id}/signal`, 'POST', { signal: 'SIGTERM' }))).status, 202);
  await Promise.all(f.work);
  assert.equal((await f.manager.fetch(request(`/${record.id}/signal`, 'POST', { signal: 'SIGKILL' }))).status, 409);
  assert.equal(f.killsAfterExit, 0);
});

test('restart recovery interrupts only matching generations and retained keys remain fenced', async t => {
  const f = fixture(t);
  const id = crypto.randomUUID();
  f.values.set('execution-record:' + id, { id, createdAt, status: 'running', cursor: 0, retainUntil: now + 3600_000 });
  await f.manager.recover();
  assert.equal(f.ctx.container.running, false);
  assert.equal(f.values.get('execution-record:' + id).status, 'interrupted');
  f.ctx.container.running = true;
  f.values.set('execution-record:' + id, { id, createdAt: '2099-01-01T00:00:00.000Z', status: 'running', cursor: 0, retainUntil: now + 3600_000 });
  await f.manager.recover();
  assert.equal(f.ctx.container.running, true);
  f.values.delete('execution-record:' + id);
  for (let n = 0; n < MAX_RETAINED_EXECUTIONS; n++) f.values.set('execution-record:' + n, { id: String(n), key: String(n), createdAt, status: 'succeeded', retainUntil: now + 3600_000 });
  const denied = await f.manager.fetch(request('', 'POST', { command: 'echo x' }, 'new'));
  assert.equal(denied.status, 429);
});

test('stopping the VM preserves retained-output cleanup and maintenance erases expired output', async t => {
  const f = fixture(t), id = crypto.randomUUID(), retainUntil = now + 3600_000;
  f.values.set('execution-record:' + id, { id, createdAt, status: 'succeeded', cursor: 1, retainUntil });
  const eventKey = `execution-event:${id}:00000001`;
  f.values.set(eventKey, { sequence: 1, type: 'stdout', data: 'private output' });
  const stop = new Request('https://internal/container', { method: 'DELETE' });
  assert.equal((await f.manager.lifecycleFetch(stop)).status, 200);
  assert.equal(f.ctx.container.running, false);
  assert.equal(f.alarm, retainUntil);
  f.setTime(retainUntil);
  assert.equal((await f.manager.fetch(request(`/${id}`))).status, 404);
  await f.manager.prune();
  assert.equal(f.values.has('execution-record:' + id), false);
  assert.equal(f.values.has(eventKey), false);
});

test('restart cleans already expired interrupted records and schedules remaining history', async t => {
  const f = fixture(t), expired = crypto.randomUUID(), retained = crypto.randomUUID();
  f.values.set('execution-record:' + expired, { id: expired, createdAt, status: 'running', cursor: 0, retainUntil: now });
  f.values.set('execution-record:' + retained, { id: retained, createdAt, status: 'succeeded', cursor: 0, retainUntil: now + 3600_000 });
  await f.manager.recover();
  assert.equal(f.values.has('execution-record:' + expired), false);
  assert.equal(f.ctx.container.running, false);
  assert.equal(f.alarm, now + 3600_000);
});

test('managed PTY uses a real terminal, combines streams, resizes and survives stream detachment', async t => {
  const f = fixture(t);
  const body = { argv: ['/bin/sh', '-c', 'test -t 0 && test -t 1; stty size; printf error >&2; read value; stty size; printf "done:%s" "$value"'],
    stdin: true, pty: { cols: 80, rows: 24 } };
  const record = await (await f.manager.fetch(request('', 'POST', body, 'pty'))).json();
  await running(f, record.id);
  const stream = await f.manager.fetch(request(`/${record.id}/events`));
  const reader = stream.body.getReader(); let output = '';
  while (!output.includes('error')) output += new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  assert.equal(f.active.size, 1);
  assert.equal((await f.manager.fetch(request(`/${record.id}/resize`, 'POST', { cols: 132, rows: 40 }))).status, 200);
  assert.equal((await f.manager.fetch(request(`/${record.id}/resize`, 'POST', { cols: 0, rows: 40 }))).status, 400);
  f.values.get('builderMachine').createdAt += 1;
  assert.equal((await f.manager.fetch(request(`/${record.id}/resize`, 'POST', { cols: 99, rows: 30 }))).status, 409);
  f.values.get('builderMachine').createdAt -= 1;
  await f.manager.fetch(inputRequest(record.id, new TextEncoder().encode('hello\n')));
  await Promise.all(f.work);
  const result = await (await f.manager.fetch(request(`/${record.id}`))).json();
  assert.equal(result.status, 'succeeded'); assert.equal(result.stderr, '');
  assert.match(result.stdout, /24 80\r\n/); assert.match(result.stdout, /40 132\r\n/); assert.match(result.stdout, /done:hello/);
  assert.deepEqual(result.pty, { cols: 132, rows: 40 });
  assert.equal((await f.manager.fetch(request('', 'POST', body, 'pty'))).status, 202);
  assert.equal((await f.manager.fetch(request('', 'POST', { ...body, pty: { cols: 81, rows: 24 } }, 'pty'))).status, 409);
  assert.equal((await f.manager.fetch(request(`/${record.id}/resize`, 'POST', { cols: 80, rows: 24 }))).status, 409);
  for (const pty of [true, { cols: 80 }, { cols: 1001, rows: 24 }, { cols: 80, rows: 24, extra: 1 }]) assert.equal(Boolean(validExecution({ command: 'x', stdin: true, pty })), false);
  assert.equal(Boolean(validExecution({ command: 'x', pty: { cols: 80, rows: 24 } })), false);
});

test('managed PTY cancellation terminates its group and replacement resize cannot target a plain job', async t => {
  const f = fixture(t);
  const record = await (await f.manager.fetch(request('', 'POST', { command: 'exec sleep 10', stdin: true, pty: { cols: 80, rows: 24 } }, 'pty-cancel'))).json();
  await running(f, record.id);
  await f.manager.fetch(request(`/${record.id}`, 'DELETE'));
  await Promise.all(f.work);
  assert.equal((await (await f.manager.fetch(request(`/${record.id}`))).json()).status, 'canceled');
  assert.equal(f.active.size, 0);
});
