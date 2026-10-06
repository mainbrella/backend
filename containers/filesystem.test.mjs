import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { accessFilesystem } from './filesystem.js';
import { UserContainerController } from './user-container-core.js';
import { MAX_DIRECTORY_ENTRIES, MAX_FILESYSTEM_BODY_BYTES, MAX_FILESYSTEM_OUTPUT_BYTES, decodeFilesystemEntries, validFilesystemOperation } from './filesystem-contract.js';

const createdAt = '2026-10-05T12:00:00.000Z', now = Date.parse(createdAt), expiresAt = now + 120_000;
const gnu = ['stat', 'find', 'sed'].every(command => spawnSync(command, ['--version'], { encoding: 'utf8' }).stdout?.includes('GNU'));
const linux = { skip: gnu ? false : 'Filesystem scripts require GNU stat/find/sed; CI exercises the actual guest utilities.' };
function request(operation, body, headers = {}, signal) {
  return new Request(`https://internal/filesystem/${operation}`, { method: 'POST', signal, body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'x-exec-created-at': createdAt, 'x-exec-expires-at': String(expiresAt), ...headers } });
}
async function fixture(t, timers = globalThis) {
  const dir = await mkdtemp(join(tmpdir(), 'mainbrella-fs-'));
  const calls = [], children = [], active = new Set();
  const values = new Map([
    ['builderMachine', { createdAt: now, expiresAt, idleExpiresAt: expiresAt, idleTimeoutMs: 600_000 }],
    ['machineEntitlement', { plan: 'builder', active: true, validUntil: expiresAt, checkedAt: now }],
  ]);
  const ctx = { storage: { async get(key) { return structuredClone(values.get(key)); }, async put(key, value) { values.set(key, structuredClone(value)); }, async setAlarm() {} },
    container: { running: true, async setInactivityTimeout() {}, async exec(argv, options) {
      calls.push({ argv, options });
      const child = spawn(argv[0], argv.slice(1), { stdio: 'pipe' }); children.push(child);
      const kill = () => child.kill('SIGKILL');
      options.signal.addEventListener('abort', kill, { once: true }); if (options.signal.aborted) kill();
      const exitCode = new Promise(resolve => child.on('close', code => { options.signal.removeEventListener('abort', kill); resolve(code ?? 137); }));
      return { stdin: Writable.toWeb(child.stdin), stdout: Readable.toWeb(child.stdout), stderr: Readable.toWeb(child.stderr), exitCode, kill };
    } },
  };
  const controller = new UserContainerController(ctx, () => now);
  t.after(async () => { for (const child of children) child.kill('SIGKILL'); await chmod(dir, 0o700); await rm(dir, { recursive: true, force: true }); });
  return { dir, calls, active, controller, values, ctx, run: (operation, body, headers, signal) => accessFilesystem(controller, request(operation, body, headers, signal), active, timers) };
}

test('real list/stat return stable bounded metadata pages, literal filenames and symlink information', linux, async t => {
  const f = await fixture(t);
  for (const name of ['a', 'c', "b 'quoted' $(touch INJECTED);\n界"]) await writeFile(join(f.dir, name), 'abc');
  await mkdir(join(f.dir, 'directory')); await symlink('a', join(f.dir, 'link')); await symlink('missing', join(f.dir, 'broken'));
  const first = await (await f.run('list', { path: f.dir, limit: 2 })).json();
  assert.deepEqual(first.entries.map(e => e.name), ['a', "b 'quoted' $(touch INJECTED);\n界"]);
  assert.equal(first.nextOffset, 2);
  const second = await (await f.run('list', { path: f.dir, limit: 4, offset: first.nextOffset })).json();
  assert.deepEqual(second.entries.map(e => e.name), ['broken', 'c', 'directory', 'link']);
  assert.equal(second.nextOffset, null);
  assert.equal(second.entries.at(-1).type, 'symlink'); assert.equal(second.entries.at(-1).linkTarget, 'a');
  const file = await (await f.run('stat', { path: join(f.dir, 'a') })).json();
  assert.equal(file.type, 'file'); assert.equal(file.size, 3); assert.match(file.modifiedAt, /^\d{4}-/); assert.match(file.mode, /^0[0-7]{3}$/);
  const target = await (await f.run('stat', { path: join(f.dir, 'link'), followSymlinks: true })).json();
  assert.equal(target.type, 'file'); assert.equal(target.linkTarget, undefined);
  assert.equal((await f.run('stat', { path: join(f.dir, 'broken') })).status, 200);
  assert.equal((await f.run('stat', { path: join(f.dir, 'broken'), followSymlinks: true })).status, 404);
  assert.equal((await f.run('list', { path: join(f.dir, 'a') })).status, 409);
  assert.equal((await f.run('list', { path: join(f.dir, 'missing') })).status, 404);
  const dirLink = join(f.dir, 'dirlink'); await symlink(f.dir, dirLink);
  assert.ok((await (await f.run('list', { path: dirLink })).json()).entries.length > 0);
  assert.equal((await f.run('stat', { path: '/' })).status, 200);
  assert.equal(f.active.size, 0);
  assert.equal((await readdir(f.dir)).includes('INJECTED'), false);
});

test('real mkdir/move/chmod/remove preserve semantics, deny replacement and never follow deleted symlinks', linux, async t => {
  const f = await fixture(t);
  const path = join(f.dir, 'new/sub');
  assert.equal((await f.run('mkdir', { path })).status, 404);
  assert.equal((await f.run('mkdir', { path, recursive: true, mode: '0750' })).status, 200);
  assert.equal((await stat(path)).mode & 0o777, 0o750);
  assert.equal((await f.run('mkdir', { path })).status, 409);
  assert.equal((await f.run('mkdir', { path, recursive: true })).status, 200);
  const source = join(path, "界 $(touch INJECTED).bin"), destination = join(path, 'moved');
  await writeFile(source, Buffer.from([0, 255])); await writeFile(destination, 'preserve');
  assert.equal((await f.run('move', { path: source, destination })).status, 409);
  assert.equal(await readFile(destination, 'utf8'), 'preserve');
  await rm(destination);
  assert.equal((await f.run('move', { path: source, destination })).status, 200);
  assert.deepEqual(await readFile(destination), Buffer.from([0, 255]));
  await assert.rejects(stat(source), { code: 'ENOENT' });
  assert.equal((await f.run('chmod', { path: destination, mode: '0640' })).status, 200);
  assert.equal((await stat(destination)).mode & 0o777, 0o640);
  await chmod(path, 0o2750);
  assert.equal((await f.run('chmod', { path, mode: '0750' })).status, 200);
  assert.equal((await stat(path)).mode & 0o7777, 0o750);
  const link = join(f.dir, 'link'); await symlink(destination, link);
  assert.equal((await f.run('chmod', { path: link, mode: '0777' })).status, 409);
  assert.equal((await f.run('mkdir', { path: link, recursive: true })).status, 409);
  assert.equal((await f.run('remove', { path: link, recursive: true })).status, 200);
  assert.equal((await readFile(destination)).length, 2);
  assert.equal((await f.run('remove', { path })).status, 409);
  assert.equal((await f.run('remove', { path, recursive: true })).status, 200);
  assert.equal((await f.run('remove', { path })).status, 404);
  assert.equal(f.active.size, 0);
});

test('filesystem validation rejects traversal, malformed options, unsafe modes and oversized requests before launch', async t => {
  const f = await fixture(t);
  for (const path of ['', 'relative', '/a/../b', '/a/./b', '/a//b', '/a/', '/a\0b', '/\ud800', `/${'界'.repeat(1500)}`]) {
    assert.equal((await f.run('stat', { path })).status, 400);
  }
  for (const [operation, options] of [['list', { limit: 0 }], ['list', { limit: MAX_DIRECTORY_ENTRIES + 1 }], ['list', { offset: -1 }],
    ['list', { recursive: true }], ['stat', { followSymlinks: 'true' }], ['mkdir', { recursive: 1 }], ['mkdir', { mode: '777' }],
    ['chmod', { mode: '4755' }], ['chmod', {}], ['move', { destination: '/tmp/a/child' }], ['move', { destination: '/tmp/a' }]]) {
    assert.equal((await f.run(operation, { path: '/tmp/a', ...options })).status, 400);
  }
  for (const operation of ['mkdir', 'remove', 'move', 'chmod']) assert.equal(validFilesystemOperation(operation, { path: '/', mode: '0700', destination: '/file' }), false);
  assert.equal((await f.run('stat', { path: '/file', extra: 'x'.repeat(MAX_FILESYSTEM_BODY_BYTES) })).status, 400);
  assert.equal(f.calls.length, 0);
});

test('filesystem refuses missing, stale, expired, stopped and unpaid generations and rechecks before launch', async t => {
  for (const mode of ['missing', 'stale', 'expired', 'stopped', 'unpaid', 'headers', 'race']) {
    const f = await fixture(t);
    if (mode === 'missing') f.values.delete('builderMachine');
    if (mode === 'expired') f.values.get('builderMachine').idleExpiresAt = now;
    if (mode === 'stopped') f.ctx.container.running = false;
    if (mode === 'unpaid') f.values.get('machineEntitlement').active = false;
    if (mode === 'race') {
      const original = f.controller.getTerminalMetadata.bind(f.controller);
      f.controller.getTerminalMetadata = async (...args) => { const result = await original(...args); f.values.get('builderMachine').createdAt += 1; return result; };
    }
    const headers = mode === 'stale' ? { 'x-exec-created-at': '2026-10-05T13:00:00.000Z' } : mode === 'headers' ? { 'x-exec-created-at': '' } : {};
    assert.equal((await f.run('stat', { path: '/file' }, headers)).status, mode === 'headers' ? 403 : 409);
    assert.equal(f.calls.length, 0);
  }
});

test('filesystem shares the command pool and bounds timeout/disconnect/stop, including late startup', async t => {
  const capacity = await fixture(t);
  for (let i = 0; i < 4; i++) capacity.active.add({ close() {} });
  assert.equal((await capacity.run('list', { path: '/' })).status, 429); assert.equal(capacity.calls.length, 0);
  for (const mode of ['timeout', 'disconnect', 'stop']) {
    const f = await fixture(t, { setTimeout: callback => setTimeout(callback, mode === 'timeout' ? 10 : 1000), clearTimeout });
    let resolveStart;
    f.controller.startTerminalProcess = () => new Promise(resolve => { resolveStart = resolve; });
    const abort = new AbortController();
    const pending = f.run('stat', { path: '/file' }, {}, abort.signal);
    while (!resolveStart) await new Promise(resolve => setImmediate(resolve));
    if (mode === 'disconnect') abort.abort(); if (mode === 'stop') for (const session of f.active) session.close();
    assert.equal((await pending).status, mode === 'stop' ? 409 : 503); assert.equal(f.active.size, 0);
    let killed = false; resolveStart({ kill() { killed = true; } });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(killed, true);
  }
});

test('malformed metadata, unsupported filename bytes and oversized output fail without partial entries', async t => {
  assert.throws(() => decodeFilesystemEntries(new Uint8Array([255, 0])), /unsupported_file_name/);
  assert.throws(() => decodeFilesystemEntries(new TextEncoder().encode('broken')), /files_unavailable/);
  const f = await fixture(t);
  f.controller.startTerminalProcess = async () => ({ stdin: new WritableStream(), stdout: new Response(new Uint8Array(MAX_FILESYSTEM_OUTPUT_BYTES + 2)).body,
    stderr: new Response('').body, exitCode: Promise.resolve(0), kill() {} });
  assert.equal((await f.run('list', { path: '/' })).status, 413);
  assert.equal(f.active.size, 0);
});

test('real permission failures are sanitized and empty directories list without filler', { ...linux, skip: linux.skip || (process.getuid?.() === 0 ? 'Root bypasses guest permission checks.' : false) }, async t => {
  const f = await fixture(t);
  const empty = await (await f.run('list', { path: f.dir })).json();
  assert.deepEqual(empty.entries, []); assert.equal(empty.nextOffset, null);
  await chmod(f.dir, 0o000);
  const response = await f.run('list', { path: f.dir });
  assert.equal(response.status, 403); assert.deepEqual(await response.json(), { error: 'file_access_denied' });
});
