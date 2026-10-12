import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rename, unlink, rm, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { NATIVE_WATCH_GUEST } from '../sdk/javascript/watch-guest.js';

test('both SDKs package identical native watch code within the managed command budget', async () => {
  const source = await readFile(new URL('../sdk/python/mainbrella/_watch_guest.py', import.meta.url), 'utf8');
  const result = spawnSync(process.env.PYTHON || 'python3', ['-c', source + '\nprint(NATIVE_WATCH_GUEST, end="")'], { encoding: 'utf8' });
  assert.equal(result.status, 0); assert.equal(result.stdout, NATIVE_WATCH_GUEST);
  assert.ok(Buffer.byteLength(JSON.stringify(['node', '-e', NATIVE_WATCH_GUEST, '/workspace', 'true'])) < 16384);
});

async function guest(t, directory, recursive = true) {
  const child = spawn(process.execPath, ['-e', NATIVE_WATCH_GUEST, directory, String(recursive)], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  const events = [], waiters = new Set();
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => { events.push(JSON.parse(line)); for (const wake of waiters) wake(); });
  const wait = (predicate) => new Promise((resolve, reject) => {
    const check = () => { const event = events.find(predicate); if (event) { clearTimeout(timer); waiters.delete(check); resolve(event); } };
    const timer = setTimeout(() => { waiters.delete(check); reject(Error(`No matching event: ${JSON.stringify(events)}`)); }, 5000);
    waiters.add(check); check();
  });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; lines.close(); });
  return { child, events, exited, wait };
}

test('real Linux watcher sees a short-lived file, recursive edits and rename then releases its process', { skip: process.platform !== 'linux' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mb-native-watch-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'nested'));
  const probe = await guest(t, directory);
  assert.equal((await probe.wait(event => event.type === 'ready')).recursive, true);
  await writeFile(join(directory, 'blink'), 'x'); await unlink(join(directory, 'blink'));
  await probe.wait(event => event.filename === 'blink');
  await writeFile(join(directory, 'nested/界'), 'first');
  await probe.wait(event => event.filename === 'nested/界');
  await rename(join(directory, 'nested/界'), join(directory, 'nested/moved'));
  await probe.wait(event => event.filename === 'nested/moved' && event.type === 'rename');
  probe.child.kill('SIGTERM');
  assert.deepEqual(await probe.exited, [0, null]);
  assert.throws(() => process.kill(probe.child.pid, 0), { code: 'ESRCH' });
});

test('real Linux watcher refuses symlink roots and invalid UTF-8 filenames without raw diagnostics', { skip: process.platform !== 'linux' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mb-native-invalid-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await symlink(directory, join(directory, 'link'));
  const invalidRoot = await guest(t, join(directory, 'link'));
  assert.equal((await invalidRoot.wait(event => event.type === 'error')).code, 'file_watch_unavailable');
  assert.deepEqual(await invalidRoot.exited, [1, null]);
  const probe = await guest(t, directory, false);
  await probe.wait(event => event.type === 'ready');
  await writeFile(Buffer.concat([Buffer.from(directory + '/'), Buffer.from([0xff])]), 'x');
  assert.equal((await probe.wait(event => event.type === 'error')).code, 'file_watch_filename_invalid');
  assert.deepEqual(await probe.exited, [1, null]);
});
