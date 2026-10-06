import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Mainbrella } from '../sdk/javascript/index.js';
import { deploymentPreflight } from './sdk-deployed-workflow.mjs';
import { previewBytes, previewCss, previewHtml } from './preview-app.mjs';

const same = (a, b) => a.id === b.id && a.createdAt === b.createdAt;
const requireCheck = value => { if (!value) throw new Error('check_failed'); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const sources = ['scripts/verify-previews.mjs', 'scripts/preview-app.mjs', 'scripts/sdk-deployed-workflow.mjs', 'sdk/javascript/index.js'];

export function parsePreviewArgs(args, env = process.env) {
  const options = {};
  for (const arg of args) {
    const match = /^--(output|max-starts|preview-domain|api-revision|runtime-revision|gateway-revision)=(.+)$/.exec(arg);
    if (!match || Object.hasOwn(options, match[1])) throw new Error('invalid_arguments');
    options[match[1]] = match[2];
  }
  const domain = options['preview-domain'];
  if (!options.output || options['max-starts'] !== '1'
    || !['api-revision', 'runtime-revision', 'gateway-revision'].every(name => /^[a-f0-9]{7,64}$/.test(options[name] ?? ''))
    || !domain || domain.length > 190 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)
    || domain === 'mainbrella.com' || domain.endsWith('.mainbrella.com')) throw new Error('invalid_arguments');
  // Reuse the SDK's credential/origin validation before creating any evidence or making requests.
  const client = new Mainbrella({ apiKey: env.MAINBRELLA_API_KEY, baseUrl: env.MAINBRELLA_API_URL });
  return { output: resolve(options.output), client, apiOrigin: client.baseUrl, previewDomain: domain,
    revisions: { source: 'operator_supplied', api: options['api-revision'], runtime: options['runtime-revision'], gateway: options['gateway-revision'] },
    target: ['localhost', '127.0.0.1', '[::1]'].includes(new URL(client.baseUrl).hostname) ? 'loopback' : 'deployed' };
}

export function validatePreview(grant, sandbox, domain, now) {
  const url = new URL(grant.url);
  requireCheck(/^[a-f0-9]{32}$/.test(grant.id ?? '') && grant.port === 3000 && grant.createdAt === sandbox.createdAt
    && Number.isSafeInteger(grant.expiresAt) && grant.expiresAt > now && grant.expiresAt <= now + 301_000
    && url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.search && !url.hash && url.pathname === '/'
    && new RegExp(`^[a-f0-9]{48}\\.${domain.replaceAll('.', '\\.')}$`).test(url.hostname));
  return url;
}

async function bounded(promise, ms = 10_000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('probe_timeout')), ms); })]); }
  finally { clearTimeout(timer); }
}

async function bodyBytes(response) {
  const reader = response.body?.getReader();
  requireCheck(reader);
  const chunks = []; let length = 0;
  try {
    for (;;) {
      const { value, done } = await bounded(reader.read());
      if (done) break;
      length += value.length; requireCheck(length <= 4096); chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel().catch(() => {}); }
}

export async function connectPreviewSocket(url, Socket = globalThis.WebSocket) {
  const address = new URL('/ws', url); address.protocol = 'wss:';
  const socket = new Socket(address);
  const closed = new Promise(resolve => socket.addEventListener('close', resolve, { once: true }));
  // Install all listeners before waiting for open; early errors cannot be missed.
  const echoed = new Promise((resolve, reject) => {
    socket.addEventListener('message', event => event.data === 'mainbrella-preview' ? resolve() : reject(new Error('bad_echo')), { once: true });
    socket.addEventListener('error', () => reject(new Error('socket_failed')), { once: true });
    socket.addEventListener('close', () => reject(new Error('socket_closed')), { once: true });
  });
  echoed.catch(() => {});
  try {
    await bounded(new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('socket_failed')), { once: true });
      socket.addEventListener('close', () => reject(new Error('socket_closed')), { once: true });
    }));
    socket.send('mainbrella-preview'); await bounded(echoed);
    return { socket, closed };
  } catch (error) { socket.close(); throw error; }
}

export async function verifyPreviews(client, {
  previewDomain, checkpoint = async () => {}, fetcher = globalThis.fetch, wait = delay, now = Date.now,
  connectSocket = connectPreviewSocket, appSource,
} = {}) {
  const report = { formatVersion: 1, ok: false, releaseQualified: false, maxStarts: 1, size: 'lite', catalogId: 'node',
    cleanup: 'not_needed', stage: 'preflight', checks: {}, grants: [],
    pendingGates: ['real_framework_browser', 'cross_account_isolation', 'replacement_generation', 'domain_tls_logging_review'] };
  let sandbox, streamReader;
  const sockets = [];
  const save = () => checkpoint(structuredClone(report));
  // Preview traffic never uses the SDK/account credential. Redirects stay on the inspected origin.
  const request = (url, options = {}) => fetcher(url, { ...options, credentials: 'omit', redirect: 'manual', signal: options.signal ?? AbortSignal.timeout(15_000) });
  const stage = async name => { report.stage = name; await save(); };
  const issue = async (purpose, ttlSeconds) => {
    const record = { purpose, state: 'issuing' }; report.grants.push(record); await save();
    let grant;
    try { grant = await sandbox.previews.create(3000, { ttlSeconds }); }
    catch (error) {
      if (/^[a-f0-9]{32}$/.test(error.previewId ?? '')) record.id = error.previewId;
      record.state = 'reconcile'; throw error;
    }
    // Retain safe metadata even if the returned bearer URL is malformed.
    if (/^[a-f0-9]{32}$/.test(grant.id ?? '')) record.id = grant.id;
    const url = validatePreview(grant, sandbox, previewDomain, now());
    record.expiresAt = grant.expiresAt; record.state = 'issued'; await save();
    return { grant, url, record };
  };
  const denied = async (url, statuses = [404]) => {
    const response = await request(url);
    try { requireCheck(statuses.includes(response.status)); }
    finally { await response.body?.cancel().catch(() => {}); }
  };
  try {
    requireCheck(typeof appSource === 'string' && Buffer.byteLength(appSource) < 16 * 1024);
    const discovery = await request(new URL('/capabilities', client.baseUrl));
    requireCheck(discovery.ok && (await discovery.json()).previews?.supported === true);
    // Check the deployed edge before spending a start or issuing a bearer URL.
    // A random, unissued token exercises wildcard DNS/TLS and the gateway route.
    // Cloudflare can add reporting headers after the Worker returns its response.
    await stage('edge');
    const edge = await request(new URL(`https://${randomBytes(24).toString('hex')}.${previewDomain}/`));
    try {
      requireCheck(edge.status === 404 && edge.headers.get('referrer-policy') === 'no-referrer'
        && edge.headers.get('cache-control')?.includes('no-store')
        && !['nel', 'report-to', 'reporting-endpoints'].some(name => edge.headers.has(name)));
    } finally { await edge.body?.cancel().catch(() => {}); }
    report.checks.gatewayDnsTls = true;
    report.checks.browserReportingDisabled = true;
    await stage('preflight');
    const before = await deploymentPreflight(client);
    report.apiVersion = before.apiVersion; report.preexisting = before.existing;
    report.creationKey = randomUUID(); report.cleanup = 'reconcile_manually'; await stage('create');
    const candidate = await client.create({ catalogId: 'node', size: 'lite', idempotencyKey: report.creationKey });
    report.container = { id: candidate.id, createdAt: candidate.createdAt };
    requireCheck(!before.existing.some(previous => same(previous, candidate)));
    sandbox = candidate; report.cleanup = 'pending';
    requireCheck(candidate.instance === 'lite');
    await stage('application');
    const path = `/tmp/mainbrella-preview-${report.creationKey}.mjs`;
    await sandbox.files.write(path, new TextEncoder().encode(appSource));
    report.executionKey = randomUUID(); await save();
    const job = await sandbox.commands.start(['node', path], { timeoutMs: 240_000, idempotencyKey: report.executionKey });
    report.executionId = job.id; await save();
    let ready = false;
    for (let i = 0; i < 30; i++) {
      const status = await job.get();
      if (!['starting', 'running'].includes(status.status)) throw new Error('app_not_running');
      if (status.status === 'running' && status.stdout === 'mainbrella-preview-ready\n') { ready = true; break; }
      await wait(500);
    }
    requireCheck(ready); report.checks.application = true;
    await stage('http');
    const active = await issue('revocation', 300);
    const expiry = await issue('expiry', 60);
    requireCheck(expiry.grant.expiresAt <= now() + 61_000);
    const read = async (path, expected) => {
      const response = await request(new URL(path, active.url)); requireCheck(response.status === 200);
      requireCheck((await bodyBytes(response)).equals(Buffer.from(expected)));
    };
    await read('/', previewHtml); await read('/app.css', previewCss); await read('/binary', previewBytes);
    const javascript = await request(new URL('/app.js', active.url));
    requireCheck(javascript.status === 200 && (await bodyBytes(javascript)).toString().includes("'/ws'"));
    report.checks.httpAssetsBinary = true;
    const echo = await request(new URL('/echo?probe=one%20two', active.url), { method: 'POST', body: previewBytes,
      headers: { Authorization: 'probe-must-be-stripped', Cookie: 'probe=must-be-stripped', Referer: 'https://example.com/probe', Origin: active.url.origin } });
    requireCheck(echo.status === 200 && !echo.headers.has('set-cookie') && echo.headers.get('cache-control')?.includes('no-store')
      && echo.headers.get('referrer-policy') === 'no-referrer');
    const echoed = JSON.parse((await bodyBytes(echo)).toString());
    requireCheck(JSON.stringify(echoed.bytes) === JSON.stringify([...previewBytes]) && echoed.query === '?probe=one%20two'
      && echoed.authorization === null && echoed.cookie === null && echoed.referer === null && echoed.origin === active.url.origin);
    report.checks.credentialStripping = true;
    const redirect = await request(new URL('/redirect', active.url));
    try { requireCheck(redirect.status === 302 && redirect.headers.get('location') === '/binary'); }
    finally { await redirect.body?.cancel().catch(() => {}); }
    report.checks.relativeRedirect = true;
    const listing = await sandbox.previews.list();
    requireCheck(Array.isArray(listing.previews) && listing.previews.some(p => p.id === active.grant.id)
      && listing.previews.every(p => Object.keys(p).every(key => ['id', 'port', 'createdAt', 'expiresAt'].includes(key))));
    report.checks.metadataOnly = true;
    // Bypass SDK input validation to check the deployed endpoint's control-port rejection.
    try {
      await client.request(sandbox.path('/containers/previews'), { method: 'POST', body: { port: 22, ttlSeconds: 60 } });
      throw new Error('port_accepted');
    } catch (error) { requireCheck(error.status === 400 && error.code === 'invalid_request'); }
    report.checks.controlPortRejected = true;
    const invalid = new URL(active.url);
    // The wrong token is freshly random so it cannot match another customer's grant.
    invalid.hostname = `${createHash('sha256').update(randomUUID()).digest('hex').slice(0, 48)}.${previewDomain}`;
    await denied(invalid); await denied(new URL(`https://invalid.${previewDomain}/`));
    await denied(new URL('/auth/me', active.url)); report.checks.gatewayIsolation = true;
    await stage('revocation');
    const connection = await connectSocket(active.url); sockets.push(connection);
    const expiringConnection = await connectSocket(expiry.url); sockets.push(expiringConnection);
    const expiredAt = expiringConnection.closed.then(() => now());
    report.checks.websocketEcho = true;
    const streamSignal = AbortSignal.timeout(15_000);
    const stream = await request(new URL('/stream', active.url), { signal: streamSignal }); requireCheck(stream.status === 200);
    streamReader = stream.body.getReader();
    const first = await bounded(streamReader.read());
    requireCheck(!first.done && Buffer.from(first.value).toString() === 'mainbrella-stream\n');
    let streamSettled = false;
    const streamClosed = streamReader.read().then(result => { streamSettled = true; requireCheck(result.done); }, error => {
      streamSettled = true;
      // A transport reset is expected; a local deadline abort is not revocation evidence.
      requireCheck(!streamSignal.aborted && !['TimeoutError', 'AbortError'].includes(error.name));
    });
    streamClosed.catch(() => {});
    // Observe liveness before the mutation: an already completed response is
    // not evidence that revocation closed an active transport.
    await wait(250);
    requireCheck(!streamSettled && connection.socket.readyState === 1 && expiringConnection.socket.readyState === 1);
    await sandbox.previews.revoke(active.grant.id); active.record.state = 'revoked';
    await bounded(Promise.all([connection.closed, streamClosed]));
    await denied(active.url); report.checks.activeRevocation = true;
    await stage('expiry');
    const remaining = expiry.grant.expiresAt - now() + 1500;
    requireCheck(remaining <= 62_000);
    if (remaining > 0) await wait(remaining);
    requireCheck(await bounded(expiredAt) >= expiry.grant.expiresAt - 1000); await denied(expiry.url);
    expiry.record.state = 'expired'; report.checks.activeExpiry = true;
    await stage('stop');
    const stopped = await issue('stop', 300);
    const live = await request(stopped.url);
    requireCheck(live.status === 200 && (await bodyBytes(live)).toString() === previewHtml);
    const stoppedConnection = await connectSocket(stopped.url); sockets.push(stoppedConnection);
    requireCheck(stoppedConnection.socket.readyState === 1);
    await sandbox.kill();
    const after = await client.list(); requireCheck(Array.isArray(after.containers) && !after.containers.some(c => same(c, sandbox)));
    report.cleanup = 'completed';
    await bounded(stoppedConnection.closed); report.checks.activeStop = true;
    await denied(stopped.url, [403, 404]); report.checks.stoppedAccess = true;
  } catch { report.error = `${report.stage}_failed`; }
  finally {
    // Attempt generation-specific cleanup even after checkpoint/storage failures.
    try {
      if (sandbox && report.cleanup !== 'completed') {
        try { await stage('cleanup'); }
        finally {
          try {
            await sandbox.kill();
            const after = await client.list(); requireCheck(Array.isArray(after.containers) && !after.containers.some(c => same(c, sandbox)));
            report.cleanup = 'completed';
          } catch { report.cleanup = 'failed'; }
        }
      }
    } finally {
      for (const { socket } of sockets) socket.close();
      await streamReader?.cancel().catch(() => {});
    }
  }
  report.stage = 'finished'; report.ok = !report.error && report.cleanup === 'completed'; await save();
  return report;
}

export async function runPreviewVerification(options) {
  await mkdir(dirname(options.output), { recursive: true });
  await mkdir(options.output, { mode: 0o700 }); // Never overwrite a previous recovery checkpoint.
  const root = fileURLToPath(new URL('../', import.meta.url));
  const verifierSources = await Promise.all(sources.map(async path => ({ path,
    sha256: createHash('sha256').update(await readFile(join(root, path))).digest('hex') })));
  const startedAt = new Date().toISOString();
  const checkpoint = async result => {
    const path = join(options.output, 'preview-verification.json');
    await writeFile(`${path}.tmp`, JSON.stringify({ ...result, startedAt, node: process.version, target: options.target,
      apiOrigin: options.apiOrigin, previewDomain: options.previewDomain, deploymentRevisions: options.revisions, verifierSources }, null, 2) + '\n', { mode: 0o600 });
    await rename(`${path}.tmp`, path);
  };
  return verifyPreviews(options.client, { previewDomain: options.previewDomain, checkpoint,
    appSource: await readFile(join(root, 'scripts/preview-app.mjs'), 'utf8') });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parsePreviewArgs(process.argv.slice(2));
    const result = await runPreviewVerification(options);
    console.log(JSON.stringify({ ok: result.ok, releaseQualified: false, cleanup: result.cleanup, output: options.output }));
    process.exitCode = result.ok ? 0 : 1;
  } catch {
    console.error('Use --output=NEW_DIR --max-starts=1 --preview-domain=DOMAIN --api-revision=SHA --runtime-revision=SHA --gateway-revision=SHA with MAINBRELLA_API_KEY and MAINBRELLA_API_URL. Evidence is never overwritten; inspect its recovery checkpoint after interruption.');
    process.exitCode = 1;
  }
}
