#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rename, rm, lstat, readdir, open, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

export const chunkSize = 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

// Only public build output belongs here. Reject links rather than exporting files outside it.
async function checkTree(path) {
  const info = await lstat(path);
  if (info.isDirectory()) for (const name of await readdir(path)) await checkTree(join(path, name));
  else if (!info.isFile()) throw new Error('Build output must contain only directories and regular files');
}

// A small static server, including root-relative assets; no SPA fallback or framework runtime.
export const serverSource = String.raw`
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const root = require('node:fs').realpathSync(process.argv[2]);
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.mjs':'text/javascript', '.css':'text/css', '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.gif':'image/gif', '.ico':'image/x-icon', '.woff':'font/woff', '.woff2':'font/woff2', '.wasm':'application/wasm', '.pdf':'application/pdf', '.txt':'text/plain; charset=utf-8' };
http.createServer(async (req, res) => {
  if (!['GET','HEAD'].includes(req.method)) { res.writeHead(405, {Allow:'GET, HEAD'}); return res.end(); }
  try {
    const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    let file = path.resolve(root, '.' + name);
    if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
    if ((await fs.stat(file)).isDirectory()) {
      if (!new URL(req.url, 'http://localhost').pathname.endsWith('/')) {
        res.writeHead(308, {Location: new URL(req.url, 'http://localhost').pathname + '/' + new URL(req.url, 'http://localhost').search}); return res.end();
      }
      file = path.join(file, 'index.html');
    }
    file = await fs.realpath(file);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
    const bytes = await fs.readFile(file);
    res.writeHead(200, {'Content-Type':types[path.extname(file)] || 'application/octet-stream', 'Content-Length':bytes.length});
    res.end(req.method === 'HEAD' ? undefined : bytes);
  } catch { res.writeHead(404); res.end('Not found'); }
}).listen(Number(process.argv[3]), '0.0.0.0');
`;

export function requester({ base, key, fetcher = fetch }) {
  return async (path, method = 'GET', body, extra = {}) => {
    const binary = body instanceof Uint8Array;
    const response = await fetcher(new URL(path, base), {
      method, redirect: 'error', signal: AbortSignal.timeout(90_000),
      headers: { ...(path === '/capabilities' ? {} : { Authorization: `Bearer ${key}` }),
        ...(body === undefined ? {} : { 'Content-Type': binary ? 'application/octet-stream' : 'application/json' }), ...extra },
      body: binary ? body : body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const known = new Set(['not_authenticated', 'subscription_required', 'subscription_unavailable', 'invalid_generation', 'origin_not_allowed', 'image_not_found', 'image_not_ready', 'container_quota_exceeded', 'container_limit_exceeded', 'compute_capacity_exceeded', 'compute_allowance_exhausted', 'container_not_running', 'preview_reconciliation_required', 'previews_unavailable', 'preview_limit', 'execution_limit', 'execution_failed', 'file_too_large', 'file_not_found', 'idempotency_key_conflict', 'creation_no_longer_running', 'image_not_available']);
      let data; try { data = await response.json(); } catch {}
      const code = known.has(data?.error) ? data.error : 'request_failed';
      const error = new Error(`API request failed: HTTP ${response.status} (${code})`);
      error.status = response.status; error.code = code;
      if (/^[a-f0-9-]{36}$/.test(data?.previewId ?? '')) error.previewId = data.previewId;
      throw error;
    }
    if (method === 'GET' && path.startsWith('/containers/files?')) return new Uint8Array(await response.arrayBuffer());
    return response.json();
  };
}

// Save before each mutation. No automatic cleanup or replay of uncertain commands/previews.
export async function deploy({ request, archive, index, checks = [{ path: '/', bytes: index }], save, state, wait = () => new Promise(r => setTimeout(r, 1000)), fetcher = fetch }) {
  const step = async name => { state.step = name; await save(state); };
  let owned;
  const command = async (name, text, timeoutMs = 30_000) => {
    await step(name);
    state.lastCommand = { command: text, pending: true }; await save(state);
    const result = await request(`/containers/exec?${new URLSearchParams(owned)}`, 'POST', { command: text, timeoutMs });
    state.lastCommand = { command: text, result }; await save(state);
    if (result.exitCode !== 0 || result.timedOut !== false || result.outputTruncated !== false) throw new Error(`Command failed at ${name}`);
    return result;
  };
  try {
    await step('preflight');
    const caps = await request('/capabilities');
    const status = await request('/containers');
    if (!caps?.previews?.supported || !caps?.execution?.foreground || !caps?.files?.write || !caps?.files?.read || !caps?.files?.binary
      || !status.active || !status.imageCatalog?.some(image => image.id === 'node')
      || status.containers.length >= status.limits.maxContainers || status.usage.starts >= status.limits.maxStartsPerMonth
      || status.usage.availableComputeUnitHours <= 0
      || status.limits.maxConcurrentComputeUnits !== undefined && (status.usage.concurrentComputeUnits ?? 0) + 1 > status.limits.maxConcurrentComputeUnits) throw new Error('Preflight failed: check capabilities, Node image and allowance');
    state.creationKey = randomUUID(); state.creationBody = { catalogId: 'node', size: 'lite' };
    state.archive = { bytes: archive.length, sha256: hash(archive), chunks: Math.ceil(archive.length / chunkSize) };
    await step('creating');
    let response;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await wait();
      try {
        response = await request('/containers', 'POST', state.creationBody, { 'Idempotency-Key': state.creationKey });
      } catch (error) { state.creationError = error.message; await save(state); if (error.status && error.status < 500) throw error; continue; }
      if (response.creation?.status === 'running') break;
      if (response.creation?.status !== 'starting') break;
    }
    const creation = response?.creation;
    const candidate = response?.containers?.find(c => c.id === creation?.containerId && c.createdAt === creation?.createdAt && c.status === 'running');
    if (creation?.status !== 'running' || !candidate || !Number.isFinite(Date.parse(candidate.createdAt))) throw new Error('Creation unresolved: reconcile the saved body/key within 24 hours');
    owned = state.container = { id: candidate.id, createdAt: candidate.createdAt };
    state.containerExpiresAt = candidate.expiresAt; await save(state);
    const dir = `/tmp/mainbrella-static-${state.creationKey}`;
    state.remoteDir = dir; await save(state);
    await command('prepare', `command -v node && command -v tar && command -v setsid && command -v nohup && mkdir -p ${quote(dir + '/site')}`);
    const filePath = path => `/containers/files?${new URLSearchParams({ ...owned, path })}`;
    for (let offset = 0, n = 0; offset < archive.length; offset += chunkSize, n++) {
      state.uploadChunk = n; await step('uploading');
      const bytes = archive.subarray(offset, offset + chunkSize);
      const path = filePath(`${dir}/part-${String(n).padStart(6, '0')}`);
      try { await request(path, 'PUT', bytes); }
      catch (error) { // Reconcile an uncertain atomic write before any further action.
        const read = await request(path);
        if (hash(read) !== hash(bytes)) throw error;
      }
    }
    await command('assemble', `cat ${quote(dir)}/part-* > ${quote(dir + '/site.tar.gz')} && node -e ${quote("const fs=require('node:fs'),c=require('node:crypto');if(c.createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex')!==process.argv[2])process.exit(1)")} ${quote(dir + '/site.tar.gz')} ${quote(state.archive.sha256)} && tar -xzf ${quote(dir + '/site.tar.gz')} -C ${quote(dir + '/site')}`, 60_000);
    await step('upload-server');
    await request(filePath(dir + '/server.cjs'), 'PUT', Buffer.from(serverSource));
    await command('start-server', `setsid nohup node ${quote(dir + '/server.cjs')} ${quote(dir + '/site')} 3000 > ${quote(dir + '/server.log')} 2>&1 < /dev/null &`);
    await wait();
    const probe = `const fs=require('node:fs');(async()=>{for(let i=0;i<10;i++){try{const r=await fetch('http://127.0.0.1:3000/',{signal:AbortSignal.timeout(1000)});if(r.status===200)process.exit(0)}catch{}await new Promise(r=>setTimeout(r,500))}console.error(fs.readFileSync(process.argv[1],'utf8'));process.exit(1)})()`;
    await command('readiness', `node -e ${quote(probe)} ${quote(dir + '/server.log')}`);
    await step('creating-preview'); // A lost response is deliberately never retried.
    state.previewPending = true; await save(state);
    const preview = await request(`/containers/previews?${new URLSearchParams(owned)}`, 'POST', { port: 3000, ttlSeconds: 900 });
    state.preview = preview; state.previewPending = false; await save(state);
    if (!Number.isFinite(preview.expiresAt) || preview.expiresAt <= Date.now() || new URL(preview.url).protocol !== 'https:') throw new Error('Invalid preview metadata');
    await step('verify-url');
    state.verifiedPaths = [];
    for (const check of checks) {
      const served = await fetcher(new URL(check.path, preview.url), { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
      if (served.status !== 200 || hash(new Uint8Array(await served.arrayBuffer())) !== hash(check.bytes)) throw new Error(`Preview content verification failed: ${check.path}`);
      if (check.redirectFrom) {
        const redirected = await fetcher(new URL(check.redirectFrom, preview.url), { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
        if (redirected.status !== 308 || redirected.headers.get('location') !== check.path) throw new Error(`Preview redirect verification failed: ${check.redirectFrom}`);
      }
      state.verifiedPaths.push(check.path); await save(state);
    }
    const missing = await fetcher(new URL(`/__mainbrella_missing_${state.creationKey}`, preview.url), { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    if (missing.status !== 404) throw new Error('Preview missing-page verification failed');
    await step('completed');
    return { ok: true, previewId: preview.id, expiresAt: new Date(preview.expiresAt).toISOString(), container: owned, stateFile: state.stateFile };
  } catch (error) {
    state.error = error.message;
    state.apiError = { status: error.status, code: error.code, previewId: error.previewId };
    if (owned) {
      try {
        state.serverLog = await request(`/containers/exec?${new URLSearchParams(owned)}`, 'POST',
          { command: `node -e ${quote("const fs=require('node:fs');try{const b=fs.readFileSync(process.argv[1]);process.stdout.write(b.subarray(-8192))}catch{process.exit(1)}")} ${quote(state.remoteDir + '/server.log')}`, timeoutMs: 10_000 });
      } catch { state.diagnostics = 'Server log unavailable'; }
    }
    await save(state);
    return { ok: false, error: error.message, step: state.step, container: owned, stateFile: state.stateFile, cleanup: 'not_attempted' };
  }
}

export async function cleanup({ request, state, save }) {
  if (typeof state.container?.id !== 'string' || !state.container.id || !Number.isFinite(Date.parse(state.container?.createdAt))) throw new Error('No saved generation: reconcile creation with the saved key/body first');
  state.cleanup = 'pending'; await save(state);
  const result = await request(`/containers?${new URLSearchParams(state.container)}`, 'DELETE');
  if (!Array.isArray(result.containers) || result.containers.some(c => c.id === state.container.id && c.createdAt === state.container.createdAt)) throw new Error('Cleanup unresolved');
  state.cleanup = 'completed'; await save(state);
  return { ok: true, cleanup: 'completed', container: state.container };
}

async function main() {
  const args = process.argv.slice(2), options = { checks: [] };
  while (args.length) {
    const flag = args.shift();
    if (flag === '--cleanup' && !options.cleanup) options.cleanup = true;
    else if (['--dist', '--state', '--check'].includes(flag) && args.length && !args[0].startsWith('--')) {
      const value = args.shift();
      if (flag === '--check') options.checks.push(value);
      else if (!options[flag.slice(2)]) options[flag.slice(2)] = value;
      else throw new Error('Duplicate option');
    } else throw new Error('Usage: node mainbrella-deploy-static.mjs --dist dist --state .mainbrella/deployment.json [--check /page/] (or --cleanup --state <file>)');
  }
  if (!options.state || !options.cleanup && !options.dist || options.cleanup && (options.dist || options.checks.length)) throw new Error('Supply --state and either --dist or --cleanup');
  const stateFile = resolve(options.state);
  const base = new URL(process.env.MAINBRELLA_API_URL || 'https://api.mainbrella.com');
  if ((base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(base.hostname))) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('Unsafe API origin');
  if (!process.env.MAINBRELLA_API_KEY?.startsWith('mb_')) throw new Error('Provision MAINBRELLA_API_KEY locally');
  const request = requester({ base, key: process.env.MAINBRELLA_API_KEY });
  const save = async state => {
    const temporary = stateFile + '.' + randomUUID() + '.tmp';
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(state, null, 2) + '\n'); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, stateFile);
  };
  if (options.cleanup) {
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    if (state.apiOrigin !== base.origin) throw new Error('Use the API origin recorded in the state');
    return cleanup({ request, state, save });
  }
  const dist = resolve(options.dist);
  await checkTree(dist);
  const index = await readFile(join(dist, 'index.html'));
  const checks = [{ path: '/', bytes: index }];
  for (const route of options.checks) {
    const parsed = new URL(route, 'https://site.invalid');
    if (!route.startsWith('/') || parsed.origin !== 'https://site.invalid' || parsed.pathname !== route || parsed.search || parsed.hash || route.includes('%') || route.includes('\\')) throw new Error('Checks must be absolute URL paths without queries or escapes');
    const file = resolve(dist, '.' + route);
    if (file !== dist && !file.startsWith(dist + '/')) throw new Error('Invalid check path');
    const directory = (await lstat(file)).isDirectory();
    if (directory && !route.endsWith('/')) throw new Error('Directory checks must end in /');
    checks.push({ path: route, bytes: await readFile(directory ? join(file, 'index.html') : file), redirectFrom: directory && route !== '/' ? route.slice(0, -1) : undefined });
  }
  await mkdir(dirname(stateFile), { recursive: true, mode: 0o700 });
  const work = await mkdtemp(join(tmpdir(), 'mainbrella-static-'));
  try {
    const path = join(work, 'site.tar.gz');
    execFileSync('tar', ['-czf', path, '-C', dist, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
    const archive = await readFile(path);
    const handle = await open(stateFile, 'wx', 0o600); await handle.close();
    const state = { stateFile, apiOrigin: base.origin, dist, step: 'local-build-ready' }; await save(state);
    console.error('Temporary hosting: one start; preview expires within the hard lease and inactivity may stop it earlier. Keep state private.');
    return await deploy({ request, archive, index, checks, save, state });
  } finally { await rm(work, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { const result = await main(); console.log(JSON.stringify(result, null, 2)); process.exitCode = result.ok ? 0 : 1; }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
