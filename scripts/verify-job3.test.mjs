import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { validExecution } from '../containers/execution-contract.js';
import { accessChecks, compareNetworkControls, verifyJob3 } from './verify-job3.mjs';

const names = ['dnsA', 'dnsAAAA', 'dnsTXT', 'publicHttp', 'publicHttps', 'hostnameHttps', 'directIpv4', 'directIpv6', 'alternateTcpPort', 'udpDns'];
const network = value => ({ uid: 0, results: Object.fromEntries(names.map(name => [name, value])) });
test('an unreachable control never counts as a denial, and any offline success fails the comparison', () => {
  const online = network(true), offline = network(false);
  assert.equal(compareNetworkControls(online, offline).ok, true);
  online.results.directIpv6 = false;
  const partial = compareNetworkControls(online, offline);
  assert.deepEqual(partial.unsupportedControls, ['directIpv6']);
  assert.equal(partial.verifiedDenials.includes('directIpv6'), false);
  offline.results.udpDns = true;
  assert.equal(compareNetworkControls(online, offline).ok, false);
  assert.throws(() => compareNetworkControls({}, {}));
});
function fixture({ enabled = true, webhooksEnabled = enabled, failCreate = false, failCleanup = false, failAccess = false, failWebhook = false, npmTimedOut = false } = {}) {
  const previous = { id: 'c1', createdAt: '2026-10-01T00:00:00.000Z' }, admitted = new Map();
  const calls = [], checkpoints = [], receivers = new Map(); let active, starts = 3, keys = 0, webhook;
  const list = async () => ({ active: true, containers: [previous, ...(active ? [active] : [])], imageCatalog: [{ id: 'node' }],
    limits: { maxStartsPerMonth: 100, maxContainers: 5, maxConcurrentComputeUnits: 28 },
    usage: { starts, availableComputeUnitHours: 100, concurrentComputeUnits: 0 } });
  const capabilities = async () => ({ apiVersion: '2026-10-05', networking: { internetControl: enabled }, observability: { webhooks: webhooksEnabled }, previews: { supported: true },
    containers: { idempotentCreate: true, generationRequired: true }, execution: { foreground: true, background: true, streaming: true, reconnect: true, cancellation: true },
    files: { read: true, write: true, binary: true } });
  const client = { list, capabilities, async create({ internet, idempotencyKey }) {
    const cached = admitted.get(idempotencyKey);
    if (cached) { if (cached.internet !== internet) throw Object.assign(new Error('conflict'), { status: 409 }); return cached; }
    calls.push('create');
    if (failCreate) throw new Error('credential-must-not-leak');
    starts++;
    active = { id: 'small', createdAt: new Date(Date.parse('2026-10-05T12:00:00Z') + starts * 1000).toISOString(), internet, instance: 'lite' };
    const identity = active;
    let stopped = false;
    const sandbox = { ...identity,
      commands: { run: async () => ({ exitCode: internet ? 0 : npmTimedOut ? null : 1, timedOut: !internet && npmTimedOut }) },
      events: async () => ({ events: [{ type: 'starting' }, { type: 'started' }, ...(stopped ? [{ type: 'stopped' }] : [])] }),
      async kill() { calls.push('kill'); if (failCleanup) throw new Error('cleanup'); active = undefined; stopped = true; },
      webhook: { configure: async () => { if (failWebhook) { webhook = {}; throw new Error('credential-must-not-leak'); } webhook = {}; return { signingSecret: 'mbwh_' + String(++keys).repeat(64) }; },
        deliveries: async () => ({ deliveries: webhook ? [{ status: 'delivered', attempts: 2 }, { status: 'delivered', attempts: 1 }] : [] }),
        remove: async () => { calls.push('webhook_remove'); webhook = null; }, get: async () => ({ webhook }) } };
    admitted.set(idempotencyKey, sandbox); return sandbox;
  } };
  const secondary = { list: async () => ({ usage: { starts: 0 } }) };
  const receiverRequest = async (path, { method = 'GET' } = {}) => {
    if (method === 'DELETE') { receivers.set(path, false); return { status: 200 }; }
    if (method === 'PUT') { receivers.set(path, true); return { status: 200 }; }
    return receivers.get(path) ? { status: 200, value: { transientFailures: 1, events: [{ type: 'starting' }, { type: 'started' }, { type: 'stopped' }] } } : { status: 404 };
  };
  return { client, calls, checkpoints, options: { secondary, receiverRequest,
    exerciseAccess: async () => { if (failAccess) throw new Error('credential-must-not-leak'); },
    exerciseNetwork: async sandbox => network(sandbox.internet), checkpoint: async report => { checkpoints.push(report); } } };
}
test('disabled capabilities spend no starts and successful runs preserve preexisting guests and record recovery before admission', async () => {
  const disabled = fixture({ enabled: false }); const rejected = await verifyJob3(disabled.client, disabled.options);
  assert.equal(rejected.ok, false); assert.equal(rejected.startsRequested, 0); assert.deepEqual(disabled.calls, []);
  const f = fixture(); const report = await verifyJob3(f.client, f.options);
  assert.equal(report.ok, true); assert.equal(report.releaseQualified, false); assert.equal(report.cleanup, 'completed');
  assert.equal(report.startsRequested, 2); assert.equal(f.calls.filter(call => call === 'create').length, 2);
  assert.equal((await f.client.list()).containers.length, 1);
  for (const generation of report.generations) assert.ok(f.checkpoints.some(saved => saved.generations.some(item => item.creationKey === generation.creationKey && !item.container)));
});
test('first-run failures and unconfirmed cleanup prohibit a second admission and redact provider diagnostics', async () => {
  for (const failure of [{ failCreate: true }, { failAccess: true }, { failCleanup: true }]) {
    const f = fixture(failure), report = await verifyJob3(f.client, f.options);
    assert.equal(report.ok, false); assert.equal(report.startsRequested, 1);
    assert.equal(f.calls.filter(call => call === 'create').length, 1);
    assert.equal(JSON.stringify(report).includes('credential-must-not-leak'), false);
    if (failure.failCleanup) assert.equal(report.cleanup, 'failed');
  }
});
test('resumption reuses a cleaned positive online control and permits only the remaining start', async () => {
  const f = fixture({ failAccess: true }); const previous = await verifyJob3(f.client, f.options);
  const report = await verifyJob3(f.client, { ...f.options, previous, exerciseAccess: async () => {} });
  assert.equal(report.ok, true); assert.equal(report.reusedOnlineControl, true);
  assert.equal(report.startsRequested, 2); assert.equal(f.calls.filter(call => call === 'create').length, 2);
  const rejected = await verifyJob3(f.client, { ...f.options, previous, exerciseAccess: async () => {} });
  assert.equal(rejected.ok, false); assert.equal(f.calls.filter(call => call === 'create').length, 2);
});
test('the access probe waits for stdin EOF and sends PTY options accepted by the actual execution contract', async t => {
  let count = 0;
  const checks = {}, bytes = new Uint8Array([0, 1, 127, 128, 255, 10]);
  const sandbox = { files: { write: async () => {}, read: async () => bytes }, commands: { start: async (argv, options) => {
    assert.ok(validExecution({ argv, ...options }));
    if (++count === 2) throw new Error('stop_after_valid_pty');
    const child = spawn(argv[0], argv.slice(1)); t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    let stdout = ''; child.stdout.on('data', bytes => { stdout += bytes; });
    const closed = once(child, 'close');
    return { get: async () => ({ status: child.exitCode === null ? 'running' : 'succeeded' }),
      stdin: { write: async value => { child.stdin.write(value); }, close: async () => { assert.equal(child.exitCode, null); child.stdin.end(); } },
      wait: async () => { const [code] = await closed; return { status: code === 0 ? 'succeeded' : 'failed', stdout }; } };
  } } };
  await assert.rejects(accessChecks(sandbox, {}, '', checks), /stop_after_valid_pty/);
  assert.equal(checks.stdin, true); assert.equal(count, 2);
});

test('webhook failures checkpoint bounded diagnostics before erasing the outbox', async () => {
  const f = fixture({ failWebhook: true }); const report = await verifyJob3(f.client, f.options);
  assert.equal(report.ok, false); assert.equal(report.startsRequested, 1);
  assert.equal(report.cleanup, 'completed'); assert.equal(report.webhookFailure.deliveries.length, 2);
  assert.ok(f.checkpoints.some(saved => saved.webhookFailure?.deliveries.length === 2));
  assert.equal(JSON.stringify(report).includes('credential-must-not-leak'), false);
});

test('network mode works with disabled webhooks and never contacts the receiver or webhook API', async () => {
  const f = fixture({ webhooksEnabled: false, failWebhook: true });
  const report = await verifyJob3(f.client, { ...f.options, mode: 'network',
    receiverRequest: async () => { assert.fail('receiver must not be used'); },
    exerciseAccess: async (_sandbox, _secondary, _appSource, _checks, options) => {
      assert.equal(options.webhooks, false);
    } });
  assert.equal(report.ok, true); assert.equal(report.mode, 'network');
  assert.equal(report.releaseQualified, false); assert.equal(report.startsRequested, 2);
  assert.equal(report.cleanup, 'completed'); assert.deepEqual(report.receiverRuns, []);
  assert.equal(f.calls.includes('webhook_remove'), false);
  assert.equal(report.pendingGates.some(gate => /webhook|metrics/.test(gate)), false);
  assert.ok(report.pendingGates.includes('replacement_generation_fencing'));
  const combined = fixture({ webhooksEnabled: false });
  assert.equal((await verifyJob3(combined.client, combined.options)).startsRequested, 0);
});

test('network mode keeps cleanup and offline latency gates, and rejects cross-mode recovery', async () => {
  const timeout = fixture({ npmTimedOut: true });
  const report = await verifyJob3(timeout.client, { ...timeout.options, mode: 'network' });
  assert.equal(report.ok, true); assert.equal(report.releaseQualified, false);
  assert.ok(report.pendingGates.includes('offline_package_manager_dns_failure_latency'));
  const failed = fixture({ failAccess: true });
  const previous = await verifyJob3(failed.client, { ...failed.options, mode: 'network' });
  assert.equal(previous.cleanup, 'completed'); assert.equal(previous.startsRequested, 1);
  const wrongMode = await verifyJob3(failed.client, { ...failed.options, previous });
  assert.equal(wrongMode.ok, false); assert.equal(wrongMode.startsRequested, 0);
  const resumed = await verifyJob3(failed.client, { ...failed.options, mode: 'network', previous, exerciseAccess: async () => {} });
  assert.equal(resumed.ok, true); assert.equal(resumed.startsRequested, 2);
  const cleanup = fixture({ failCleanup: true });
  const rejected = await verifyJob3(cleanup.client, { ...cleanup.options, mode: 'network' });
  assert.equal(rejected.cleanup, 'failed'); assert.equal(rejected.startsRequested, 1);
});

test('unknown verification modes are rejected before admission', async () => {
  const f = fixture();
  const report = await verifyJob3(f.client, { ...f.options, mode: 'typo' });
  assert.equal(report.ok, false); assert.equal(report.startsRequested, 0); assert.deepEqual(f.calls, []);
});

test('network access checks omit cross-account webhook reads', async () => {
  let count = 0;
  const checks = {}, requests = [];
  const sandbox = { path: value => value,
    files: { write: async () => {}, read: async () => new Uint8Array([0, 1, 127, 128, 255, 10]) },
    commands: { start: async () => {
      if (++count === 4) throw new Error('stop_before_preview');
      const index = count;
      return { get: async () => ({ status: 'running', stdout: 'mainbrella-job3-pty' }),
        stdin: { write: async () => {}, close: async () => {} }, resize: async () => {}, signal: async () => {}, cancel: async () => {},
        wait: async () => ({ status: index === 1 ? 'succeeded' : 'canceled', stdout: 'stdin:mainbrella-job3' }) };
    } } };
  const secondary = { request: async path => { requests.push(path); throw Object.assign(new Error('not_found'), { status: 404 }); } };
  await assert.rejects(accessChecks(sandbox, secondary, '', checks, { webhooks: false }), /stop_before_preview/);
  assert.deepEqual(requests, ['/containers/events']);
  assert.equal(checks.crossAccountHistory, true); assert.equal(checks.crossAccountWebhook, undefined);
});
