import { randomUUID } from 'node:crypto';
import { writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const required = {
  containers: ['idempotentCreate', 'generationRequired'],
  execution: ['foreground', 'background', 'streaming', 'reconnect', 'cancellation'],
  files: ['read', 'write', 'binary'],
};
const same = (a, b) => a.id === b.id && a.createdAt === b.createdAt;
const validIdentity = value => /^(small|c[1-9]\d{0,2})$/.test(value?.id ?? '')
  && typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt))
  && new Date(value.createdAt).toISOString() === value.createdAt;

// All checks before creation are reads. The two languages run sequentially.
export async function deploymentPreflight(client, { starts = 1, catalogId = 'node' } = {}) {
  if (![1, 2].includes(starts)) throw new Error('invalid_start_budget');
  const capabilities = await client.capabilities();
  if (typeof capabilities?.apiVersion !== 'string' || !/^[\w.-]{1,80}$/.test(capabilities.apiVersion)
    || !Object.entries(required).every(([group, names]) => names.every(name => capabilities[group]?.[name] === true))) {
    throw new Error('capability_missing');
  }
  const account = await client.list();
  const { limits, usage } = account;
  if (account.active !== true || !Array.isArray(account.containers) || !account.containers.every(validIdentity)
    || !account.imageCatalog?.some(image => image.id === catalogId)
    || ![limits?.maxStartsPerMonth, limits?.maxContainers, usage?.starts].every(value => Number.isSafeInteger(value) && value >= 0)
    || limits.maxStartsPerMonth - usage.starts < starts || limits.maxContainers <= account.containers.length
    || !Number.isFinite(usage.availableComputeUnitHours) || usage.availableComputeUnitHours <= 0
    || !Number.isFinite(usage.concurrentComputeUnits) || usage.concurrentComputeUnits < 0 || !Number.isFinite(limits.maxConcurrentComputeUnits)
    || usage.concurrentComputeUnits + 1 > limits.maxConcurrentComputeUnits) throw new Error('account_not_ready');
  return { apiVersion: capabilities.apiVersion, existing: account.containers.map(({ id, createdAt }) => ({ id, createdAt })) };
}

export async function verifyDeployedSDK(client, { catalogId = 'node', starts = 1, checkpoint = async () => {} } = {}) {
  const report = { ok: false, language: 'javascript', runtime: process.version, cleanup: 'not_needed', checks: {}, stage: 'preflight' };
  let sandbox;
  const save = () => checkpoint(structuredClone(report));
  try {
    const before = await deploymentPreflight(client, { starts, catalogId });
    report.apiVersion = before.apiVersion;
    report.preexisting = before.existing;
    report.creationKey = randomUUID();
    report.stage = 'create';
    report.cleanup = 'reconcile_manually';
    await save(); // Save the recovery key before a request can consume a start.
    const candidate = await client.create({ catalogId, size: 'lite', idempotencyKey: report.creationKey });
    report.container = { id: candidate.id, createdAt: candidate.createdAt };
    if (before.existing.some(previous => same(previous, candidate))) throw new Error('preexisting_generation');
    sandbox = candidate;
    if (candidate.instance !== 'lite') throw new Error('resource_unconfirmed');
    report.cleanup = 'pending';
    report.stage = 'idempotency';
    await save();
    const replay = await client.create({ catalogId, size: 'lite', idempotencyKey: report.creationKey });
    if (!same(sandbox, replay)) {
      report.unexpectedGeneration = { id: replay.id, createdAt: replay.createdAt };
      throw new Error('idempotency_failed');
    }
    report.checks.idempotentAdmission = true;
    report.stage = 'foreground'; await save();
    const result = await sandbox.commands.run('printf mainbrella-probe; printf mainbrella-stderr >&2', { timeoutMs: 30_000 });
    if (result.stdout !== 'mainbrella-probe' || result.stderr !== 'mainbrella-stderr'
      || result.exitCode !== 0 || result.timedOut !== false || result.outputTruncated !== false) throw new Error();
    report.checks.stdoutStderr = true;
    report.stage = 'files'; await save();
    const bytes = new Uint8Array([0, 1, 127, 128, 255, 10]);
    const path = `/tmp/mainbrella-sdk-${report.creationKey}.bin`;
    await sandbox.files.write(path, bytes);
    const read = await sandbox.files.read(path);
    if (read.length !== bytes.length || read.some((byte, index) => byte !== bytes[index])) throw new Error();
    report.checks.binaryFiles = true;
    report.stage = 'managed'; report.executionKey = randomUUID(); await save();
    const job = await sandbox.commands.start('printf mainbrella-managed; printf mainbrella-managed-err >&2', {
      timeoutMs: 30_000, idempotencyKey: report.executionKey,
    });
    report.executionId = job.id; await save();
    // Deliberately close after one output event, then attach from its cursor.
    let stdout = '', stderr = '', terminal, cursor = 0;
    for await (const event of job.events()) {
      if (event.type === 'status') { terminal = event.execution; continue; }
      if (!['stdout', 'stderr'].includes(event.type)) throw new Error();
      if (event.type === 'stdout') stdout += event.data; else stderr += event.data;
      if (stdout.length + stderr.length > 1024) throw new Error();
      cursor = job.cursor;
      break;
    }
    if (!Number.isSafeInteger(cursor) || cursor < 1) throw new Error();
    report.reconnectCursor = cursor; await save();
    const attached = sandbox.commands.attach(job.id);
    for await (const event of attached.events({ cursor })) {
      if (event.type === 'status') terminal = event.execution;
      else if (event.type === 'stdout') stdout += event.data;
      else if (event.type === 'stderr') stderr += event.data;
      else throw new Error();
      if (stdout.length + stderr.length > 1024) throw new Error();
    }
    const complete = await attached.get();
    if (stdout !== 'mainbrella-managed' || stderr !== 'mainbrella-managed-err' || terminal?.status !== 'succeeded'
      || complete.status !== 'succeeded' || complete.stdout !== stdout || complete.stderr !== stderr
      || complete.exitCode !== 0 || complete.timedOut !== false || complete.outputTruncated !== false) throw new Error();
    report.checks.managedReconnect = true;
    report.stage = 'cancellation'; report.cancellationKey = randomUUID(); await save();
    const long = await sandbox.commands.start('exec sleep 30', { timeoutMs: 30_000, idempotencyKey: report.cancellationKey });
    report.cancellationId = long.id; await save();
    await long.cancel();
    if ((await long.wait({ timeoutMs: 45_000 })).status !== 'canceled') throw new Error();
    report.checks.cancellation = true;
  } catch {
    report.error = `${report.stage}_failed`;
  } finally {
    if (sandbox) {
      try {
        report.stage = 'cleanup'; await save();
      } finally {
        // Attempt cleanup even if the evidence disk became unavailable.
        try {
          await sandbox.kill();
          const after = await client.list();
          if (!Array.isArray(after.containers) || after.containers.some(c => same(c, sandbox))) throw new Error();
          report.cleanup = 'completed';
        } catch { report.cleanup = 'failed'; }
      }
    }
  }
  report.stage = 'finished';
  report.ok = !report.error && report.cleanup === 'completed';
  await save();
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { Mainbrella } = await import('@mainbrella/sdk');
    const output = process.env.MAINBRELLA_SDK_REPORT;
    const checkpoint = async report => {
      await writeFile(`${output}.tmp`, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
      await rename(`${output}.tmp`, output);
    };
    const client = new Mainbrella({ apiKey: process.env.MAINBRELLA_API_KEY, baseUrl: process.env.MAINBRELLA_API_URL });
    const report = await verifyDeployedSDK(client, { checkpoint,
      starts: 2, catalogId: process.env.MAINBRELLA_CATALOG_ID || 'node' });
    process.exitCode = report.ok ? 0 : 1;
  } catch { process.exitCode = 1; }
}
