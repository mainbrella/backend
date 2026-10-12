import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UserContainerController } from '../containers/user-container-core.js';
import * as restore from '../containers/restore-launch.js';
const command = promisify(execFile);
const docker = async (...args) => (await command('docker', args, { timeout: 60_000, maxBuffer: 1024 * 1024 })).stdout.trim();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
if (process.argv.length !== 4 || process.argv[2] !== '--image' || !process.argv[3] || process.argv[3].startsWith('-')) {
  console.error('Usage: node experiments/restore-launch-smoke.mjs --image EXISTING_IMAGE');
  process.exit(2);
}
const image = process.argv[3];
const imageInfo = JSON.parse(await docker('image', 'inspect', '--format', '{{json .}}', image));
if (imageInfo.Os !== 'linux' || !imageInfo.Architecture) throw new Error(`Unsupported image platform: ${imageInfo.Os}/${imageInfo.Architecture}`);
const platform = `${imageInfo.Os}/${imageInfo.Architecture}`;
const tag = `mb-restore-smoke-${Date.now()}-${randomUUID().slice(0, 6)}`;
const directory = await mkdtemp(join(tmpdir(), `${tag}-`));
const base = image;
const sourceName = `${tag}-source`, snapshot = `${tag}-snapshot:local`;
const containers = [], results = [], cleanup = [];
let snapshotCreated = false, failure;
const startedAt = new Date().toISOString();
const app = `import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
appendFileSync('/workspace/launches', 'launch\\n');
const mode = process.argv[2];
if (mode === 'failure') {
  process.stdout.write('x'.repeat(3 * 1024 * 1024) + 'é'.repeat(6000) + '\\nEXPECTED_STARTUP_FAILURE\\n', () => process.exit(7));
} else {
  let checks = 0;
  createServer((request, response) => { checks++; response.writeHead(mode === 'timeout' || checks <= 2 ? 503 : 200); response.end('health-' + checks); }).listen(3000, '0.0.0.0');
  console.log('fixture listening');
}
`;
await writeFile(join(directory, 'app.mjs'), app);
const nativeProcess = (name, argv, options = {}) => {
  const child = spawn('docker', ['exec', name, ...argv], { stdio: ['ignore', 'pipe', 'pipe'], ...(options.signal ? { signal: options.signal } : {}) });
  const stdout = [], stderr = [];
  let bytes = 0;
  child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 64 * 1024) child.kill(); else stdout.push(chunk); });
  child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 64 * 1024) child.kill(); else stderr.push(chunk); });
  const completed = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => resolve({ stdout: new Uint8Array(Buffer.concat(stdout)).buffer,
      stderr: new Uint8Array(Buffer.concat(stderr)).buffer, exitCode: code ?? 137 }));
  });
  void completed.catch(() => {});
  return { output: () => completed, kill: () => child.kill('SIGKILL'), exitCode: completed.then(result => result.exitCode, () => 137) };
};
try {
  containers.push(sourceName);
  await docker('run', '--detach', '--platform', platform, '--name', sourceName, '--label', `mainbrella.restore-smoke=${tag}`, '--entrypoint', 'sleep', base, 'infinity');
  await docker('exec', sourceName, 'mkdir', '-p', '/workspace');
  await docker('cp', join(directory, 'app.mjs'), `${sourceName}:/workspace/app.mjs`);
  await docker('exec', sourceName, 'sh', '-c', 'printf prepared > /workspace/prepared');
  const sourceHash = (await docker('exec', sourceName, 'sha256sum', '/workspace/app.mjs')).split(' ')[0];
  assert.equal(sourceHash, hash(app));
  await docker('commit', '--change', `LABEL mainbrella.restore-smoke=${tag}`, sourceName, snapshot);
  snapshotCreated = true;
  for (const mode of ['healthy', 'failure', 'timeout', 'background']) {
    const name = `${tag}-${mode}`;
    containers.push(name);
    const logPath = `/tmp/${mode}.log`;
    const launch = restore.normalizeRestoreLaunch({ command: mode === 'background' ? 'node app.mjs healthy & until test -f /workspace/launches; do sleep 0.01; done' : `node app.mjs ${mode}`, cwd: '/workspace',
      readiness: { port: 3000, path: '/health', timeoutMs: mode === 'timeout' ? 1000 : 10_000 } });
    const entrypoint = restore.restoreEntrypoint(launch, logPath);
    await docker('run', '--detach', '--platform', platform, '--name', name, '--label', `mainbrella.restore-smoke=${tag}`,
      '--publish', '127.0.0.1::3000', '--entrypoint', entrypoint[0], snapshot, ...entrypoint.slice(1));
    const port = Number((await docker('port', name, '3000/tcp')).split(':').at(-1));
    assert.ok(port > 0);
    const observedHttp = [], execCalls = [], values = new Map(), tasks = [];
    const at = Date.now();
    const metadata = { createdAt: at, telemetryId: randomUUID(), expiresAt: at + 60_000, idleExpiresAt: at + 60_000,
      size: 'lite', lifecycle: 'ad_hoc', readiness: { status: 'starting', port: 3000, path: '/health', logPath,
        deadlineAt: at + launch.readiness.timeoutMs } };
    values.set('builderMachine', metadata);
    const container = { running: true, images: { terminal: base },
      async exec(argv, options) { execCalls.push(argv); return nativeProcess(name, argv, options); },
      getTcpPort() { return { async fetch(request) {
        const response = await fetch(`http://127.0.0.1:${port}${new URL(request.url).pathname}`, { redirect: request.redirect, signal: request.signal });
        observedHttp.push(response.status); return response;
      } }; },
    };
    const storage = { async get(key) { return structuredClone(values.get(key)); }, async put(key, value) { values.set(key, structuredClone(value)); } };
    const controller = new UserContainerController({ container, storage, waitUntil(task) { tasks.push(task); } });
    controller.ensureRestoreReadiness(metadata);
    let bound;
    try { await Promise.race([Promise.all(tasks), new Promise((_, reject) => { bound = setTimeout(() => reject(Error('Local readiness observer exceeded its bound')), 20_000); })]); }
    finally { clearTimeout(bound); }
    const final = (await controller.status()).containers[0].readiness;
    assert.equal(final.status, mode === 'healthy' ? 'ready' : 'failed');
    if (mode === 'healthy') { assert.ok(observedHttp.includes(503)); assert.ok(observedHttp.includes(200)); }
    if (mode === 'failure') {
      assert.equal(final.error, 'launch_exited');
      assert.ok(final.logTail.includes('EXPECTED_STARTUP_FAILURE'), 'Expected final failure line in retained log tail');
      assert.ok(Buffer.byteLength(final.logTail) <= restore.MAX_RESTORE_LOG_BYTES);
    }
    if (mode === 'timeout') assert.equal(final.error, 'readiness_timeout');
    if (mode === 'background') assert.equal(final.error, 'launch_exited');
    const checksBefore = execCalls.length;
    for (let i = 0; i < 3; i++) await controller.status();
    assert.equal(execCalls.length, checksBefore, 'Final readiness checks must not relaunch or reobserve');
    const count = Number(await docker('exec', name, 'sh', '-c', 'wc -l < /workspace/launches'));
    assert.equal(count, 1);
    assert.equal((await docker('exec', name, 'sha256sum', '/workspace/app.mjs')).split(' ')[0], sourceHash);
    assert.equal(await docker('exec', name, 'cat', '/workspace/prepared'), 'prepared');
    const files = JSON.parse(await docker('exec', name, 'node', '-e', `const fs=require('node:fs');console.log(JSON.stringify(fs.readdirSync('/tmp').filter(n=>n.startsWith('${mode}.log')).map(n=>({name:n,bytes:fs.statSync('/tmp/'+n).size,file:fs.statSync('/tmp/'+n).isFile()}))))`));
    const storedLogBytes = files.filter(file => file.file).reduce((sum, file) => sum + file.bytes, 0);
    assert.ok(storedLogBytes <= 2 * 1024 * 1024 + 64, 'Owned diagnostic files exceeded two bounded log chunks');
    results.push({ mode, observedHttp, readiness: final.status, error: final.error ?? null, launchCount: count,
      restoredFilesMatch: true, outputRepresentation: 'native ArrayBuffer stdout/stderr', returnedLogTailBytes: Buffer.byteLength(final.logTail ?? ''),
      storedLogBytes, diagnosticFiles: files, elapsedMs: Date.now() - at });
  }
} catch (error) { failure = error instanceof Error ? error.stack : String(error); }
finally {
  for (const name of containers.reverse()) {
    try {
      const label = await docker('inspect', '--format', '{{index .Config.Labels "mainbrella.restore-smoke"}}', name);
      assert.equal(label, tag);
      await docker('rm', '--force', name); cleanup.push({ container: name, removed: true });
    } catch (error) { cleanup.push({ container: name, removed: false, error: String(error) }); }
  }
  if (snapshotCreated) {
    try {
      assert.equal(await docker('image', 'inspect', '--format', '{{index .Config.Labels "mainbrella.restore-smoke"}}', snapshot), tag);
      await docker('image', 'rm', snapshot); cleanup.push({ snapshot, removed: true });
    } catch (error) { cleanup.push({ snapshot, removed: false, error: String(error) }); }
  }
  const leftovers = await docker('ps', '--all', '--quiet', '--filter', `label=mainbrella.restore-smoke=${tag}`);
  const report = { schemaVersion: 1, kind: 'local-docker-restore-launch-smoke', startedAt, completedAt: new Date().toISOString(), baseImage: base,
    sourceSha256: hash(app), implementationSha256: hash(await readFile(new URL('../containers/restore-launch.js', import.meta.url))),
    scope: 'Real Linux image snapshot/filesystem and PID-1 recipe with real HTTP and exec output. Docker adapter, not Cloudflare runtime qualification.',
    results, cleanup, noOwnedContainersRemain: leftovers === '', passed: !failure && cleanup.every(record => record.removed) && leftovers === '', failure: failure ?? null };
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ directory, passed: report.passed, results, cleanupConfirmed: cleanup.every(record => record.removed), failure }));
  process.exitCode = report.passed ? 0 : 1;
}
