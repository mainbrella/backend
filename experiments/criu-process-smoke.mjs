// Run only inside a disposable Linux guest. This owns one test process and its
// checkpoint directory; it never checkpoints the sandbox supervisor or customers.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { inspectCheckpointSupport } from './checkpoint-support.mjs';

if (process.platform !== 'linux' || process.argv.length !== 4 || process.argv[2] !== '--output') {
  console.error('In a disposable Linux guest: node criu-process-smoke.mjs --output NEW_DIRECTORY');
  process.exit(2);
}
const directory = resolve(process.argv[3]);
await mkdir(directory, { mode: 0o700 });
const images = join(directory, 'images');
await mkdir(images, { mode: 0o700 });
const script = join(directory, 'worker.mjs');
const portFile = join(directory, 'port');
const restoredPidFile = join(directory, 'restored.pid');
const report = { kind: 'single-process-criu-smoke', startedAt: new Date().toISOString(),
  diagnostic: inspectCheckpointSupport(), status: 'failed', processRestoreVerified: false,
  crossContainerForkVerified: false, checks: {}, commands: [], cleanup: false };
const children = [];
let restoredIdentity;

await writeFile(script, `import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const nonce = randomUUID();
let jobs = [];
const server = createServer(async (req, res) => {
  if (req.url === '/prepare' && req.method === 'POST') {
    let text = ''; for await (const chunk of req) { text += chunk; if (text.length > 4096) { res.writeHead(413).end(); return; } }
    jobs = JSON.parse(text);
  }
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Connection', 'close');
  res.end(JSON.stringify({pid:process.pid, nonce, jobs}));
});
server.listen(0, '127.0.0.1', () => writeFileSync(process.argv[2], String(server.address().port)));
`);

// PID plus Linux start time fences cleanup against PID reuse. The executable
// argument must also identify this run's unique fixture file.
async function identity(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
  const command = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
  assert.ok(command.includes(script), 'Process is not this run\'s worker');
  return { pid, startTime: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] };
}
async function removeProcess(owned) {
  if (!owned) return;
  try {
    assert.deepEqual(await identity(owned.pid), owned);
    process.kill(owned.pid, 'SIGKILL');
  } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
  for (let i = 0; i < 100; i++) {
    try {
      const stat = await readFile(`/proc/${owned.pid}/stat`, 'utf8');
      if (stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] === 'Z') return;
    } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    await pause(20);
  }
  throw Error('Owned worker did not exit');
}
async function start() {
  const fd = openSync(join(directory, `worker-${children.length}.log`), 'wx', 0o600);
  let child;
  try { child = spawn(process.execPath, [script, portFile], { detached: true, stdio: ['ignore', fd, fd] }); }
  finally { closeSync(fd); }
  children.push(child);
  // Avoid an unhandled spawn error and bind cleanup before attempting HTTP.
  await new Promise((accept, reject) => { child.once('spawn', accept); child.once('error', reject); });
  child.ownedIdentity = await identity(child.pid);
  return child;
}
async function probe(expectedPid, jobs) {
  const deadline = Date.now() + 10_000;
  let last;
  while (Date.now() < deadline) {
    try {
      const port = Number(await readFile(portFile, 'utf8'));
      const response = await fetch(`http://127.0.0.1:${port}/${jobs ? 'prepare' : 'probe'}`, {
        method: jobs ? 'POST' : 'GET', ...(jobs ? { body: JSON.stringify(jobs) } : {}),
        headers: { Connection: 'close' }, signal: AbortSignal.timeout(500), redirect: 'error',
      });
      assert.equal(response.status, 200);
      const value = await response.json();
      assert.equal(value.pid, expectedPid);
      return value;
    } catch (error) { last = error; await pause(50); }
  }
  throw last ?? Error('Worker did not listen');
}
async function criu(name, args) {
  const log = join(directory, `${name}.log`);
  const result = spawnSync('criu', ['--no-default-config', ...args, '--log-file', log, '-v4'],
    { encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 });
  let details = '';
  try { details = (await readFile(log, 'utf8')).slice(-8192); } catch {}
  report.commands.push({ name, exitCode: result.status, signal: result.signal,
    error: result.error?.code ?? null, stderr: result.stderr?.slice(-8192) ?? '', logTail: details });
  return result.status === 0 && !result.error;
}
try {
  assert.ok(report.diagnostic.criuVersion, 'Install CRIU in the disposable guest before running this experiment');
  report.checks.kernelCheck = await criu('check', ['check']);
  // check includes facilities this simple workload does not use; preserve the
  // actual dump/restore result separately instead of inferring it from check.
  const source = await start();
  const jobs = Array.from({ length: 5 }, () => randomUUID());
  report.source = await probe(source.pid, jobs);
  assert.deepEqual(report.source.jobs, jobs);
  assert.ok(await criu('dump', ['dump', '--tree', String(source.pid), '--images-dir', images,
    '--leave-stopped', '--shell-job']), 'CRIU could not capture the owned worker');
  await removeProcess(source.ownedIdentity);
  await pause(100);
  assert.ok(await criu('restore', ['restore', '--images-dir', images, '--restore-detached',
    '--shell-job', '--pidfile', restoredPidFile]), 'CRIU could not restore the owned worker');
  restoredIdentity = await identity(Number(await readFile(restoredPidFile, 'utf8')));
  report.restored = await probe(restoredIdentity.pid);
  assert.deepEqual(report.restored, report.source);
  report.processRestoreVerified = true;
  await removeProcess(restoredIdentity);
  restoredIdentity = undefined;
  const cold = await start();
  report.coldRestart = await probe(cold.pid);
  assert.notEqual(report.coldRestart.nonce, report.source.nonce);
  assert.deepEqual(report.coldRestart.jobs, []);
  report.checks.coldRestartLosesState = true;
  report.status = 'completed';
} catch (error) { report.error = error.message; }
finally {
  try {
    // A failed CRIU restore can leave a root process behind. Its unique fixture
    // path and recorded start time are checked before attempting cleanup.
    if (!restoredIdentity) {
      try { restoredIdentity = await identity(Number(await readFile(restoredPidFile, 'utf8'))); }
      catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
    }
    await removeProcess(restoredIdentity);
    for (const child of children) await removeProcess(child.ownedIdentity);
    report.cleanup = true;
  } catch (error) { report.cleanupError = error.message; report.status = 'failed'; }
  report.finishedAt = new Date().toISOString();
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ status: report.status, processRestoreVerified: report.processRestoreVerified,
    crossContainerForkVerified: false, cleanup: report.cleanup, error: report.error ?? null }));
  process.exitCode = report.status === 'completed' && report.cleanup ? 0 : 1;
}
