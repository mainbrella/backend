import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { Mainbrella } from '../sdk/javascript/index.js';
import { deploymentPreflight } from './sdk-deployed-workflow.mjs';
import { receiverClient, RECEIVER_ORIGIN } from './qualify-webhook-receiver.mjs';
import { connectPreviewSocket, validatePreview } from './verify-previews.mjs';
import { previewHtml } from './preview-app.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const requireCheck = value => { if (!value) throw new Error('check_failed'); };
const same = (a, b) => a.id === b.id && a.createdAt === b.createdAt;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const probes = ['dnsA', 'dnsAAAA', 'dnsTXT', 'publicHttp', 'publicHttps', 'hostnameHttps', 'directIpv4', 'directIpv6', 'alternateTcpPort', 'udpDns'];
export function compareNetworkControls(online, offline) {
  requireCheck(online?.uid === 0 && offline?.uid === 0 && probes.every(name => typeof online.results?.[name] === 'boolean' && typeof offline.results?.[name] === 'boolean'));
  const unsupportedControls = probes.filter(name => !online.results[name]);
  const verifiedDenials = probes.filter(name => online.results[name] && !offline.results[name]);
  const bypasses = probes.filter(name => offline.results[name]);
  return { ok: !bypasses.length && verifiedDenials.length >= 8, verifiedDenials, unsupportedControls, bypasses };
}
async function until(operation, predicate, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = await operation(); if (predicate(value)) return value; await wait(1000); }
  throw new Error('probe_timeout');
}
async function expectedFailure(operation, status) {
  try { await operation(); } catch (error) { requireCheck(error.status === status); return; }
  throw new Error('unexpected_success');
}
async function guestNetwork(sandbox, source) {
  const path = '/tmp/mainbrella-job3-network.mjs'; await sandbox.files.write(path, new TextEncoder().encode(source));
  const result = await sandbox.commands.run(`node ${path}`, { timeoutMs: 20_000 });
  requireCheck(result.exitCode === 0 && !result.timedOut && !result.outputTruncated && result.stdout.length < 4096);
  const evidence = JSON.parse(result.stdout); requireCheck(probes.every(name => typeof evidence.results?.[name] === 'boolean'));
  return evidence;
}
export async function accessChecks(sandbox, secondary, appSource, checks, { webhooks = true } = {}) {
  const bytes = new Uint8Array([0, 1, 127, 128, 255, 10]);
  await sandbox.files.write('/tmp/mainbrella-job3.bin', bytes);
  requireCheck(Buffer.from(await sandbox.files.read('/tmp/mainbrella-job3.bin')).equals(Buffer.from(bytes))); checks.binaryFiles = true;
  // Wait for EOF before exiting so close cannot race a command that already consumed one line.
  const stdin = await sandbox.commands.start(['bash', '-lc', 'input=$(cat); printf "stdin:%s" "$input"'], { stdin: true, timeoutMs: 30_000 });
  await until(() => stdin.get(), job => job.status === 'running', 15_000);
  await stdin.stdin.write(new TextEncoder().encode('mainbrella-job3\n')); await stdin.stdin.close();
  const input = await stdin.wait({ timeoutMs: 15_000 }); requireCheck(input.status === 'succeeded' && input.stdout === 'stdin:mainbrella-job3'); checks.stdin = true;
  const pty = await sandbox.commands.start(['bash', '-lc', 'printf mainbrella-job3-pty; exec sleep 30'], { stdin: true, pty: { cols: 80, rows: 24 }, timeoutMs: 30_000 });
  await until(() => pty.get(), job => job.status === 'running' && job.stdout.includes('mainbrella-job3-pty'), 15_000);
  await pty.resize(100, 30); await pty.signal('SIGTERM');
  requireCheck(!['starting', 'running'].includes((await pty.wait({ timeoutMs: 15_000 })).status)); checks.nativePtyResizeSignal = true;
  const canceled = await sandbox.commands.start(['sleep', '30'], { timeoutMs: 30_000 }); await canceled.cancel();
  requireCheck((await canceled.wait({ timeoutMs: 15_000 })).status === 'canceled'); checks.cancellation = true;
  await expectedFailure(() => secondary.request(sandbox.path('/containers/events')), 404); checks.crossAccountHistory = true;
  if (webhooks) {
    const foreign = await secondary.request(sandbox.path('/containers/webhook')); requireCheck(foreign.webhook === null); checks.crossAccountWebhook = true;
  }
  const appPath = '/tmp/mainbrella-job3-preview.mjs'; await sandbox.files.write(appPath, new TextEncoder().encode(appSource));
  const app = await sandbox.commands.start(['node', appPath], { timeoutMs: 180_000 });
  await until(() => app.get(), job => job.status === 'running' && job.stdout.includes('mainbrella-preview-ready'), 15_000);
  const local = await sandbox.commands.run('curl --max-time 5 -fsS http://127.0.0.1:3000/', { timeoutMs: 10_000 });
  requireCheck(local.exitCode === 0 && local.stdout === previewHtml); checks.loopback = true;
  const grant = await sandbox.previews.create(3000, { ttlSeconds: 300 }); const url = validatePreview(grant, sandbox, 'mainbrella.dev', Date.now());
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
  requireCheck(response.status === 200 && await response.text() === previewHtml); checks.previewHttp = true;
  const connection = await connectPreviewSocket(url); checks.previewWebSocket = true;
  await sandbox.previews.revoke(grant.id); await Promise.race([connection.closed, wait(10_000).then(() => { throw new Error('socket_not_revoked'); })]);
  checks.previewRevocation = true;
}

export async function verifyJob3(client, { secondary, receiverRequest, networkSource, appSource, previous, maxStarts = 2, mode = 'combined', checkpoint = async () => {}, exerciseAccess = accessChecks, exerciseNetwork = guestNetwork } = {}) {
  const webhooks = mode === 'combined';
  const report = { formatVersion: 1, mode, ok: false, releaseQualified: false, maxStarts, startsRequested: 0,
    stage: 'preflight', cleanup: 'not_needed', checks: {}, generations: [], receiverRuns: [],
    pendingGates: ['browser_terminal_tmux_and_ssh_compatibility', 'replacement_generation_fencing',
      'runtime_upgrade_downgrade', 'lifecycle_expiry_retention_and_disabled_policy_cleanup',
      ...(webhooks ? ['dedicated_metrics_token_and_deployed_metrics', 'webhook_restart_lease_recovery_and_inflight_removal'] : [])] };
  const save = () => checkpoint(structuredClone(report));
  let sandbox, online, offline;
  try {
    requireCheck(['combined', 'network'].includes(mode) && [2, 3].includes(maxStarts) && (maxStarts === 2 || previous));
    const capabilities = await client.capabilities();
    requireCheck(capabilities.networking?.internetControl && capabilities.previews?.supported
      && (!webhooks || capabilities.observability?.webhooks));
    const before = await deploymentPreflight(client, { starts: previous ? 1 : 2 }); report.preexisting = before.existing;
    const usage = { primary: (await client.list()).usage.starts, secondary: (await secondary.list()).usage.starts };
    report.before = usage;
    if (previous) {
      requireCheck((previous.mode ?? 'combined') === mode && previous.ok === false && [2, 3].includes(previous.maxStarts) && [1, 2].includes(previous.startsRequested)
        && previous.startsRequested < maxStarts && previous.cleanup === 'completed'
        && previous.generations?.length === previous.startsRequested && previous.generations[0].internet === true
        && previous.generations.every(generation => generation.cleanup === 'completed')
        && previous.generations[0].network?.uid === 0 && probes.every(name => previous.generations[0].network.results?.[name] === true)
        && usage.primary === previous.before?.primary + previous.startsRequested && usage.secondary === previous.before?.secondary
        && before.existing.length === previous.preexisting?.length && before.existing.every(current => previous.preexisting.some(old => same(current, old))));
      report.generations = structuredClone(previous.generations); report.startsRequested = previous.startsRequested; report.before = previous.before;
      online = previous.generations[0].network; report.reusedOnlineControl = true;
    }
    await save();
    for (const internet of previous ? [false] : [true, false]) {
      requireCheck(report.startsRequested < report.maxStarts);
      const generation = { internet, creationKey: randomUUID(), cleanup: 'reconcile_manually', checks: {} };
      report.generations.push(generation); report.startsRequested++; report.stage = internet ? 'online_create' : 'offline_create'; report.cleanup = 'pending'; await save();
      const created = await client.create({ catalogId: 'node', size: 'lite', internet, idempotencyKey: generation.creationKey });
      requireCheck(!before.existing.some(previous => same(previous, created))); sandbox = created;
      generation.container = { id: sandbox.id, createdAt: sandbox.createdAt, imageDigest: sandbox.imageDigest, instance: sandbox.instance };
      generation.cleanup = 'pending'; requireCheck(sandbox.instance === 'lite' && sandbox.internet === internet); await save();
      const replay = await client.create({ catalogId: 'node', size: 'lite', internet, idempotencyKey: generation.creationKey }); requireCheck(same(replay, sandbox));
      await expectedFailure(() => client.create({ catalogId: 'node', size: 'lite', internet: !internet, idempotencyKey: generation.creationKey }), 409);
      generation.checks.idempotencyAndPolicyConflict = true;
      const history = await sandbox.events(); requireCheck(history.events.some(event => event.type === 'starting') && history.events.some(event => event.type === 'started'));
      generation.checks.lifecycleReadiness = true;
      report.stage = internet ? 'online_network' : 'offline_network'; await save();
      const network = await exerciseNetwork(sandbox, networkSource); generation.network = network;
      if (internet) online = network; else offline = network;
      if (online && offline) {
        report.networkComparison = compareNetworkControls(online, offline); await save();
        requireCheck(report.networkComparison.ok); report.checks.networkDenial = true;
      }
      const npm = await sandbox.commands.run('npm view npm version --fetch-retries=0 --fetch-timeout=3000', { timeoutMs: 15_000 });
      generation.packageManager = { exitCode: npm.exitCode, timedOut: npm.timedOut, outputTruncated: npm.outputTruncated };
      await save();
      requireCheck(typeof npm.timedOut === 'boolean' && (internet ? npm.exitCode === 0 && !npm.timedOut : npm.timedOut || npm.exitCode !== null && npm.exitCode !== 0));
      generation.checks.packageManager = true;
      if (npm.timedOut && !report.pendingGates.includes('offline_package_manager_dns_failure_latency')) report.pendingGates.push('offline_package_manager_dns_failure_latency');
      report.stage = internet ? 'online_access' : 'offline_access'; await save();
      await exerciseAccess(sandbox, secondary, appSource, generation.checks, { webhooks });
      let receiver;
      if (webhooks) {
        report.stage = 'webhook_configure'; const runId = randomUUID(); report.receiverRuns.push(runId); await save();
        const config = await sandbox.webhook.configure(`${RECEIVER_ORIGIN}/receive/${runId}`, { replayFromCursor: 0 });
        requireCheck(/^mbwh_[a-f0-9]{64}$/.test(config.signingSecret));
        requireCheck((await receiverRequest(`/admin/${runId}`, { method: 'PUT', body: { signingSecret: config.signingSecret,
          container: { id: sandbox.id, createdAt: sandbox.createdAt }, failFirst: true } })).status === 200);
        receiver = runId;
        report.stage = 'webhook_delivery_retry'; await save();
        const delivered = await until(() => sandbox.webhook.deliveries(), result => result.deliveries.length >= 2 && result.deliveries.every(item => item.status === 'delivered'), 90_000);
        const accepted = await receiverRequest(`/admin/${runId}`);
        requireCheck(accepted.status === 200 && accepted.value.events.some(event => event.type === 'starting')
          && accepted.value.events.some(event => event.type === 'started') && accepted.value.transientFailures === 1
          && delivered.deliveries.some(item => item.attempts >= 2)); report.checks.privateOutboxSignatureRetry = true;
        const rotation = await sandbox.webhook.configure(`${RECEIVER_ORIGIN}/receive/${runId}`, { replayFromCursor: 0 });
        requireCheck(rotation.signingSecret !== config.signingSecret);
        requireCheck((await receiverRequest(`/admin/${runId}`, { method: 'PUT', body: { signingSecret: rotation.signingSecret,
          container: { id: sandbox.id, createdAt: sandbox.createdAt }, failFirst: false } })).status === 200);
        await until(() => sandbox.webhook.deliveries(), result => result.deliveries.length >= 2 && result.deliveries.every(item => item.status === 'delivered'), 60_000);
        report.checks.privateOutboxRotation = true;
      }
      report.stage = internet ? 'online_stop' : 'offline_stop'; await save(); await sandbox.kill();
      requireCheck(!(await client.list()).containers.some(current => same(current, sandbox))); generation.cleanup = 'completed';
      const stopped = await sandbox.events(); requireCheck(stopped.events.some(event => event.type === 'stopped')); generation.checks.retainedStopHistory = true;
      if (receiver) {
        await until(() => receiverRequest(`/admin/${receiver}`), result => result.status === 200 && result.value.events.some(event => event.type === 'stopped'), 60_000);
        report.checks.deliveryAfterComputeStop = true;
        await sandbox.webhook.remove(); requireCheck((await sandbox.webhook.get()).webhook === null && !(await sandbox.webhook.deliveries()).deliveries.length);
        report.checks.webhookRemoval = true;
      }
      sandbox = undefined;
    }
    report.stage = 'network_comparison'; report.networkComparison = compareNetworkControls(online, offline); requireCheck(report.networkComparison.ok);
    report.checks.networkDenial = true;
    if (report.networkComparison.unsupportedControls.length) report.pendingGates.push('unreachable_online_network_controls');
    const after = await client.list(), secondaryAfter = await secondary.list();
    requireCheck(after.usage.starts === report.before.primary + report.startsRequested && secondaryAfter.usage.starts === report.before.secondary);
    requireCheck(after.containers.length === report.preexisting.length && report.preexisting.every(previous => after.containers.some(current => same(previous, current))));
    report.checks.boundedStartsAndPreservedContainers = true; report.cleanup = 'completed';
  } catch {
    report.error = `${report.stage}_failed`;
    // Capture bounded, credential-free diagnostics before cleanup erases the outbox.
    if (sandbox && report.stage.startsWith('webhook_')) {
      try {
        const result = await sandbox.webhook.deliveries();
        report.webhookFailure = { deliveries: result.deliveries.slice(0, 64).map(({ id, sequence, status, attempts, httpStatus, nextAt }) =>
          ({ id, sequence, status, attempts, httpStatus, nextAt })) };
      } catch { report.webhookFailure = { unavailable: true }; }
      const runId = report.receiverRuns.at(-1);
      if (runId) try {
        const result = await receiverRequest(`/admin/${runId}`);
        const { received, invalidSignatures, transientFailures, duplicates, outOfOrder } = result.value ?? {};
        report.webhookFailure.receiver = { status: result.status, received, invalidSignatures, transientFailures, duplicates, outOfOrder };
      } catch { report.webhookFailure.receiver = { unavailable: true }; }
      await save();
    }
  }
  finally {
    if (sandbox) {
      if (webhooks) try { await sandbox.webhook.remove(); } catch {}
      try { await sandbox.kill(); requireCheck(!(await client.list()).containers.some(current => same(current, sandbox))); report.generations.at(-1).cleanup = 'completed'; report.cleanup = 'completed'; }
      catch { report.cleanup = 'failed'; }
    }
    for (const runId of report.receiverRuns) {
      try { requireCheck((await receiverRequest(`/admin/${runId}`, { method: 'DELETE' })).status === 200 && (await receiverRequest(`/admin/${runId}`)).status === 404); }
      catch { report.cleanup = 'failed'; }
    }
  }
  report.ok = !report.error && report.cleanup === 'completed'; report.stage = 'finished'; await save(); return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = {};
    for (const arg of process.argv.slice(2)) {
      const match = /^--(output|max-starts|secret-file|api-version|runtime-version|resume-report|mode)=(.+)$/.exec(arg);
      requireCheck(match && !Object.hasOwn(options, match[1])); options[match[1]] = match[2];
    }
    const mode = options.mode ?? 'combined';
    requireCheck(['combined', 'network'].includes(mode) && options.output && ['2', '3'].includes(options['max-starts']) && (options['max-starts'] === '2' || options['resume-report']) && (mode === 'network' || options['secret-file'])
      && ['api-version', 'runtime-version'].every(name => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(options[name] ?? '')));
    const env = { ...parseEnv(await readFile(join(root, '.env'), 'utf8')), ...process.env };
    const client = new Mainbrella({ apiKey: env.MAINBRELLA_API_KEY, timeoutMs: 25_000 });
    const secondary = new Mainbrella({ apiKey: env.MAINBRELLA_API_KEY2, timeoutMs: 25_000 });
    const request = mode === 'combined' ? receiverClient(parseEnv(await readFile(resolve(options['secret-file']), 'utf8')).QUALIFICATION_RECEIVER_TOKEN) : undefined;
    let previous, previousReportSha256;
    if (options['resume-report']) {
      const bytes = await readFile(resolve(options['resume-report'])); previous = JSON.parse(bytes);
      requireCheck(previous.deploymentVersions?.api === options['api-version'] && previous.deploymentVersions?.runtime === options['runtime-version']);
      previousReportSha256 = createHash('sha256').update(bytes).digest('hex');
    }
    const output = resolve(options.output); await mkdir(dirname(output), { recursive: true }); await mkdir(output, { mode: 0o700 });
    const sources = await Promise.all(['scripts/verify-job3.mjs', 'scripts/network-guest-probe.mjs', 'scripts/preview-app.mjs', 'sdk/javascript/index.js'].map(async path =>
      ({ path, sha256: createHash('sha256').update(await readFile(join(root, path))).digest('hex') })));
    if (previous) for (const path of ['scripts/network-guest-probe.mjs', 'sdk/javascript/index.js']) {
      requireCheck(previous.sources?.find(source => source.path === path)?.sha256 === sources.find(source => source.path === path).sha256);
    }
    const startedAt = new Date().toISOString();
    const checkpoint = async report => {
      const path = join(output, 'job3-verification.json');
      await writeFile(path + '.tmp', JSON.stringify({ ...report, startedAt, sources, previousReportSha256,
        deploymentVersions: { api: options['api-version'], runtime: options['runtime-version'], source: 'operator_supplied' } }, null, 2) + '\n', { mode: 0o600 });
      await rename(path + '.tmp', path);
    };
    const report = await verifyJob3(client, { secondary, receiverRequest: request, checkpoint, previous, mode, maxStarts: Number(options['max-starts']),
      networkSource: await readFile(join(root, 'scripts/network-guest-probe.mjs'), 'utf8'), appSource: await readFile(join(root, 'scripts/preview-app.mjs'), 'utf8') });
    console.log(JSON.stringify({ mode: report.mode, ok: report.ok, releaseQualified: false, cleanup: report.cleanup, startsRequested: report.startsRequested,
      checks: report.checks, networkComparison: report.networkComparison, error: report.error, pendingGates: report.pendingGates }));
    if (!report.ok) process.exitCode = 1;
  } catch { console.error('Use --output=NEW_DIR --max-starts=2 --api-version=UUID --runtime-version=UUID, with --secret-file=FILE for combined mode or --mode=network. Check the private recovery report after interruptions; do not rerun with new creation keys.'); process.exitCode = 1; }
}
