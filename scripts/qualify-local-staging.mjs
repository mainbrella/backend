// Local-only integration qualification. No .env loading, account credentials,
// provider configuration, remote bindings, registry pulls, or fake snapshots.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { Mainbrella } from '../sdk/javascript/index.js';
import { machineName } from '../containers/container-account-core.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const checksum = value => createHash('sha256').update(value).digest('hex');
const docker = (args, timeoutMs = 10_000) => execFileSync('docker', args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1024 * 1024 }).trim();
const identity = value => ({ id: value.id, createdAt: value.createdAt });
export const nativeSource = `
import {DurableObject} from 'cloudflare:workers';
import {UserContainer} from './containers/user-container.js';
export {EgressOutbound,PrivateServiceOutbound} from './containers/user-container.js';
// Adds read-only cleanup inventory to the unchanged production implementation.
export class LocalStagingContainer extends UserContainer {
  async qualificationSnapshots(){return this.controller.serialized(async()=>{const rows=Object.values(await this.ctx.storage.get('workspaceReceipts')??{});if(rows.some(row=>!row.handle))throw new Error('ambiguous_snapshot_receipt');return rows.map(row=>row.handle);});}
}
export class NativeProbe extends DurableObject {
  async qualificationSnapshots(){await this.activeProbe?.catch(()=>{});return [await this.ctx.storage.get('nativeSnapshot')].filter(Boolean);}
  async alarm(){await this.ctx.container.destroy();}
  fetch(){this.activeProbe=this.runProbe();return this.activeProbe;}
  async runProbe(){const evidence={starts:0};await this.ctx.storage.setAlarm(Date.now()+45000);try{
    this.ctx.container.start({image:this.ctx.container.images.python,entrypoint:['sleep','infinity'],enableInternet:false});evidence.starts++;
    const process=await this.ctx.container.exec(['timeout','--signal=KILL','10s','sh','-lc','uname -s; python3 --version; printf native-persisted > /workspace/native-staging-marker']);
    const [output,exitCode]=await Promise.all([process.output(),process.exitCode]);
    evidence.exec={exitCode,outputExitCode:output.exitCode,stdout:new TextDecoder().decode(output.stdout)};
    try{evidence.snapshot=await this.ctx.container.snapshotContainer({name:'local-staging-native'});await this.ctx.storage.put('nativeSnapshot',evidence.snapshot);}catch(error){evidence.snapshotError={name:error.name,message:error.message};return Response.json(evidence);}
    await this.ctx.container.destroy();
    this.ctx.container.start({containerSnapshot:{id:evidence.snapshot.id},entrypoint:['sleep','infinity'],enableInternet:false});evidence.starts++;
    const restored=await this.ctx.container.exec(['timeout','--signal=KILL','10s','cat','/workspace/native-staging-marker']);
    const [result,restoredExit]=await Promise.all([restored.output(),restored.exitCode]);
    evidence.restore={exitCode:restoredExit,stdout:new TextDecoder().decode(result.stdout)};
  }catch(error){evidence.error={name:error.name,message:error.message};}finally{
    try{await this.ctx.container.destroy();await this.ctx.storage.deleteAlarm();evidence.cleanedUp=true;}catch(error){evidence.cleanupError=error.message;}
  }return Response.json(evidence);}
}
export default {fetch(request,env){return env.NATIVE_PROBE.get(env.NATIVE_PROBE.idFromName('probe')).fetch(request)}};
`;

export function parseLocalStagingArgs(args) {
  const result = {};
  for (const arg of args) {
    const match = /^--(image|output)=(.+)$/.exec(arg);
    if (!match || result[match[1]]) throw new Error('Use --image=<existing local Docker image> --output=<new evidence directory>');
    result[match[1]] = match[2];
  }
  if (!result.image || !result.output || result.image.startsWith('-') || /[\s\x00-\x1f]/.test(result.image)) throw new Error('Explicit local image and evidence directory required');
  return { image: result.image, output: resolve(result.output) };
}

async function bounded(promise, timeoutMs, code, signal) {
  let timer, cancel;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(code)), timeoutMs);
    cancel = () => reject(new Error('local_staging_interrupted_or_timed_out'));
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  });
  try { return await Promise.race([promise, deadline]); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function bundle(entry, outfile) {
  await build({ ...(typeof entry === 'string' ? { entryPoints: [join(root, entry)] } : { stdin: { contents: entry.source, resolveDir: root, sourcefile: 'local-staging-runtime.js' } }),
    outfile, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:*', 'node:*'], logLevel: 'silent' });
}

async function migrations(db, directory) {
  for (const file of (await readdir(join(root, directory))).filter(name => name.endsWith('.sql')).sort()) {
    // SQLite's standard parser recognizes trigger bodies and quoted semicolons.
    // D1.exec splits on newlines and cannot consume raw migration comments.
    const parser = "import json,sqlite3,sys; source=open(sys.argv[1]).read(); statements=[]; pending=''\nfor char in source:\n pending+=char\n if char==';' and sqlite3.complete_statement(pending): statements.append(pending); pending=''\nprint(json.dumps(statements))";
    const statements = JSON.parse(execFileSync('python3', ['-c', parser, join(root, directory, file)], { encoding: 'utf8', timeout: 10_000 }));
    if (statements.length) await db.batch(statements.map(statement => db.prepare(statement)));
  }
}

async function denied(action, statuses) {
  try { await action(); } catch (error) { assert.ok(statuses.includes(error.status), `Unexpected denial ${error.status}:${error.code}`); return { status: error.status, code: error.code }; }
  throw new Error('Expected authorization/generation denial');
}

export async function qualifyLocalStaging({ image, output }) {
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output, { mode: 0o700 }); // A previous evidence directory is never overwritten.
  const work = await mkdtemp(join(tmpdir(), 'mainbrella-local-staging-'));
  const runId = randomBytes(6).toString('hex'), apiName = `mainbrella-staging-api-${runId}`, runtimeName = `mainbrella-staging-runtime-${runId}`;
  const report = { formatVersion: 1, target: 'isolated-local-miniflare-docker', startedAt: new Date().toISOString(), ok: false,
    sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    sourceDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()),
    maxAccountStarts: 3, accountStartsRequested: 0, maxNativeProbeStarts: 2, workloadDeadlineMs: 300_000, cleanupAllowanceMs: 180_000, stage: 'preflight', checks: {}, generations: [],
    fixture: { billing: 'synthetic local prepaid funding inserted into isolated D1/account DO; no Stripe proof', fundingCentsPerAccount: 5000, accounts: 2, credentials: 'fresh disposable API keys; never read or save production keys' },
    workerOutboundFetchAttempts: 0, nativeNetworkIsolationQualified: false, remainingLiveGates: ['deployed lifecycle/native snapshot and restore behavior', 'actor/provider crash after accepted capture before durable snapshot-handle persistence', 'deployed interpreter disconnect/recovery', 'deployed sustained streamed-transfer disconnect cleanup', 'deployed protected preview DNS/TLS/WebSockets', 'Stripe payment/funding verification', 'installed SDK deployed workflows and package publication'] };
  const persist = async () => { const path = join(output, 'qualification.json'); await writeFile(path + '.tmp', JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); await rename(path + '.tmp', path); };
  let mf, primary, secondary, source, fork, resumed, context, preview, job, namespace, nativeNamespace, accounts, gateway;
  const snapshots = new Set(), known = [], ownedIds = new Set();
  const abort = new AbortController();
  const deadline = setTimeout(() => { report.deadlineExceeded = true; abort.abort(); }, 300_000);
  const onSigint = () => { report.interruptedBy = 'SIGINT'; abort.abort(); };
  const onSigterm = () => { report.interruptedBy = 'SIGTERM'; abort.abort(); };
  process.on('SIGINT', onSigint); process.on('SIGTERM', onSigterm);

  const phase = async (name, action) => { if (abort.signal.aborted) throw new Error('local_staging_deadline'); report.stage = name; await persist(); await bounded(action(), 90_000, 'local_staging_phase_timeout', abort.signal); await persist(); };
  const restoredListener = async (sandbox, action) => {
    const readiness = await sandbox.waitUntilReady({ waitTimeoutMs: 65_000, pollIntervalMs: 50 });
    assert.equal(readiness.status, 'ready');
    const link = await sandbox.previews.create(3000, { ttlSeconds: 300 });
    try {
      const response = await gateway.fetch(link.url);
      assert.equal(response.status, 200);
      const process = await response.json();
      assert.equal(process.fixture, 'local-staging');
      assert.notEqual(process.nonce, report.restoreStartup.source.nonce);
      assert.equal(process.auth, null); assert.equal(process.cookie, null);
      assert.equal(typeof process.pid, 'number');
      report.restoreStartup[action] = { ...identity(sandbox), initiallyListeningAfterAutomaticLaunch: true, readiness, process,
        clientLaunchCommands: 0, sourceMemoryPreserved: false };
    } finally { await sandbox.previews.revoke(link.id); }
  };
  try {
    report.dockerVersion = docker(['version', '--format', '{{.Server.Version}}']);
    const details = JSON.parse(docker(['image', 'inspect', image]))[0]; // Refuses absent images; never pulls.
    report.image = { supplied: image, id: details.Id, architecture: details.Architecture, os: details.Os };
    assert.equal(details.Os, 'linux');
    const deploymentApi = JSON.parse(await readFile(join(root, 'wrangler.jsonc'), 'utf8'));
    const deploymentRuntime = JSON.parse(await readFile(join(root, 'wrangler.containers.jsonc'), 'utf8'));
    report.compatibility = { api: { date: deploymentApi.compatibility_date, flags: deploymentApi.compatibility_flags ?? [] }, runtime: { date: deploymentRuntime.compatibility_date, flags: deploymentRuntime.compatibility_flags ?? [] } };
    const port = await freePort(), baseUrl = `http://127.0.0.1:${port}`;
    report.apiOrigin = baseUrl;
    report.snapshotRecovery = 'Wait for owned active actor operations, then read persisted handles; local Docker snapshots omit generation labels. Actor/provider crash before handle persistence remains unqualified.';
    report.previewTransport = 'Miniflare preserves original URL but rewrites Host; local fixture restores URL Host before delegating to original Worker';
    await bounded(Promise.all([bundle({ source: `import api from './worker/index.ts'; export {AppState,ContainerAccount,AccountActivity,BuildWorkflow} from './worker/index.ts'; export default {...api,fetch(request,env,ctx){if(new URL(request.url).hostname.endsWith('.localhost')){const headers=new Headers(request.headers);headers.set('host',new URL(request.url).host);request=new Request(request,{headers});}return api.fetch(request,env,ctx);}};` }, join(work, 'api.mjs')), bundle({ source: nativeSource }, join(work, 'runtime.mjs'))]), 45_000, 'local_staging_bundle_timeout', abort.signal);
    const apiDo = { ACCOUNT_ACTIVITY: { className: 'AccountActivity', useSQLite: true }, CONTAINER_ACCOUNT: { className: 'ContainerAccount', useSQLite: true }, USER_CONTAINER: { className: 'LocalStagingContainer', scriptName: runtimeName } };
    const blockedOutbound = () => { report.workerOutboundFetchAttempts++; throw new Error('local_staging_external_fetch_forbidden'); };
    const localBindings = { LOCAL_DEV: 'true', LOCAL_PREVIEW_PORT: String(port), PREVIEWS_ENABLED: 'true', WORKSPACE_PERSISTENCE_ENABLED: 'true', WORKSPACE_LIFECYCLE_ENABLED: 'true', NETWORK_INTERNET_CONTROL_ENABLED: 'true', EGRESS_POLICIES_ENABLED: 'false', SECRETS_VAULT_ENABLED: 'false', BUILD_ENABLED: 'false', ACQUISITION_ENABLED: 'false', ACTIVITY_WEBSOCKET_ENABLED: 'false' };
    const priorSignalListeners = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, new Set(process.listeners(signal))]));
    mf = new Miniflare(convertV4MiniflareOptions({ host: '127.0.0.1', port, cf: false, telemetry: { enabled: false },
      d1Persist: join(work, 'd1'), durableObjectsPersist: join(work, 'do'), r2Persist: join(work, 'r2'), workers: [
        { name: apiName, modules: true, script: await readFile(join(work, 'api.mjs'), 'utf8'), compatibilityDate: report.compatibility.api.date, compatibilityFlags: report.compatibility.api.flags,
          durableObjects: apiDo, workflows: { BUILD_WORKFLOW: { name: 'local-staging-build', className: 'BuildWorkflow' } }, bindings: localBindings, d1Databases: { DB: 'staging-accounts', PREVIEW_ROUTES: 'staging-previews' }, r2Buckets: { BUCKET: 'staging-storage' }, outboundService: blockedOutbound },
        { name: runtimeName, modules: true, script: await readFile(join(work, 'runtime.mjs'), 'utf8'), compatibilityDate: report.compatibility.runtime.date, compatibilityFlags: report.compatibility.runtime.flags, bindings: localBindings,
          durableObjects: { ACCOUNT_ACTIVITY: { className: 'AccountActivity', scriptName: apiName }, CONTAINER_ACCOUNT: { className: 'ContainerAccount', scriptName: apiName },
            USER_CONTAINER: { className: 'LocalStagingContainer', useSQLite: true, container: { images: [{ name: 'terminal', image: details.Id }, { name: 'python', image: details.Id }] } },
            NATIVE_PROBE: { className: 'NativeProbe', useSQLite: true, container: { images: [{ name: 'python', image: details.Id }] } } }, outboundService: blockedOutbound },
      ] }));
    // Default Miniflare signal hooks exit immediately and bypass finally.
    // Remove only hooks installed by this dedicated instance.
    for (const [signal, previous] of priorSignalListeners) for (const handler of process.listeners(signal)) if (!previous.has(handler)) process.off(signal, handler);
    report.bundleHashes = { api: checksum(await readFile(join(work, 'api.mjs'))), runtime: checksum(await readFile(join(work, 'runtime.mjs'))) };
    report.tooling = Object.fromEntries(await Promise.all(['wrangler', 'miniflare', 'workerd'].map(async name => [name, JSON.parse(await readFile(join(root, 'node_modules', name, 'package.json'), 'utf8')).version])));
    report.packageLockSha256 = checksum(await readFile(join(root, 'package-lock.json')));
    report.runnerSha256 = checksum(await readFile(fileURLToPath(import.meta.url)));
    report.hostSdkEntrySha256 = checksum(await readFile(join(root, 'sdk/javascript/index.js')));
    await bounded(mf.ready, 45_000, 'local_staging_ready_timeout', abort.signal);
    namespace = await bounded(mf.getDurableObjectNamespace('USER_CONTAINER', runtimeName), 5000, 'runtime_namespace_timeout', abort.signal);
    gateway = { fetch(address, options = {}) { const desired = new URL(address); assert.ok(desired.hostname.endsWith('.localhost')); assert.equal(desired.port, String(port)); return mf.dispatchFetch(desired.href, { ...options, redirect: 'manual', headers: { ...options.headers, Host: desired.host }, signal: abort.signal }); } };
    await phase('native-snapshot-probe', async () => {
      nativeNamespace = await mf.getDurableObjectNamespace('NATIVE_PROBE', runtimeName);
      const response = await bounded(nativeNamespace.get(nativeNamespace.idFromName('probe')).fetch('http://local/probe'), 60_000, 'native_probe_timeout', abort.signal);
      report.nativeSnapshot = await response.json();
      if (report.nativeSnapshot.snapshot?.id) snapshots.add(report.nativeSnapshot.snapshot.id);
      assert.equal(report.nativeSnapshot.exec?.exitCode, 0);
      if (report.nativeSnapshot.snapshotError) { report.checks.nativeSnapshot = false; return; }
      assert.ok(report.nativeSnapshot.snapshot?.size > 0);
      assert.deepEqual(report.nativeSnapshot.restore, { exitCode: 0, stdout: 'native-persisted' });
      assert.equal(report.nativeSnapshot.cleanedUp, true);
      report.checks.nativeSnapshot = true;
    });
    await phase('local-d1-prepaid-fixture', async () => {
      const db = await mf.getD1Database('DB', apiName), routes = await mf.getD1Database('PREVIEW_ROUTES', apiName);
      await migrations(db, 'migrations'); await migrations(routes, 'preview-migrations');
      accounts = await mf.getDurableObjectNamespace('CONTAINER_ACCOUNT', apiName);
      const clients = [];
      for (let i = 0; i < 2; i++) {
        const userId = `staging_${runId}_${i}`, key = `mb_${randomBytes(32).toString('hex')}`, customerId = `cus_local_${runId}_${i}`;
        await db.prepare('INSERT INTO users(id,email,name) VALUES(?,?,?)').bind(userId, `${userId}@example.invalid`, 'Local staging fixture').run();
        await db.prepare('INSERT INTO api_keys(id,user_id,name,token_hash,prefix,created_at) VALUES(?,?,?,?,?,?)').bind(randomUUID(), userId, 'Disposable local qualification', checksum(key), key.slice(0, 11), new Date().toISOString()).run();
        await db.prepare('INSERT INTO prepaid_accounts(user_id,stripe_customer_id,created_at) VALUES(?,?,?)').bind(userId, customerId, Date.now()).run();
        const funding = await accounts.get(accounts.idFromName(`account:${userId}`)).fetch('http://local/billing/funding', { method: 'POST', headers: { 'x-mainbrella-user': userId }, body: JSON.stringify({ id: `pi_local_${runId}_${i}`, customerId, amountCents: 5000, refundedCents: 0, disputed: false, createdAt: Date.now(), kind: 'topup' }) });
        assert.equal(funding.status, 200);
        const fetcher = async (url, options = {}) => { assert.equal(url.origin, baseUrl); const response = await fetch(url, { ...options, signal: options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal }); if (url.pathname.startsWith('/containers/files')) { report.fileTransport ??= []; report.fileTransport.push({method:options.method,path:url.pathname,status:response.status,contentType:response.headers.get('content-type'),contentLength:response.headers.get('content-length'),contentEncoding:response.headers.get('content-encoding')}); } return response; };
        clients.push({ client: new Mainbrella({ apiKey: key, baseUrl, fetch: fetcher, timeoutMs: 60_000 }), cleanup: new Mainbrella({ apiKey: key, baseUrl, timeoutMs: 30_000 }), userId });
      }
      [primary, secondary] = clients;
      assert.equal((await primary.client.list()).active, true);
      assert.equal((await secondary.client.list()).containers.length, 0);
      report.checks.localPrepaidAdmission = true;
    });
    await phase('create-and-binary-files', async () => {
      report.accountStartsRequested++; report.creationKey = randomUUID(); await persist();
      source = await primary.client.create({ catalogId: 'python', size: 'small', internet: false, name: 'Local staging source', idempotencyKey: report.creationKey, waitTimeoutMs: 60_000, pollIntervalMs: 50 });
      known.push(identity(source)); ownedIds.add(source.id); report.generations.push({ action: 'create', ...identity(source) });
      assert.equal(source.internet, false);
      const bytes = new Uint8Array(180_000); for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 17) % 256;
      const stream = new ReadableStream({ start(controller) { for (let at = 0; at < bytes.length; at += 8192) controller.enqueue(bytes.slice(at, at + 8192)); controller.close(); } });
      await source.files.upload('/workspace/staging 界 &?.bin', stream, { size: bytes.length });
      const restored = new Uint8Array(await new Response(await source.files.download('/workspace/staging 界 &?.bin')).arrayBuffer());
      assert.deepEqual(restored, bytes); report.binaryFile = { bytes: bytes.length, sha256: checksum(bytes) };
      const command = await source.commands.run('mkdir -p /workspace/nested; printf source > /workspace/nested/marker; chmod 640 /workspace/nested/marker; touch -d @1700000000 /workspace/nested/marker; ln -s nested/marker /workspace/staging-link', { timeoutMs: 15_000 });
      assert.equal(command.exitCode, 0); report.checks.streamedBinaryFiles = true;
      report.checks.crossAccount = await denied(() => secondary.client.connect(identity(source)).files.read('/workspace/nested/marker'), [404, 409]);
    });
    await phase('immediate-command-cancellation', async () => {
      const canceled = await source.commands.start(['sleep', '10'], { timeoutMs: 15_000 });
      // Exercise cancellation while startup may still be pending; do not poll
      // for running or insert a delay before the cancel request.
      await canceled.cancel();
      const terminal = await canceled.wait({ timeoutMs: 15_000, pollIntervalMs: 10 });
      assert.equal(terminal.status, 'canceled');
      await source.files.write('/workspace/cancel-survivor.tmp', new TextEncoder().encode('still-running'));
      await source.files.remove('/workspace/cancel-survivor.tmp');
      assert.equal(new TextDecoder().decode(await source.files.read('/workspace/nested/marker')), 'source');
      assert.ok((await primary.client.list()).containers.some(value => value.id === source.id && value.createdAt === source.createdAt && value.status === 'running'));
      report.immediateCancellation = { status: terminal.status, sourceGeneration: identity(source), markerRetained: true, subsequentFileWriteAndRemove: true };
      report.checks.immediateCommandCancellationPreservesSandbox = true;
    });
    await phase('python-context-and-preview', async () => {
      context = await source.code.create();
      assert.equal((await context.run('values = [2, 3, 5]\nvalues.append(7)')).error, null);
      const result = await context.run('sum(values)');
      assert.equal(result.results.find(value => value.mimeType === 'application/json')?.data, '17');
      assert.equal((await context.run('1 / 0')).error?.name, 'ZeroDivisionError');
      assert.equal((await context.run('len(values)')).results.find(value => value.mimeType === 'application/json')?.data, '4');
      const isolated = await source.code.create();
      try { assert.equal((await isolated.run('values')).error?.name, 'NameError'); } finally { await isolated.close(); }
      report.checks.pythonStateAndIsolation = true;
      await source.files.write('/workspace/staging-preview.py', new TextEncoder().encode(`from http.server import BaseHTTPRequestHandler, HTTPServer\nimport json,os,uuid\nnonce=uuid.uuid4().hex\nclass Handler(BaseHTTPRequestHandler):\n def do_GET(self):\n  data=json.dumps({'fixture':'local-staging','pid':os.getpid(),'nonce':nonce,'auth':self.headers.get('Authorization'),'cookie':self.headers.get('Cookie')}).encode()\n  self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(data)\n def log_message(self,*args):pass\nHTTPServer(('0.0.0.0',3000),Handler).serve_forever()\n`));
      job = await source.commands.start(['python3', '-u', '/workspace/staging-preview.py'], { timeoutMs: 240_000 });
      preview = await source.previews.create(3000, { ttlSeconds: 300 });
      const previewAddress = new URL(preview.url); const previewToken = previewAddress.hostname.slice(0, -'.localhost'.length);
      report.previewDiagnostics = { protocol: previewAddress.protocol, port: previewAddress.port, expectedPort: String(port), localHost: previewAddress.hostname.endsWith('.localhost'), tokenLength: previewToken.length, jobStatus: (await job.get()).status, routeMatches: await (await mf.getD1Database('PREVIEW_ROUTES', apiName)).prepare('SELECT COUNT(*) AS count FROM preview_routes WHERE token_hash = ?').bind(checksum(previewToken)).first('count') };
      let response;
      for (let i = 0; i < 30; i++) { response = await gateway.fetch(preview.url, { headers: { Host: previewAddress.host, Authorization: 'Bearer disposable-preview-must-strip', Cookie: 'session=disposable-preview-must-strip' } }); if (response.ok) break; report.previewDiagnostics.responseText = (await response.text()).slice(0, 100); await new Promise(resolve => setTimeout(resolve, 100)); }
      assert.equal(response.status, 200);
      const sourceProcess = await response.json();
      assert.equal(sourceProcess.fixture, 'local-staging'); assert.equal(sourceProcess.auth, null); assert.equal(sourceProcess.cookie, null);
      assert.match(sourceProcess.nonce, /^[a-f0-9]{32}$/); assert.equal(typeof sourceProcess.pid, 'number');
      const launch = { command: 'set -eu\nexec python3 -u /workspace/staging-preview.py', cwd: '/workspace', readiness: { port: 3000, path: '/', timeoutMs: 60000 } };
      const configured = await source.configureStartup(launch);
      assert.deepEqual(configured.launch, launch);
      const afterConfiguration = await gateway.fetch(preview.url);
      assert.equal(afterConfiguration.status, 200); assert.deepEqual(await afterConfiguration.json(), sourceProcess);
      const listed = (await primary.client.list()).containers.find(value => value.id === source.id && value.createdAt === source.createdAt);
      assert.deepEqual(listed.launch, launch);
      report.restoreStartup = { source: sourceProcess, launch, sourceUnchangedByConfiguration: true };
      report.checks.sourceStartupConfiguration = true;
      const blocked = await gateway.fetch(`http://${'a'.repeat(48)}.localhost:${port}/`);
      assert.equal(blocked.status, 404); report.checks.protectedPreviewAndHeaderIsolation = true;
    });
    if (report.checks.nativeSnapshot) {
      await phase('fork-independent-filesystem', async () => {
        assert.ok(report.accountStartsRequested < report.maxAccountStarts); report.accountStartsRequested++; report.forkKey = randomUUID(); await persist();
        fork = await source.fork({ name: 'Local staging fork', idempotencyKey: report.forkKey, waitTimeoutMs: 60_000, pollIntervalMs: 50 });
        known.push(identity(fork)); ownedIds.add(fork.id); report.generations.push({ action: 'fork', ...identity(fork) });
        await restoredListener(fork, 'fork');
        const original = await gateway.fetch(preview.url); assert.equal(original.status, 200);
        assert.deepEqual(await original.json(), report.restoreStartup.source);
        report.checks.forkAutomaticListener = true;
        assert.notEqual(fork.id, source.id);
        assert.equal(new TextDecoder().decode(await fork.files.read('/workspace/nested/marker')), 'source');
        await fork.files.write('/workspace/nested/marker', new TextEncoder().encode('fork'));
        assert.equal(new TextDecoder().decode(await source.files.read('/workspace/nested/marker')), 'source');
        const status = await primary.client.list(); assert.ok(status.containers.some(value => value.id === source.id && value.createdAt === source.createdAt && value.status === 'running'));
        assert.equal((await fork.commands.run('test "$(readlink /workspace/staging-link)" = nested/marker && test "$(stat -c %a /workspace/nested/marker)" = 640', { timeoutMs: 15_000 })).exitCode, 0);
        assert.deepEqual((await fork.code.list()).contexts, []); report.checks.forkSourceAliveAndIndependent = true;
      });
      await phase('stop-resume-generation-fencing', async () => {
        report.stopKey = randomUUID(); await persist();
        const stopped = await source.stop({ idempotencyKey: report.stopKey });
        const descriptor = stopped.containers.find(value => value.id === source.id && value.status === 'stopped'); assert.ok(descriptor?.workspaceId);
        assert.deepEqual(descriptor.launch, report.restoreStartup.launch);
        assert.ok(!(await primary.client.list()).containers.some(value => value.id === source.id && value.status === 'running'));
        report.checks.stoppedContextDenied = await denied(() => context.run('sum(values)'), [404, 409]);
        const deadPreview = await gateway.fetch(preview.url); assert.ok([403, 404].includes(deadPreview.status)); await deadPreview.arrayBuffer(); report.checks.stoppedPreviewDenied = deadPreview.status;
        assert.ok(report.accountStartsRequested < report.maxAccountStarts); report.accountStartsRequested++; report.resumeKey = randomUUID(); await persist();
        resumed = await source.resume({ idempotencyKey: report.resumeKey, waitTimeoutMs: 60_000, pollIntervalMs: 50 });
        known.push(identity(resumed)); report.generations.push({ action: 'resume', ...identity(resumed) });
        await restoredListener(resumed, 'resume');
        assert.notEqual(report.restoreStartup.resume.process.nonce, report.restoreStartup.fork.process.nonce);
        report.checks.resumeAutomaticListener = true;
        assert.equal(resumed.id, source.id); assert.notEqual(resumed.createdAt, source.createdAt);
        const bytes = await resumed.files.read('/workspace/staging 界 &?.bin'); assert.equal(checksum(bytes), report.binaryFile.sha256);
        assert.equal((await resumed.commands.run('test "$(cat /workspace/staging-link)" = source && test "$(stat -c %a /workspace/nested/marker)" = 640 && test "$(stat -c %Y /workspace/nested/marker)" = 1700000000', { timeoutMs: 15_000 })).exitCode, 0);
        assert.deepEqual((await resumed.code.list()).contexts, []);
        assert.ok(!(await resumed.commands.list()).executions.some(value => value.id === job.id && ['starting', 'running'].includes(value.status)));
        const stalePreview = await gateway.fetch(preview.url); assert.ok([403, 404].includes(stalePreview.status)); await stalePreview.arrayBuffer(); report.checks.stalePreviewDenied = stalePreview.status;
        report.checks.staleRead = await denied(() => source.files.read('/workspace/nested/marker'), [409]);
        report.checks.staleDelete = await denied(() => source.kill(), [409]);
        const replacement = (await primary.client.list()).containers.find(value => value.id === resumed.id); assert.equal(replacement.createdAt, resumed.createdAt);
        const replay = await source.resume({ idempotencyKey: report.resumeKey, waitTimeoutMs: 60_000, pollIntervalMs: 50 }); assert.equal(replay.createdAt, resumed.createdAt);
        await restoredListener(replay, 'resumeReplay');
        assert.equal(report.restoreStartup.resumeReplay.process.nonce, report.restoreStartup.resume.process.nonce);
        assert.equal(report.restoreStartup.resumeReplay.process.pid, report.restoreStartup.resume.process.pid);
        report.checks.restoreReplayDoesNotRelaunch = true;
        report.checks.stopResumePersistenceAndReplay = true;
      });
    } else report.lifecycleBlocked = report.nativeSnapshot.snapshotError;
    await phase('final-billing-and-cleanup-inventory', async () => {
      const inventory = await accounts.get(accounts.idFromName(`account:${primary.userId}`)).fetch('http://local/billing/history', { headers: { 'x-mainbrella-user': primary.userId } });
      assert.equal(inventory.status, 200); const history = await inventory.json();
      report.billingHistory = { source: 'private local account DO inventory', resourceCount: history.resources.length, activeResourceCount: history.activeResources.length, usedCents: history.totals.usedCents };
      report.checks.noWorkerOutboundFetches = report.workerOutboundFetchAttempts === 0;
    });
  } catch (error) {
    report.failedStage = report.stage;
    report.error = { name: error.name, code: typeof error.code === 'string' ? error.code : 'local_staging_check_failed', message: String(error.message).slice(0, 1000), stack: String(error.stack).split('\n').slice(1, 5) };
  } finally {
    clearTimeout(deadline);
    report.stage = 'cleanup'; report.cleanup = { generations: [], snapshots: [], dockerContainers: [], errors: [], snapshotInventoryScope: 'Only actor-reported handles; excludes unobservable captures before durable handle persistence' };
    const cleanupEndsAt = Date.now() + report.cleanupAllowanceMs;
    const remainingCleanup = maximum => {
      const remaining = cleanupEndsAt - Date.now();
      if (remaining <= 0) throw new Error('cleanup_deadline_exceeded');
      return Math.min(maximum, remaining);
    };
    const cleanupCall = (action, maximum, code) => { const timeoutMs = remainingCleanup(maximum); return bounded(action(), timeoutMs, code); };
    const cleanupDocker = args => docker(args, remainingCleanup(10_000));
    await persist();
    if (nativeNamespace) {
      try { for (const handle of await cleanupCall(() => nativeNamespace.get(nativeNamespace.idFromName('probe')).qualificationSnapshots(), 45_000, 'native_snapshot_inventory_timeout')) if (handle.id) snapshots.add(handle.id); }
      catch { report.cleanup.errors.push('native_snapshot_inventory_unavailable'); }
    }
    if (namespace && primary) {
      for (const id of ownedIds) {
        try { for (const handle of await cleanupCall(() => namespace.get(namespace.idFromName(machineName(primary.userId, id))).qualificationSnapshots(), 5000, 'snapshot_inventory_timeout')) if (handle.id) snapshots.add(handle.id); }
        catch { report.cleanup.errors.push('snapshot_inventory_unavailable'); }
      }
    }
    if (primary) {
      try { await cleanupCall(async () => {
        const active = await primary.cleanup.list();
        for (const value of active.containers) {
          // Cleanup is limited to this runner's known account slots/generations.
          if (!known.some(item => item.id === value.id && item.createdAt === value.createdAt)) {
            // The account and key were generated exclusively for this run.
            // Recover an accepted start whose response was interrupted, then
            // delete only the exact identity observed in that owned account.
            known.push(identity(value)); report.cleanup.reconciledGenerations ??= []; report.cleanup.reconciledGenerations.push(identity(value)); await persist();
          }
          try { await primary.cleanup.connect(identity(value)).kill(); report.cleanup.generations.push(identity(value)); } catch { report.cleanup.errors.push('generation_cleanup_failed'); }
        }
        for (const workspace of (await primary.cleanup.workspaces.list()).workspaces) await primary.cleanup.workspaces.delete(workspace.id);
        report.cleanup.remainingContainers = (await primary.cleanup.list()).containers.length;
      }, 45_000, 'api_cleanup_timeout'); } catch { report.cleanup.errors.push('api_cleanup_unavailable'); }
    }
    if (mf) { try { await cleanupCall(() => mf.dispose(), 20_000, 'miniflare_dispose_timeout'); } catch { report.cleanup.errors.push('miniflare_dispose_failed'); } }
    try {
      const owned = cleanupDocker(['ps', '-a', '--format', '{{.ID}}\t{{.Names}}']).split('\n').filter(line => line.split('\t')[1]?.startsWith(`workerd-${runtimeName}-`)).map(line => line.split('\t')[0]);
      if (owned.length) { cleanupDocker(['rm', '-f', ...owned]); report.cleanup.dockerContainers = owned; }
      const snapshotNames = [];
      for (const id of snapshots) {
        if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) { report.cleanup.errors.push('invalid_snapshot_cleanup_id'); continue; }
        snapshotNames.push(`workerd-container-snap-${id}:latest`);
      }
      if (snapshotNames.length) { cleanupDocker(['image', 'rm', ...snapshotNames]); report.cleanup.snapshots = [...snapshots]; }
      report.cleanup.remainingOwnedDockerContainers = cleanupDocker(['ps', '-a', '--format', '{{.Names}}']).split('\n').filter(name => name.startsWith(`workerd-${runtimeName}-`));
      report.cleanup.remainingOwnedSnapshotImages = cleanupDocker(['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}']).split('\n').filter(name => snapshotNames.includes(name));
      report.cleanup.remainingOwnedSnapshotImages = [...new Set(report.cleanup.remainingOwnedSnapshotImages)];
      if (report.cleanup.remainingOwnedDockerContainers.length || report.cleanup.remainingOwnedSnapshotImages.length) report.cleanup.errors.push('owned_docker_inventory_not_empty');
    } catch { report.cleanup.errors.push('docker_cleanup_failed'); }
    await rm(work, { recursive: true, force: true });
    report.finishedAt = new Date().toISOString();
    report.ok = !report.error && !report.deadlineExceeded && !report.interruptedBy && report.checks.nativeSnapshot === true && report.checks.stopResumePersistenceAndReplay === true
      && report.checks.immediateCommandCancellationPreservesSandbox === true && report.checks.noWorkerOutboundFetches === true && report.cleanup.errors.length === 0 && report.cleanup.remainingContainers === 0
      && report.checks.sourceStartupConfiguration === true && report.checks.forkAutomaticListener === true && report.checks.resumeAutomaticListener === true && report.checks.restoreReplayDoesNotRelaunch === true;
    report.stage = 'completed'; await persist();
    process.removeListener('SIGINT', onSigint); process.removeListener('SIGTERM', onSigterm);
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseLocalStagingArgs(process.argv.slice(2));
    const report = await qualifyLocalStaging(options);
    console.log(JSON.stringify({ output: options.output, ok: report.ok, stage: report.stage, checks: report.checks, cleanup: report.cleanup, error: report.error }, null, 2));
    if (!report.ok) process.exitCode = report.interruptedBy === 'SIGINT' ? 130 : report.interruptedBy === 'SIGTERM' ? 143 : 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
