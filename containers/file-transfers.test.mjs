import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, stat, chmod, symlink, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { transferFile } from './file-transfers.js';
import { exactByteStream, MAX_TRANSFER_BYTES, transferSize } from './file-transfer-contract.js';
import { UserContainerController } from './user-container-core.js';

const linux = { skip: process.platform !== 'linux' && 'Real transfer scripts require Linux /proc and GNU coreutils.' };
const createdAt = '2026-10-05T12:00:00.000Z', now = Date.parse(createdAt), expiresAt = now + 600_000;
function request(path, method = 'GET', body, size, signal) {
  const url = new URL('https://internal/files/transfer'); url.searchParams.set('path', path);
  if (size !== undefined) url.searchParams.set('size', String(size));
  return new Request(url, { method, body, signal, duplex: 'half', headers: { 'x-exec-created-at': createdAt, 'x-exec-expires-at': String(expiresAt) } });
}
async function fixture(t, timers = globalThis) {
  const dir = await mkdtemp(join(tmpdir(), 'mainbrella-transfer-')), children = [];
  const values = new Map([
    ['builderMachine', { createdAt: now, expiresAt, idleExpiresAt: expiresAt, idleTimeoutMs: 600_000 }],
    ['machineEntitlement', { plan: 'builder', active: true, validUntil: expiresAt, checkedAt: now }],
  ]);
  const ctx = { storage: { async get(key) { return structuredClone(values.get(key)); },
    async put(key, value) { values.set(key, structuredClone(value)); }, async setAlarm() {} },
  container: { running: true, async setInactivityTimeout() {}, async destroy() { this.running = false; for (const child of children) child.kill('SIGKILL'); }, async exec(argv, options) {
    const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', options.stdout === 'ignore' ? 'ignore' : 'pipe', options.stderr === 'ignore' ? 'ignore' : 'pipe'] }); children.push(child);
    const kill = () => child.kill('SIGKILL');
    options.signal?.addEventListener('abort', kill, { once: true });
    if (options.signal?.aborted) kill();
    return { stdin: Writable.toWeb(child.stdin), stdout: child.stdout && Readable.toWeb(child.stdout), stderr: child.stderr && Readable.toWeb(child.stderr), kill,
      exitCode: new Promise(resolve => child.on('close', code => { options.signal?.removeEventListener('abort', kill); resolve(code ?? 137); })) };
  } } };
  const active = new Set(), controller = new UserContainerController(ctx, () => now);
  t.after(async () => { for (const child of children) child.kill('SIGKILL'); await rm(dir, { recursive: true, force: true }); });
  return { dir, active, values, ctx, controller, children, run: req => transferFile(controller, req, active, timers) };
}

test('exact transfer streams reject size mismatches and cancel their sources', async () => {
  assert.equal(transferSize('0'), 0);
  for (const value of ['01', '-1', '1.5', String(MAX_TRANSFER_BYTES + 1), null]) assert.equal(transferSize(value), null);
  for (const count of [2, 4]) {
    let canceled = false;
    const source = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(count)); if (count < 3) c.close(); }, cancel() { canceled = true; } });
    await assert.rejects(new Response(exactByteStream(source, 3)).arrayBuffer(), /file_size_mismatch/);
    if (count > 3) assert.equal(canceled, true);
  }
  const abort = new AbortController();
  let canceled = false;
  const stream = exactByteStream(new ReadableStream({ cancel() { canceled = true; } }), 4, abort.signal);
  const reading = new Response(stream).arrayBuffer(); abort.abort();
  await assert.rejects(reading, /request_aborted/);
  assert.equal(canceled, true);
});

test('large streamed binary uploads and downloads preserve bytes, empty files and modes', linux, async t => {
  const f = await fixture(t), path = join(f.dir, '界 $(literal)\n.bin');
  const data = Uint8Array.from({ length: 2 * 1024 * 1024 + 11 }, (_, i) => i % 256);
  for (const bytes of [data, new Uint8Array()]) {
    let offset = 0;
    const body = new ReadableStream({ pull(c) { if (offset === bytes.length) c.close(); else { const next = bytes.subarray(offset, offset + 32768); offset += next.length; c.enqueue(next); } } });
    const written = await f.run(request(path, 'PUT', body, bytes.length));
    assert.equal(written.status, 200, JSON.stringify(await written.clone().json()));
    assert.deepEqual(await written.json(), { path, size: bytes.length });
    assert.deepEqual(new Uint8Array(await readFile(path)), bytes);
    const response = await f.run(request(path));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-length'), String(bytes.length));
    assert.equal(f.active.size, 1);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
    assert.equal(f.active.size, 0);
  }
  await chmod(path, 0o751);
  assert.equal((await f.run(request(path, 'PUT', new Uint8Array([1]), 1))).status, 200);
  assert.equal((await stat(path)).mode & 0o777, 0o751);
});

test('short, oversized and disconnected uploads never publish a partial file', linux, async t => {
  const f = await fixture(t), path = join(f.dir, 'existing'); await writeFile(path, 'preserve');
  for (const [bytes, size] of [[new Uint8Array(2), 3], [new Uint8Array(4), 3]]) {
    const response = await f.run(request(path, 'PUT', bytes, size));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'file_size_mismatch');
    assert.equal(await readFile(path, 'utf8'), 'preserve');
  }
  const abort = new AbortController(); let canceled = false, sent = false;
  const body = new ReadableStream({ pull(c) { if (!sent) { sent = true; c.enqueue(new Uint8Array([1, 2, 3])); } }, cancel() { canceled = true; } });
  const pending = f.run(request(path, 'PUT', body, 3, abort.signal));
  while (!f.children.length || !sent) await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setTimeout(resolve, 20)); abort.abort();
  assert.equal((await pending).status, 503);
  assert.equal(await readFile(path, 'utf8'), 'preserve');
  assert.equal(canceled, true);
  assert.equal(f.active.size, 0);
});

test('downloads reject oversized files and non-regular paths before sending any bytes', linux, async t => {
  const f = await fixture(t), path = join(f.dir, 'large'); await writeFile(path, ''); await truncate(path, MAX_TRANSFER_BYTES + 1);
  for (const [target, status] of [[path, 413], [f.dir, 409], [join(f.dir, 'missing'), 404]]) assert.equal((await f.run(request(target))).status, status);
  const link = join(f.dir, 'link'); await symlink(path, link);
  assert.equal((await f.run(request(link, 'PUT', new Uint8Array([1]), 1))).status, 409);
});

test('canceling unread downloads releases the execution slot and guest process', linux, async t => {
  const f = await fixture(t), path = join(f.dir, 'large'); await writeFile(path, new Uint8Array(2 * 1024 * 1024));
  const response = await f.run(request(path)); assert.equal(response.status, 200);
  assert.equal(f.active.size, 1); await response.body.cancel(); assert.equal(f.active.size, 0);
  for (let i = 0; i < 4; i++) f.active.add({ close() {} });
  assert.equal((await f.run(request(path))).status, 429);
});

test('generation changes, unpaid leases, deadlines and machine stops close transfers', linux, async t => {
  for (const mode of ['stale', 'unpaid', 'timeout', 'stop']) {
    const f = await fixture(t, { setTimeout(fn) { return setTimeout(fn, mode === 'timeout' ? 100 : 1000); }, clearTimeout });
    const path = join(f.dir, 'file'); await writeFile(path, new Uint8Array(2 * 1024 * 1024));
    if (mode === 'stale') f.values.get('builderMachine').createdAt++;
    if (mode === 'unpaid') f.values.get('machineEntitlement').active = false;
    const response = await f.run(request(path));
    if (['stale', 'unpaid'].includes(mode)) { assert.equal(response.status, 409); assert.equal(f.children.length, 0); continue; }
    assert.equal(response.status, 200);
    if (mode === 'stop') for (const session of f.active) session.close();
    else await new Promise(resolve => setTimeout(resolve, 150));
    await assert.rejects(response.arrayBuffer());
    // Stream failure precedes asynchronous guest-group cleanup confirmation.
    await Promise.all([...f.active].map(session => session.close()));
    assert.equal(f.active.size, 0);
  }
});
