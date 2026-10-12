import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';
import { normalizeRestoreLaunch, restoreEntrypoint, MAX_RESTORE_LOG_BYTES } from './restore-launch.js';
import { UserContainerController } from './user-container-core.js';

test('saved launch recipes normalize defaults and reject unsafe target, directory, secret and command shapes', () => {
  const recipe = { command: 'npm start', readiness: { port: 3000 } };
  assert.deepEqual(normalizeRestoreLaunch(recipe), { command: 'npm start', cwd: '/workspace', readiness: { port: 3000, path: '/', timeoutMs: 30_000 } });
  assert.equal(normalizeRestoreLaunch({ ...recipe, command: 'set -eu\nexec node server.mjs' }).command, 'set -eu\nexec node server.mjs');
  for (const change of [null, {}, { ...recipe, command: '' }, { ...recipe, command: 'echo\0second' }, { ...recipe, command: 'x'.repeat(4097) },
    { ...recipe, cwd: '/workspace/../etc' }, { ...recipe, cwd: 'relative' }, { ...recipe, cwd: '/x'.repeat(600) },
    { ...recipe, env: { SECRET: 'not metadata' } }, { ...recipe, readiness: { port: 22 } }, { ...recipe, readiness: { port: 65536 } },
    { ...recipe, readiness: { port: 3000, path: '//outside.test/' } }, { ...recipe, readiness: { port: 3000, path: '/\\outside.test' } },
    { ...recipe, readiness: { port: 3000, path: '/ok\r\nBad: header' } }, { ...recipe, readiness: { port: 3000, timeoutMs: 60001 } }]) assert.equal(normalizeRestoreLaunch(change), null);
});

test('restore entrypoint launches once, honors a quoted cwd, and retains failed output without restarting', async t => {
  const directory = await mkdtemp(join(tmpdir(), "restore 'recipe "));
  const log = join(directory, 'app.log');
  const argv = restoreEntrypoint(normalizeRestoreLaunch({ command: 'printf x >> launches\necho "useful failure"\nexit 7', cwd: directory, readiness: { port: 3000 } }), log);
  const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: 'ignore' });
  t.after(async () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} await rm(directory, { recursive: true, force: true }); });
  let drained = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    // The exit receipt intentionally precedes logger drain. The pipe is
    // removed only after the logger has committed the final output file.
    if (await readFile(`${log}.exit`, 'utf8').catch(() => '') === '7\n') {
      drained = await stat(`${log}.pipe`).then(() => false, error => {
        if (error.code === 'ENOENT') return true;
        throw error;
      });
      if (drained) break;
    }
    await pause(25);
  }
  assert.equal(drained, true);
  assert.equal(await readFile(`${log}.exit`, 'utf8'), '7\n');
  assert.equal(await readFile(log, 'utf8'), 'useful failure\n');
  await pause(100);
  assert.equal(await readFile(join(directory, 'launches'), 'utf8'), 'x');
});

test('a foreground command exiting is recorded even when its background child keeps the output pipe open', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'restore-background-'));
  const log = join(directory, 'app.log');
  const argv = restoreEntrypoint(normalizeRestoreLaunch({ command: 'sleep 30 & exit 9', cwd: directory, readiness: { port: 3000 } }), log);
  const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: 'ignore' });
  t.after(async () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} await rm(directory, { recursive: true, force: true }); });
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await readFile(`${log}.exit`, 'utf8').catch(() => '') === '9\n') break;
    await pause(25);
  }
  assert.equal(await readFile(`${log}.exit`, 'utf8'), '9\n');
});

function fixture({ statuses = [200], diagnostics = '\n', advance = 0 } = {}) {
  let now = Date.UTC(2026, 9, 12), responses = 0;
  const values = new Map();
  const storage = { async get(key) { return structuredClone(values.get(key)); }, async put(key, value) { values.set(key, structuredClone(value)); }, async setAlarm() {}, async deleteAlarm() {} };
  const requests = [], tasks = [];
  const container = { running: false, images: { terminal: 'image@sha256:pinned' }, starts: [], execCalls: [],
    start(options) { this.starts.push(options); this.running = true; }, async setInactivityTimeout() {}, async destroy() { this.running = false; },
    async exec(argv) { this.execCalls.push(argv); return { output: async () => ({ exitCode: 0, stdout: argv.includes('restore-diagnostics') ? diagnostics : '' }) }; },
    getTcpPort(port) { return { fetch: async request => { requests.push({ port, request }); now += advance; return new Response('health', { status: statuses[Math.min(responses++, statuses.length - 1)] }); } }; },
  };
  const controller = new UserContainerController({ storage, container, waitUntil(task) { tasks.push(task); } }, () => now);
  const launch = normalizeRestoreLaunch({ command: 'npm start', cwd: '/workspace/app', readiness: { port: 3000, path: '/health', timeoutMs: 1000 } });
  const headers = { 'x-mainbrella-plan': 'builder', 'x-mainbrella-paid-until': String(now + 86400_000), 'x-mainbrella-reservation': '1' };
  const start = () => controller.fetch(new Request('https://internal/container/workspace-launch-v1', { method: 'POST', headers,
    body: JSON.stringify({ workspaceId: 'd688d42a-25ef-4c13-9b28-21a0fde6e163', workspaceExpiresAt: now + 86400_000,
      imageKey: 'terminal', imageDigest: container.images.terminal, containerSnapshot: { id: 'owned-snapshot' }, restoreLaunch: launch }) }));
  return { controller, container, values, storage, tasks, requests, start, setTime(value) { now = value; }, now: () => now };
}

test('HTTP readiness happens asynchronously, reports only 2xx ready, and polling never repeats launch', async () => {
  const f = fixture({ statuses: [503, 200] });
  const started = await f.start();
  const body = await started.json();
  assert.equal(body.containers[0].status, 'running');
  assert.equal(body.containers[0].readiness.status, 'starting');
  await Promise.all(f.tasks);
  const current = await f.controller.status();
  assert.equal(current.containers[0].readiness.status, 'ready');
  assert.equal(f.container.starts.length, 1);
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[0].port, 3000);
  assert.equal(f.requests[0].request.url, 'http://localhost/health');
  assert.equal(f.requests[0].request.redirect, 'manual');
  assert.equal(f.requests[0].request.signal.aborted, true);
  for (let i = 0; i < 3; i++) await f.controller.status();
  assert.equal(f.container.starts.length, 1);
  assert.equal(f.requests.length, 2);
  assert.equal('deadlineAt' in current.containers[0].readiness, false);
  assert.ok(!current.containers[0].readiness.logPath.includes((await f.storage.get('builderMachine')).telemetryId));
});

test('exited launch keeps machine accessible with decoded and byte-bounded failure logs', async () => {
  const output = new TextEncoder().encode('17\n' + 'é'.repeat(6000));
  const f = fixture({ diagnostics: output.buffer });
  await f.start(); await Promise.all(f.tasks);
  const current = (await f.controller.status()).containers[0];
  assert.equal(current.status, 'running');
  assert.equal(current.readiness.status, 'failed');
  assert.equal(current.readiness.error, 'launch_exited');
  assert.ok(new TextEncoder().encode(current.readiness.logTail).length <= MAX_RESTORE_LOG_BYTES);
  assert.ok(current.readiness.logTail.endsWith('é'));
  assert.ok(!current.readiness.logTail.includes('[object ArrayBuffer]'));
  assert.equal(f.container.running, true);
  assert.equal(f.container.starts.length, 1);
});

test('redirects and timeout do not count as application readiness', async () => {
  const f = fixture({ statuses: [302], advance: 1100, diagnostics: new TextEncoder().encode('\nwaiting for database') });
  await f.start(); await Promise.all(f.tasks);
  const current = (await f.controller.status()).containers[0];
  assert.equal(current.readiness.status, 'failed');
  assert.equal(current.readiness.error, 'readiness_timeout');
  assert.equal(current.readiness.logTail, 'waiting for database');
  assert.equal(f.container.running, true);
});

test('an HTTP success received after the saved readiness deadline is a timeout', async () => {
  const f = fixture({ statuses: [200], advance: 1100 });
  await f.start(); await Promise.all(f.tasks);
  assert.equal((await f.controller.status()).containers[0].readiness.status, 'failed');
  assert.equal((await f.controller.status()).containers[0].readiness.error, 'readiness_timeout');
});

test('a hanging diagnostic exec admission releases the lifecycle lock so status and deletion still work', async () => {
  const f = fixture();
  const original = f.container.exec;
  f.container.exec = argv => argv.includes('restore-diagnostics') ? new Promise(() => {}) : original.call(f.container, argv);
  f.controller.setTimer = (callback, delay) => setTimeout(callback, delay === 1500 ? 0 : delay);
  await f.start(); await Promise.all(f.tasks);
  assert.equal((await f.controller.status()).containers[0].readiness.status, 'ready');
  await f.controller.serialized(() => f.controller.destroy());
  assert.equal(f.container.running, false);
});

test('readiness deadline clamped to the machine deadline reaches a terminal state', async () => {
  const f = fixture();
  f.controller.ensureRestoreReadiness = () => {};
  await f.start();
  const original = await f.storage.get('builderMachine');
  original.expiresAt = original.readiness.deadlineAt;
  original.idleExpiresAt = original.readiness.deadlineAt;
  await f.storage.put('builderMachine', original);
  f.setTime(original.expiresAt);
  const restarted = new UserContainerController(f.controller.ctx, f.now);
  await restarted.status();
  await Promise.all([...restarted.restoreReadinessTasks.values()]);
  assert.equal((await f.storage.get('builderMachine')).readiness.status, 'failed');
  assert.equal((await f.storage.get('builderMachine')).readiness.error, 'readiness_timeout');
});

test('late readiness results cannot mark a replacement generation ready', async () => {
  const f = fixture();
  let release;
  f.container.getTcpPort = () => ({ fetch: () => new Promise(resolve => { release = resolve; }) });
  await f.start();
  for (let i = 0; i < 10 && !release; i++) await pause(0);
  const replacement = { ...await f.storage.get('builderMachine'), createdAt: f.now() + 1, telemetryId: 'replacement' };
  await f.storage.put('builderMachine', replacement);
  release(new Response('ok'));
  await Promise.all(f.tasks);
  assert.deepEqual(await f.storage.get('builderMachine'), replacement);
  assert.equal(f.container.execCalls.filter(argv => argv.includes('restore-diagnostics')).length, 0);
});

test('controller recreation resumes readiness observation without rerunning the saved command', async () => {
  const f = fixture();
  f.controller.ensureRestoreReadiness = () => {};
  await f.start();
  const restarted = new UserContainerController(f.controller.ctx, f.now);
  const current = await restarted.status();
  assert.equal(current.containers[0].readiness.status, 'starting');
  await Promise.all([...restarted.restoreReadinessTasks.values()]);
  assert.equal((await restarted.status()).containers[0].readiness.status, 'ready');
  assert.equal(f.container.starts.length, 1);
});
