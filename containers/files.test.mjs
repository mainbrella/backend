import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, stat, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { accessFile } from './files.js';
import { MAX_FILE_BYTES, readFileBytes } from './file-contract.js';
import { UserContainerController } from './user-container-core.js';

const createdAt = '2026-10-05T12:00:00.000Z';
const now = Date.parse(createdAt);
const expiresAt = now + 120_000;
const gnu = spawnSync('mv', ['--version'], { encoding: 'utf8' }).stdout?.includes('GNU coreutils');
const writeOptions = { skip: gnu ? false : 'Writes require GNU coreutils on PATH, as in deployed catalog images.' };

function request(path, method = 'GET', bytes, headers = {}, signal) {
  const url = new URL('https://internal/files'); url.searchParams.set('path', path);
  return new Request(url, { method, body: bytes, signal,
    headers: { 'x-exec-created-at': createdAt, 'x-exec-expires-at': String(expiresAt), ...headers } });
}
async function fixture(t, timers = globalThis) {
  const dir = await mkdtemp(join(tmpdir(), 'mainbrella-files-'));
  const children = [];
  const calls = [];
  const values = new Map([
    ['builderMachine', { createdAt: now, expiresAt, idleExpiresAt: expiresAt, idleTimeoutMs: 600_000 }],
    ['machineEntitlement', { plan: 'builder', active: true, validUntil: expiresAt, checkedAt: now }],
  ]);
  const ctx = {
    storage: { async get(key) { return structuredClone(values.get(key)); },
      async put(key, value) { values.set(key, structuredClone(value)); }, async setAlarm() {} },
    container: { running: true, async setInactivityTimeout() {}, async exec(argv, options) {
      calls.push({ argv, options });
      const child = spawn(argv[0], argv.slice(1), { stdio: 'pipe' });
      children.push(child);
      const kill = () => { child.kill('SIGKILL'); };
      options.signal.addEventListener('abort', kill, { once: true });
      if (options.signal.aborted) kill();
      const exitCode = new Promise(resolve => child.on('close', code => {
        options.signal.removeEventListener('abort', kill); resolve(code ?? 137);
      }));
      return { stdin: Writable.toWeb(child.stdin), stdout: Readable.toWeb(child.stdout),
        stderr: Readable.toWeb(child.stderr), exitCode, kill };
    } },
  };
  t.after(async () => { for (const child of children) child.kill('SIGKILL'); await rm(dir, { recursive: true, force: true }); });
  const controller = new UserContainerController(ctx, () => now);
  const active = new Set();
  return { dir, ctx, values, calls, children, controller, active, run: req => accessFile(controller, req, active, timers) };
}

test('real files preserve every byte, empty contents, maximum size and replacement permissions', writeOptions, async t => {
  const f = await fixture(t);
  const path = join(f.dir, 'binary.bin');
  for (const bytes of [Uint8Array.from({ length: 256 }, (_, i) => i), new Uint8Array(), new Uint8Array(MAX_FILE_BYTES).fill(255)]) {
    const written = await f.run(request(path, 'PUT', bytes));
    assert.equal(written.status, 200, JSON.stringify(await written.clone().json()));
    assert.deepEqual(await written.json(), { path, size: bytes.byteLength });
    assert.deepEqual(new Uint8Array(await readFile(path)), bytes);
    const response = await f.run(request(path));
    assert.equal(response.headers.get('content-type'), 'application/octet-stream');
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
    assert.equal(f.active.size, 0);
  }
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await chmod(path, 0o755);
  assert.equal((await f.run(request(path, 'PUT', new Uint8Array([1, 2])))).status, 200);
  assert.equal((await stat(path)).mode & 0o777, 0o755);
  assert.equal((await f.run(request(path, 'PUT'))).status, 200);
  assert.equal((await readFile(path)).byteLength, 0);
});

test('shell metacharacters, Unicode and newlines in paths remain literal arguments', writeOptions, async t => {
  const f = await fixture(t);
  const path = join(f.dir, "界 'quoted' $(touch INJECTED);\n.txt");
  const bytes = new Uint8Array([0, 255, 192, 128, 10]);
  assert.equal((await f.run(request(path, 'PUT', bytes))).status, 200);
  assert.deepEqual(new Uint8Array(await (await f.run(request(path))).arrayBuffer()), bytes);
  assert.equal(f.calls[0].argv.at(-1), path);
  await assert.rejects(stat(join(f.dir, 'INJECTED')), { code: 'ENOENT' });
});

test('read rejects missing, directory and oversized files without partial data', async t => {
  const f = await fixture(t);
  const path = join(f.dir, 'oversized');
  await writeFile(path, new Uint8Array(MAX_FILE_BYTES + 1));
  for (const [target, status, error] of [[join(f.dir, 'missing'), 404, 'file_not_found'],
    [f.dir, 409, 'not_regular_file'], [path, 413, 'file_too_large']]) {
    const response = await f.run(request(target));
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error });
  }
  const link = join(f.dir, 'link');
  await writeFile(path, new Uint8Array([0, 255])); await symlink(path, link);
  assert.deepEqual(new Uint8Array(await (await f.run(request(link))).arrayBuffer()), new Uint8Array([0, 255]));
  const fifo = join(f.dir, 'fifo');
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  assert.equal((await f.run(request(fifo))).status, 409);
});

test('write rejects oversized uploads, missing parents, directories and symlinks', writeOptions, async t => {
  const f = await fixture(t);
  const path = join(f.dir, 'existing'); await writeFile(path, 'preserve');
  const link = join(f.dir, 'link'); await symlink(path, link);
  for (const [target, bytes, status, error] of [
    [path, new Uint8Array(MAX_FILE_BYTES + 1), 413, 'file_too_large'],
    [join(f.dir, 'missing', 'file'), new Uint8Array(MAX_FILE_BYTES), 404, 'file_not_found'],
    [f.dir, new Uint8Array(MAX_FILE_BYTES), 409, 'not_regular_file'],
    [link, new Uint8Array([1]), 409, 'not_regular_file'],
  ]) {
    const response = await f.run(request(target, 'PUT', bytes));
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error });
  }
  assert.equal(await readFile(path, 'utf8'), 'preserve');
});

test('invalid paths and unauthorized/stale/expired/stopped/unpaid generations never launch', async t => {
  for (const mode of ['invalid', 'missing', 'stale', 'expired', 'stopped', 'unpaid', 'headers']) {
    const f = await fixture(t);
    if (mode === 'missing') f.values.delete('builderMachine');
    if (mode === 'expired') f.values.get('builderMachine').idleExpiresAt = now;
    if (mode === 'stopped') f.ctx.container.running = false;
    if (mode === 'unpaid') f.values.get('machineEntitlement').active = false;
    const response = await f.run(request(mode === 'invalid' ? '../bad' : join(f.dir, 'file'), 'GET', undefined,
      mode === 'stale' ? { 'x-exec-created-at': '2026-10-05T13:00:00.000Z' } : mode === 'headers' ? { 'x-exec-created-at': '' } : {}));
    assert.equal(response.status, mode === 'invalid' ? 400 : mode === 'headers' ? 403 : 409);
    assert.equal(f.calls.length, 0);
  }
});

test('file operations share execution capacity and recheck the generation before launch', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 4; i++) f.active.add({ close() {} });
  assert.equal((await f.run(request(join(f.dir, 'file')))).status, 429);
  assert.equal(f.calls.length, 0);
  f.active.clear();
  const original = f.controller.getTerminalMetadata.bind(f.controller);
  f.controller.getTerminalMetadata = async (...args) => {
    const result = await original(...args); f.values.get('builderMachine').createdAt += 1; return result;
  };
  assert.equal((await f.run(request(join(f.dir, 'file')))).status, 409);
  assert.equal(f.calls.length, 0);
});

test('timeout, disconnect and machine stop bound pending startup and kill late processes', async t => {
  for (const mode of ['timeout', 'disconnect', 'stop']) {
    const f = await fixture(t, { setTimeout(callback) { return setTimeout(callback, mode === 'timeout' ? 10 : 1000); }, clearTimeout });
    let resolveStart;
    f.controller.startTerminalProcess = () => new Promise(resolve => { resolveStart = resolve; });
    const abort = new AbortController();
    const pending = f.run(request(join(f.dir, 'file'), 'GET', undefined, {}, abort.signal));
    while (!resolveStart) await new Promise(resolve => setImmediate(resolve));
    if (mode === 'disconnect') abort.abort();
    if (mode === 'stop') for (const session of f.active) session.close();
    const response = await pending;
    assert.equal(response.status, mode === 'stop' ? 409 : 503);
    assert.equal(f.active.size, 0);
    let killed = false;
    resolveStart({ kill() { killed = true; } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(killed, true);
  }
});

test('streamed uploads enforce the byte limit and cancel unread data', async () => {
  let canceled = false;
  const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(32_768)); }, cancel() { canceled = true; } });
  await assert.rejects(readFileBytes(stream), /file_too_large/);
  assert.equal(canceled, true);
});

test('disconnect closes active output streams and kills the running process', async t => {
  const f = await fixture(t);
  let killed = false;
  let closed = 0;
  f.controller.startTerminalProcess = async () => ({
    stdin: new WritableStream(),
    stdout: new ReadableStream({ cancel() { closed++; } }),
    stderr: new ReadableStream({ cancel() { closed++; } }),
    exitCode: new Promise(() => {}), kill() { killed = true; },
  });
  const abort = new AbortController();
  const pending = f.run(request(join(f.dir, 'file'), 'GET', undefined, {}, abort.signal));
  // Give the runtime time to acquire both stream readers.
  await new Promise(resolve => setImmediate(resolve));
  abort.abort();
  assert.equal((await pending).status, 503);
  assert.equal(killed, true);
  assert.equal(closed, 2);
  assert.equal(f.active.size, 0);
});
