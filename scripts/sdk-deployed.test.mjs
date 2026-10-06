import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Mainbrella } from '../sdk/javascript/index.js';
import { deploymentPreflight, verifyDeployedSDK } from './sdk-deployed-workflow.mjs';
import { parseQualificationArgs, readCandidate, qualifyDeployedArtifacts } from './qualify-sdk-deployed.mjs';

const key = `mb_${'c'.repeat(64)}`;
const root = fileURLToPath(new URL('../', import.meta.url));
const existing = { id: 'c1', createdAt: '2026-10-05T12:00:00.000Z', status: 'running' };
const created = { id: 'small', createdAt: '2026-10-05T12:01:00.000Z', status: 'running', instance: 'lite' };
const capabilities = { apiVersion: '2026-10-05', containers: { idempotentCreate: true, generationRequired: true },
  execution: { foreground: true, background: true, streaming: true, reconnect: true, cancellation: true },
  files: { read: true, write: true, binary: true } };

export async function deploymentFixture(t, options = {}) {
  const calls = [], jobs = new Map(), keys = new Set();
  let owned, bytes;
  const state = () => ({ active: true, containers: [existing, ...(owned ? [owned] : [])], imageCatalog: [{ id: 'node' }],
    limits: { maxContainers: 5, maxStartsPerMonth: 10, maxConcurrentComputeUnits: 28 },
    usage: { starts: keys.size, concurrentComputeUnits: 6 + Number(Boolean(owned)), availableComputeUnitHours: 240 },
    ...options.account });
  const server = createServer(async (incoming, outgoing) => {
    try {
      const url = new URL(incoming.url, 'http://localhost');
      const path = url.pathname, method = incoming.method;
      const chunks = []; for await (const chunk of incoming) chunks.push(chunk);
      const raw = Buffer.concat(chunks), body = incoming.headers['content-type'] === 'application/json' ? JSON.parse(raw) : raw;
      const creationKey = incoming.headers['idempotency-key'];
      calls.push({ path, method, query: Object.fromEntries(url.searchParams), creationKey });
      assert.equal(incoming.headers.authorization, `Bearer ${key}`);
      const json = (value, status = 200) => { outgoing.writeHead(status, { 'Content-Type': 'application/json' }); outgoing.end(JSON.stringify(value)); };
      if (path === '/capabilities') return json(options.capabilities || capabilities);
      if (path === '/containers' && method === 'GET') return json(state());
      if (path === '/containers' && method === 'POST') {
        assert.deepEqual(body, { catalogId: 'node', size: 'lite' });
        if (options.failAt === 'create') return json({ error: 'invalid_creation_response', secret: key }, 400);
        const replay = keys.has(creationKey); keys.add(creationKey);
        owned = options.preexisting ? { ...existing, instance: 'lite' } : { ...created };
        const selected = replay && options.badIdempotency ? { ...created, id: 'c2' } : owned;
        return json({ ...state(), containers: [existing, selected], creation: { id: 'operation', status: 'running', containerId: selected.id, createdAt: selected.createdAt } });
      }
      assert.equal(url.searchParams.get('id'), created.id);
      assert.equal(url.searchParams.get('createdAt'), created.createdAt);
      if (path === '/containers' && method === 'DELETE') {
        if (options.failAt === 'cleanup') return json({ error: 'unavailable', secret: key }, 503);
        owned = null; return json(state());
      }
      if (path === '/containers/exec') return json({ stdout: options.failAt === 'foreground' ? key : 'mainbrella-probe',
        stderr: 'mainbrella-stderr', exitCode: 0, timedOut: false, outputTruncated: false });
      if (path === '/containers/files') {
        if (method === 'PUT') { bytes = raw; return json({ size: bytes.length }); }
        outgoing.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        return outgoing.end(options.failAt === 'files' ? Buffer.from([1]) : bytes);
      }
      if (path === '/containers/executions' && method === 'POST') {
        const canceled = body.command === 'exec sleep 30';
        const job = { id: randomUUID(), status: canceled ? 'running' : 'succeeded',
          stdout: canceled ? '' : 'mainbrella-managed', stderr: canceled ? '' : 'mainbrella-managed-err',
          exitCode: canceled ? null : 0, timedOut: false, outputTruncated: false };
        jobs.set(job.id, job); return json(job);
      }
      const match = /^\/containers\/executions\/([^/]+)(\/events)?$/.exec(path);
      if (match) {
        const job = jobs.get(match[1]); assert.ok(job);
        if (match[2]) {
          const cursor = Number(url.searchParams.get('cursor'));
          const events = [
            ['stdout', { type: 'stdout', sequence: 1, data: options.failAt === 'managed' ? key : job.stdout }],
            ['stderr', { type: 'stderr', sequence: 2, data: job.stderr }],
            ['status', job],
          ].filter(([type, item]) => type === 'status' || item.sequence > cursor || options.duplicateReplay);
          outgoing.writeHead(200, { 'Content-Type': 'text/event-stream' });
          return outgoing.end(events.map(([type, item]) => `event: ${type}\ndata: ${JSON.stringify(item)}\n\n`).join(''));
        }
        if (method === 'DELETE') {
          if (options.failAt === 'cancellation') return json({ error: 'unavailable', secret: key }, 503);
          job.status = 'canceled'; job.exitCode = 137;
        }
        return json(job);
      }
      return json({ error: 'not_found' }, 404);
    } catch { outgoing.writeHead(500); outgoing.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { calls, baseUrl, client: new Mainbrella({ apiKey: key, baseUrl }), keys };
}

async function pythonWorkflow(t, fixture) {
  const directory = await mkdtemp(join(tmpdir(), 'mainbrella-python-verification-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'python.json');
  const child = spawn(process.env.PYTHON || 'python3', ['scripts/sdk-deployed-workflow.py'], {
    cwd: root, env: { ...process.env, PYTHONPATH: join(root, 'sdk/python'), MAINBRELLA_API_KEY: key,
      MAINBRELLA_API_URL: fixture.baseUrl, MAINBRELLA_SDK_REPORT: output }, stdio: 'ignore',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  const [code] = await once(child, 'close'); clearTimeout(timer);
  const report = JSON.parse(await readFile(output));
  assert.equal(code, report.ok ? 0 : 1);
  return report;
}

for (const language of ['javascript', 'python']) {
  const verify = (t, f, options) => language === 'javascript' ? verifyDeployedSDK(f.client, options) : pythonWorkflow(t, f);
  test(`${language}: one generation, idempotent admission, binary files, real stream disconnect/attach and cancellation`, async t => {
    const f = await deploymentFixture(t, { duplicateReplay: true });
    const snapshots = [];
    const report = await verify(t, f, { checkpoint: value => snapshots.push(value) });
    assert.equal(report.ok, true); assert.equal(report.cleanup, 'completed'); assert.equal(f.keys.size, 1);
    assert.equal(JSON.stringify(report).includes(key), false);
    assert.deepEqual(report.checks, { idempotentAdmission: true, stdoutStderr: true, binaryFiles: true, managedReconnect: true, cancellation: true });
    const streams = f.calls.filter(call => call.path.endsWith('/events'));
    assert.deepEqual(streams.map(call => call.query.cursor), ['0', '1']);
    const stops = f.calls.filter(call => call.path === '/containers' && call.method === 'DELETE');
    assert.deepEqual(stops.map(call => call.query), [{ id: created.id, createdAt: created.createdAt }]);
    if (language === 'javascript') assert.equal(snapshots[0].cleanup, 'reconcile_manually');
  });
  test(`${language}: capability/quota failures perform no writes`, async t => {
    for (const options of [{ capabilities: { ...capabilities, execution: { foreground: true } } },
      { account: { usage: { starts: 10, concurrentComputeUnits: 0, availableComputeUnitHours: 10 } } },
      { account: { usage: { starts: 0, concurrentComputeUnits: 28, availableComputeUnitHours: 10 } } }]) {
      const f = await deploymentFixture(t, options);
      const report = await verify(t, f);
      assert.equal(report.error, 'preflight_failed'); assert.equal(report.cleanup, 'not_needed');
      assert.ok(f.calls.every(call => call.method === 'GET'));
    }
  });
  test(`${language}: failed execution/transport checks clean up and never report returned secrets`, async t => {
    for (const stage of ['foreground', 'files', 'managed', 'cancellation', 'cleanup']) {
      const f = await deploymentFixture(t, { failAt: stage });
      const report = await verify(t, f);
      assert.equal(report.ok, false); assert.equal(report.cleanup, stage === 'cleanup' ? 'failed' : 'completed');
      assert.equal(JSON.stringify(report).includes(key), false); assert.equal(f.keys.size, 1);
      assert.ok(report.creationKey); assert.deepEqual(report.container, { id: created.id, createdAt: created.createdAt });
    }
  });
  test(`${language}: ambiguous create and pre-existing identity are never deleted`, async t => {
    for (const options of [{ failAt: 'create' }, { preexisting: true }]) {
      const f = await deploymentFixture(t, options);
      const report = await verify(t, f);
      assert.equal(report.ok, false); assert.equal(report.cleanup, 'reconcile_manually'); assert.ok(report.creationKey);
      assert.equal(f.calls.some(call => call.method === 'DELETE'), false);
    }
  });
  test(`${language}: an inconsistent idempotency replay keeps both recovery identities and stops only the proven generation`, async t => {
    const f = await deploymentFixture(t, { badIdempotency: true });
    const report = await verify(t, f);
    assert.equal(report.error, 'idempotency_failed'); assert.equal(report.cleanup, 'completed');
    assert.equal(report.unexpectedGeneration.id, 'c2'); assert.equal(f.keys.size, 1);
    assert.equal(f.calls.filter(call => call.method === 'DELETE').length, 1);
  });
}

test('preflight reserves two sequential starts before the JavaScript workflow', async t => {
  const f = await deploymentFixture(t, { account: { usage: { starts: 9, concurrentComputeUnits: 0, availableComputeUnitHours: 10 } } });
  await assert.rejects(deploymentPreflight(f.client, { starts: 2 }), /account_not_ready/);
  assert.ok(f.calls.every(call => call.method === 'GET'));
});

async function candidateFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'mainbrella-candidate-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const candidate = join(directory, 'candidate'); await mkdir(candidate);
  const checks = Object.fromEntries(['packageContents', 'license', 'npmCleanInstall', 'typescript', 'wheelCleanInstall', 'sdistCleanInstall', 'sdkContractSuites', 'localRuntimeWorkflow'].map(name => [name, true]));
  const artifacts = [];
  for (const name of ['mainbrella-sdk-0.1.0.tgz', 'mainbrella-0.1.0-py3-none-any.whl', 'mainbrella-0.1.0.tar.gz']) {
    const bytes = Buffer.from(name); await writeFile(join(candidate, name), bytes);
    artifacts.push({ name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  await writeFile(join(candidate, 'qualification.json'), JSON.stringify({ version: '0.1.0', checks, artifacts }));
  const options = parseQualificationArgs([`--candidate=${candidate}`, `--output=${join(directory, 'evidence')}`,
    '--max-starts=2', '--api-revision=abcdef1', '--runtime-revision=abcdef2'], { ...process.env, MAINBRELLA_API_KEY: key, MAINBRELLA_API_URL: 'http://localhost:8787' });
  return { candidate, options };
}

test('the deployed entry point requires an explicit two-start budget, revisions and trusted credential origin', () => {
  const args = ['--candidate=/tmp/candidate', '--output=/tmp/evidence', '--max-starts=2', '--api-revision=abcdef1', '--runtime-revision=abcdef2'];
  const env = { MAINBRELLA_API_KEY: key };
  assert.equal(parseQualificationArgs(args, env).apiOrigin, 'https://api.mainbrella.com');
  for (const invalid of [args.filter(arg => !arg.startsWith('--max-starts')), [...args, '--max-starts=3'],
    args.map(arg => arg.replace('--max-starts=2', '--max-starts=1')), [...args, '--unknown=1']]) {
    assert.throws(() => parseQualificationArgs(invalid, env));
  }
  for (const url of ['http://api.example.com', 'https://user:pass@api.example.com', 'https://api.example.com/?secret=1']) {
    assert.throws(() => parseQualificationArgs(args, { ...env, MAINBRELLA_API_URL: url }));
  }
});

test('tampered archives fail before installation or API requests', async t => {
  const { candidate, options } = await candidateFixture(t);
  assert.equal((await readCandidate(candidate)).archives.length, 3);
  await writeFile(join(candidate, 'mainbrella-sdk-0.1.0.tgz'), 'changed');
  await assert.rejects(qualifyDeployedArtifacts(options, { run: () => assert.fail('Must not run') }), /candidate_checksum_failed/);
});

test('an incomplete JavaScript checkpoint prevents Python starts and remains available for recovery', async t => {
  const { options } = await candidateFixture(t);
  const calls = [];
  const run = async (_command, args, { cwd, env }) => {
    calls.push(args);
    if (args[0] === 'install') {
      assert.equal(env.MAINBRELLA_API_KEY, undefined);
      await mkdir(join(cwd, 'node_modules/@mainbrella/sdk'), { recursive: true });
      await writeFile(join(cwd, 'node_modules/@mainbrella/sdk/package.json'), JSON.stringify({ name: '@mainbrella/sdk', version: '0.1.0' }));
    } else if (args[0] === 'sdk-deployed-workflow.mjs') {
      await writeFile(env.MAINBRELLA_SDK_REPORT, JSON.stringify({ language: 'javascript', ok: false, creationKey: 'saved-before-create', cleanup: 'reconcile_manually' }));
      throw new Error(key);
    }
  };
  const report = await qualifyDeployedArtifacts(options, { run });
  assert.equal(report.ok, false); assert.equal(report.error, 'javascript_failed');
  assert.equal(report.results[0].creationKey, 'saved-before-create');
  assert.equal(calls.some(args => args.includes('sdk-deployed-workflow.py')), false);
  assert.equal(JSON.stringify(report).includes(key), false);
  await assert.rejects(qualifyDeployedArtifacts(options, { run: () => assert.fail('Evidence must not be overwritten') }), { code: 'EEXIST' });
});

// The artifact CI job sets this only after local archive qualification. This
// smoke check uses a loopback HTTP fixture and never reaches a deployed account.
if (process.env.MAINBRELLA_SDK_CANDIDATE) test('exact qualified archives install cleanly and complete the qualification runner over loopback HTTP', async t => {
  const f = await deploymentFixture(t);
  const directory = await mkdtemp(join(tmpdir(), 'mainbrella-deployed-runner-smoke-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = parseQualificationArgs([`--candidate=${process.env.MAINBRELLA_SDK_CANDIDATE}`,
    `--output=${join(directory, 'evidence')}`, '--max-starts=2', '--api-revision=abcdef1', '--runtime-revision=abcdef2'],
  { ...process.env, MAINBRELLA_API_KEY: key, MAINBRELLA_API_URL: f.baseUrl });
  const report = await qualifyDeployedArtifacts(options);
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(report.target, 'loopback'); assert.equal(report.results.length, 2); assert.equal(f.keys.size, 2);
  assert.deepEqual(report.results.map(result => result.cleanup), ['completed', 'completed']);
  assert.equal(f.calls.filter(call => call.path === '/containers' && call.method === 'DELETE').length, 2);
  assert.equal(JSON.stringify(report).includes(key), false);
  assert.deepEqual(JSON.parse(await readFile(join(options.output, 'deployed-qualification.json'))), report);
});
