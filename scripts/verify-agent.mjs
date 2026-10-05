import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Mainbrella } from '../sdk/javascript/index.js';

export async function verifyAgent(client, { catalogId = 'node', managed = true } = {}) {
  const creationKey = randomUUID();
  const report = { ok: false, creationKey, cleanup: 'not_needed', checks: {}, timings: {} };
  let sandbox;
  try {
    const start = performance.now();
    sandbox = await client.create({ catalogId, idempotencyKey: creationKey });
    report.timings.createMs = performance.now() - start;
    report.container = { id: sandbox.id, createdAt: sandbox.createdAt, imageDigest: sandbox.imageDigest ?? null, instance: sandbox.instance ?? null };
    const beforeExec = performance.now();
    const result = await sandbox.commands.run('printf mainbrella-probe', { timeoutMs: 30_000 });
    if (result.stdout !== 'mainbrella-probe' || result.exitCode !== 0 || result.timedOut || result.outputTruncated) throw new Error('execution_failed');
    report.checks.execution = true; report.timings.execMs = performance.now() - beforeExec;
    const bytes = new Uint8Array([0, 1, 127, 128, 255]);
    const path = `/tmp/mainbrella-probe-${creationKey}.bin`;
    await sandbox.files.write(path, bytes);
    const read = await sandbox.files.read(path);
    if (read.length !== bytes.length || read.some((byte, index) => byte !== bytes[index])) throw new Error('files_failed');
    report.checks.files = true;
    if (managed) {
      const execution = await sandbox.commands.start('printf mainbrella-managed', { timeoutMs: 30_000 });
      let output = '', terminal;
      for await (const event of execution.events()) {
        if (event.type === 'stdout') output += event.data;
        if (event.type === 'status') terminal = event.execution;
      }
      if (output !== 'mainbrella-managed' || terminal?.status !== 'succeeded') throw new Error('managed_failed');
      report.checks.managedExecution = true;
    }
  } catch (error) {
    report.error = typeof error.code === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(error.code) ? error.code
      : ['execution_failed', 'files_failed', 'managed_failed'].includes(error.message) ? error.message : 'verification_failed';
    if (!sandbox) report.cleanup = 'reconcile_manually';
  } finally {
    if (sandbox) {
      try { await sandbox.kill(); report.cleanup = 'completed'; }
      catch { report.cleanup = 'failed'; }
    }
  }
  report.ok = !report.error && report.cleanup === 'completed';
  return report;
}

export async function preflight(client, { samples = 1, concurrency = 1, catalogId = 'node', managed = true } = {}) {
  if (!Number.isInteger(samples) || samples < 1 || samples > 100 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > samples) throw new Error('invalid_probe_budget');
  const capabilities = await client.capabilities();
  if (!capabilities.execution.foreground || !capabilities.files.read || !capabilities.files.write
    || managed && (!capabilities.execution.background || !capabilities.execution.streaming)) throw new Error('capability_missing');
  const account = await client.list();
  if (!account.active || !account.imageCatalog?.some(image => image.id === catalogId)) throw new Error('account_not_ready');
  if (account.limits.maxStartsPerMonth - account.usage.starts < samples) throw new Error('insufficient_start_budget');
  if (account.limits.maxContainers - account.containers.length < concurrency) throw new Error('insufficient_concurrency');
  return { capabilities, account };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2) throw new Error('invalid_arguments');
    const client = new Mainbrella({ apiKey: process.env.MAINBRELLA_API_KEY, baseUrl: process.env.MAINBRELLA_API_URL });
    const options = { catalogId: process.env.MAINBRELLA_CATALOG_ID || 'node' };
    await preflight(client, options);
    const report = await verifyAgent(client, options);
    console.log(JSON.stringify(report, null, 2)); process.exitCode = report.ok ? 0 : 1;
  } catch { console.error('Agent verification could not run. Check credentials, capabilities and account budget.'); process.exitCode = 1; }
}
