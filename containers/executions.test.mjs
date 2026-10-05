import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { ManagedExecutions } from './executions.js';
import { UserContainerController } from './user-container-core.js';
import { MAX_OUTPUT_BYTES } from './command-contract.js';
import { MAX_RETAINED_EXECUTIONS } from './execution-contract.js';

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
  let killsAfterExit = 0;
  const ctx = {
    waitUntil(promise) { work.push(promise); },
    storage: { async get(key) { return structuredClone(values.get(key)); }, async put(key, value) {
      if (typeof key === 'object') { for (const [k, v] of Object.entries(key)) values.set(k, structuredClone(v)); }
      else values.set(key, structuredClone(value));
    }, async delete(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key); },
    async list({ prefix, startAfter, limit }) { return new Map([...values].filter(([key]) => key.startsWith(prefix) && (!startAfter || key > startAfter)).sort().slice(0, limit).map(([k,v]) => [k, structuredClone(v)])); },
    async setAlarm() {} },
    container: { running: true, async setInactivityTimeout() {}, async destroy() { this.running = false; for (const child of children) child.kill('SIGKILL'); },
      async exec(argv, options) {
        const child = spawn(argv[0], argv.slice(1), { stdio: 'pipe' }); children.push(child);
        let exited = false;
        const kill = () => { if (exited) killsAfterExit++; else child.kill('SIGKILL'); };
        options.signal.addEventListener('abort', kill, { once: true });
        const exitCode = new Promise(resolve => child.on('close', code => { exited = true; resolve(code ?? 137); }));
        return { stdin: Writable.toWeb(child.stdin), stdout: Readable.toWeb(child.stdout), stderr: Readable.toWeb(child.stderr), exitCode, kill };
      } },
  };
  const controller = new UserContainerController(ctx, () => now);
  const active = new Set();
  const manager = new ManagedExecutions(controller, active, ctx);
  t.after(async () => { for (const session of active) session.close(); for (const child of children) child.kill('SIGKILL'); await Promise.all(work); });
  return { ctx, values, children, active, manager, work, get killsAfterExit() { return killsAfterExit; } };
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
