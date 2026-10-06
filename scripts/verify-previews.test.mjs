import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPreviewApp, previewBytes, previewHtml } from './preview-app.mjs';
import { parsePreviewArgs, validatePreview, verifyPreviews, connectPreviewSocket, runPreviewVerification } from './verify-previews.mjs';

const key = `mb_${'a'.repeat(64)}`;
const domain = 'preview-example.net';
const existing = { id: 'c1', createdAt: '2026-10-05T12:00:00.000Z' };
const identity = { id: 'small', createdAt: '2026-10-05T12:01:00.000Z', instance: 'lite' };
const appSource = await readFile(new URL('./preview-app.mjs', import.meta.url), 'utf8');
const args = ['--output=/tmp/evidence', '--max-starts=1', `--preview-domain=${domain}`,
  '--api-revision=abcdef1', '--runtime-revision=abcdef2', '--gateway-revision=abcdef3'];
const capabilities = { previews: { supported: true }, apiVersion: '2026-10-05',
  containers: { idempotentCreate: true, generationRequired: true },
  execution: { foreground: true, background: true, streaming: true, reconnect: true, cancellation: true },
  files: { read: true, write: true, binary: true } };

test('entry point requires one start, deployment revisions, isolated domain and a safe credential origin', () => {
  assert.equal(parsePreviewArgs(args, { MAINBRELLA_API_KEY: key }).target, 'deployed');
  for (const changed of [args.filter(a => !a.startsWith('--max-starts')), [...args, '--max-starts=2'],
    args.filter(a => !a.startsWith('--gateway-revision')), [...args, '--unknown=1']]) {
    assert.throws(() => parsePreviewArgs(changed, { MAINBRELLA_API_KEY: key }));
  }
  for (const invalid of ['mainbrella.com', 'apps.mainbrella.com', '*.example.com', 'http://example.com', 'example.com:443', 'Example.com']) {
    assert.throws(() => parsePreviewArgs(args.map(a => a.startsWith('--preview-domain') ? `--preview-domain=${invalid}` : a), { MAINBRELLA_API_KEY: key }));
  }
  for (const url of ['http://untrusted.example', 'https://user:pass@example.com', 'https://example.com/?secret=1']) {
    assert.throws(() => parsePreviewArgs(args, { MAINBRELLA_API_KEY: key, MAINBRELLA_API_URL: url }));
  }
});

test('preview URL validation rejects account origins, redirects, port/generation mismatches and malformed metadata', () => {
  const now = Date.now();
  const grant = { id: 'b'.repeat(32), port: 3000, createdAt: identity.createdAt, expiresAt: now + 60_000, url: `https://${'c'.repeat(48)}.${domain}/` };
  assert.equal(validatePreview(grant, identity, domain, now).protocol, 'https:');
  for (const patch of [{ url: 'https://api.mainbrella.com/' }, { url: grant.url + '?secret=1' },
    { url: grant.url.replace('https:', 'http:') }, { port: 22 }, { createdAt: existing.createdAt },
    { expiresAt: now - 1 }, { expiresAt: now + 400_000 }, { id: 'bad' }]) {
    assert.throws(() => validatePreview({ ...grant, ...patch }, identity, domain, now));
  }
});

async function fixture(t, { fail, preexisting = false, earlyExpiry = false, checkpointFailure } = {}) {
  const app = createPreviewApp();
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const calls = [], snapshots = [], grants = new Map(); let owned = false, clock = Date.now();
  const state = () => ({ active: true, containers: [existing, ...(owned ? [identity] : [])], imageCatalog: [{ id: 'node' }],
    limits: { maxStartsPerMonth: 10, maxContainers: 5, maxConcurrentComputeUnits: 28 },
    usage: { starts: 0, availableComputeUnitHours: 250, concurrentComputeUnits: 0 } });
  const stopGrant = entry => {
    for (const socket of entry.sockets) socket.close();
    for (const controller of entry.streams) controller.error(new Error('revoked'));
    entry.streams.length = 0;
  };
  const sandbox = { ...identity,
    path: path => path + '?id=small&createdAt=' + identity.createdAt,
    files: { write: async (_path, bytes) => { calls.push('upload'); assert.equal(new TextDecoder().decode(bytes), appSource); } },
    commands: { start: async (argv, options) => {
      calls.push('startApp'); assert.equal(argv[0], 'node'); assert.equal(options.timeoutMs, 240_000);
      return { id: 'safe-execution-id', get: async () => ({ status: 'running', stdout: 'mainbrella-preview-ready\n' }) };
    } },
    previews: {
      create: async (port, { ttlSeconds }) => {
        calls.push('issue'); assert.equal(port, 3000);
        if (fail === 'issue') throw Object.assign(new Error(key), { previewId: 'd'.repeat(32) });
        const id = randomBytes(16).toString('hex'), token = randomBytes(24).toString('hex');
        const grant = { id, port, createdAt: identity.createdAt, expiresAt: clock + ttlSeconds * 1000, url: `https://${token}.${domain}/` };
        grants.set(token, { grant, sockets: [], streams: [], revoked: false });
        return { ...grant, ...(fail === 'url' ? { url: `https://api.mainbrella.com/${key}` } : {}) };
      },
      list: async () => ({ previews: [...grants.values()].map(({ grant: { url, ...metadata } }) => metadata) }),
      revoke: async id => {
        calls.push('revoke'); if (fail === 'revoke') throw new Error(key);
        const entry = [...grants.values()].find(e => e.grant.id === id);
        entry.revoked = true; stopGrant(entry);
        if (earlyExpiry) for (const other of grants.values()) stopGrant(other);
      },
    },
    kill: async () => {
      calls.push('kill'); if (fail === 'cleanup') throw new Error(key);
      owned = false; for (const entry of grants.values()) stopGrant(entry);
    },
  };
  const client = {
    baseUrl: 'https://api.mainbrella.com', capabilities: async () => capabilities, list: async () => state(),
    create: async options => {
      calls.push('create'); assert.equal(snapshots.at(-1).creationKey, options.idempotencyKey);
      assert.equal(options.size, 'lite'); if (fail === 'create') throw new Error(key);
      owned = true; return preexisting ? { ...sandbox, ...existing } : sandbox;
    },
    request: async (_path, { body }) => {
      calls.push('port'); assert.equal(body.port, 22);
      throw Object.assign(new Error('invalid_request'), { status: 400, code: 'invalid_request' });
    },
  };
  const lookup = url => grants.get(new URL(url).hostname.split('.')[0]);
  const fetcher = async (address, options = {}) => {
    const url = new URL(address); calls.push(`fetch:${url.pathname}`);
    assert.equal(options.redirect, 'manual'); assert.equal(options.credentials, 'omit');
    assert.equal(JSON.stringify(options).includes(key), false);
    if (url.hostname === 'api.mainbrella.com') {
      assert.equal(url.pathname, '/capabilities');
      return Response.json(fail === 'capabilities' ? { previews: { supported: false } } : capabilities);
    }
    const entry = lookup(url);
    if (!entry || entry.revoked || entry.grant.expiresAt <= clock) return new Response('Unavailable', { status: 404 });
    if (!owned) return new Response('Unavailable', { status: 403 });
    const headers = new Headers(options.headers); for (const name of ['authorization', 'cookie', 'referer']) headers.delete(name);
    if (fail === 'http') return new Response(key);
    const upstream = await fetch(new URL(url.pathname + url.search, base), { ...options, headers });
    const returned = new Headers(upstream.headers); returned.delete('set-cookie'); returned.set('referrer-policy', 'no-referrer');
    if (url.pathname !== '/stream') return new Response(upstream.body, { status: upstream.status, headers: returned });
    const reader = upstream.body.getReader();
    const body = new ReadableStream({
      start: controller => entry.streams.push(controller),
      pull: async controller => {
        try { const { value, done } = await reader.read(); if (done) controller.close(); else controller.enqueue(value); }
        catch { /* revocation cancels the downstream controller */ }
      },
      cancel: () => reader.cancel().catch(() => {}),
    });
    return new Response(body, { headers: returned });
  };
  const connectSocket = async url => {
    if (fail === 'websocket') throw new Error(key);
    const entry = lookup(url);
    // Use the actual fixture and native WebSocket client over loopback, with a
    // local URL adapter. Provider routing/closure is deliberately simulated.
    class LocalSocket extends WebSocket {
      constructor() { super(base.replace('http:', 'ws:') + '/ws'); }
    }
    const connection = await connectPreviewSocket(url, LocalSocket);
    entry.sockets.push(connection.socket); return connection;
  };
  const wait = async ms => {
    clock += ms;
    for (const entry of grants.values()) if (entry.grant.expiresAt <= clock) stopGrant(entry);
  };
  const checkpoint = async snapshot => {
    snapshots.push(snapshot);
    if (checkpointFailure === snapshot.stage) throw new Error('disk_unavailable');
  };
  return { client, grants, calls, snapshots, options: { appSource, previewDomain: domain, fetcher, connectSocket, wait, now: () => clock, checkpoint } };
}

test('one-start verifier exercises real HTTP/binary/WebSocket fixture and labels remaining release gates', async t => {
  const f = await fixture(t);
  const report = await verifyPreviews(f.client, f.options);
  assert.equal(report.ok, true, JSON.stringify(report)); assert.equal(report.cleanup, 'completed'); assert.equal(report.releaseQualified, false);
  assert.deepEqual(Object.keys(report.checks), ['application', 'httpAssetsBinary', 'credentialStripping', 'relativeRedirect',
    'metadataOnly', 'controlPortRejected', 'gatewayIsolation', 'websocketEcho', 'activeRevocation', 'activeExpiry', 'stoppedAccess']);
  assert.equal(f.calls.filter(c => c === 'create').length, 1); assert.equal(f.calls.filter(c => c === 'kill').length, 1);
  assert.deepEqual(report.preexisting, [existing]); assert.deepEqual(report.container, { id: identity.id, createdAt: identity.createdAt });
  const evidence = JSON.stringify(f.snapshots);
  assert.equal(evidence.includes(key), false);
  for (const token of f.grants.keys()) assert.equal(evidence.includes(token), false);
});

test('disabled previews and ambiguous/pre-existing creation never stop guessed ownership', async t => {
  for (const options of [{ fail: 'capabilities' }, { fail: 'create' }, { preexisting: true }]) {
    const f = await fixture(t, options); const report = await verifyPreviews(f.client, f.options);
    assert.equal(report.ok, false); assert.equal(f.calls.includes('kill'), false);
    if (options.fail === 'capabilities') { assert.equal(f.calls.includes('create'), false); assert.equal(report.cleanup, 'not_needed'); }
    else { assert.ok(report.creationKey); assert.equal(report.cleanup, 'reconcile_manually'); }
  }
});

test('issuance, malformed URLs and transport failures preserve safe recovery identities and clean only the proven generation', async t => {
  for (const fail of ['issue', 'url', 'http', 'websocket', 'revoke', 'cleanup']) {
    const f = await fixture(t, { fail }); const report = await verifyPreviews(f.client, f.options);
    assert.equal(report.ok, false, fail); assert.equal(report.cleanup, fail === 'cleanup' ? 'failed' : 'completed');
    assert.equal(JSON.stringify(report).includes(key), false); assert.deepEqual(report.container, { id: identity.id, createdAt: identity.createdAt });
    if (fail === 'issue') assert.equal(report.grants[0].id, 'd'.repeat(32));
    if (fail === 'url') assert.ok(!f.calls.includes('fetch:/' + key));
  }
});

test('a socket closed before its expiry cannot satisfy the active expiry check', async t => {
  const f = await fixture(t, { earlyExpiry: true });
  const report = await verifyPreviews(f.client, f.options);
  assert.equal(report.ok, false); assert.equal(report.checks.activeExpiry, undefined); assert.equal(report.cleanup, 'completed');
});

test('checkpoint failure before admission prevents starts; later evidence failures still attempt cleanup', async t => {
  const before = await fixture(t, { checkpointFailure: 'create' });
  assert.equal((await verifyPreviews(before.client, before.options)).ok, false); assert.equal(before.calls.includes('create'), false);
  const after = await fixture(t, { checkpointFailure: 'application' });
  assert.equal((await verifyPreviews(after.client, after.options)).cleanup, 'completed'); assert.ok(after.calls.includes('kill'));
});

test('evidence directory is private, loopback labeled and never overwritten', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mainbrella-preview-evidence-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = parsePreviewArgs(args.map(a => a.startsWith('--output') ? `--output=${join(directory, 'new')}` : a),
    { MAINBRELLA_API_KEY: key, MAINBRELLA_API_URL: 'http://127.0.0.1:1' });
  options.client.timeoutMs = 100;
  const report = await runPreviewVerification(options);
  assert.equal(report.ok, false);
  const path = join(options.output, 'preview-verification.json');
  const evidence = JSON.parse(await readFile(path));
  assert.equal(evidence.target, 'loopback'); assert.equal(evidence.releaseQualified, false); assert.equal(evidence.verifierSources.length, 4);
  assert.equal((await stat(path)).mode & 0o777, 0o600); assert.equal((await stat(options.output)).mode & 0o777, 0o700);
  await assert.rejects(runPreviewVerification(options), { code: 'EEXIST' });
});

test('fixture serves a browser page, root-relative asset and exact binary bytes', async t => {
  const app = createPreviewApp(); app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(() => app.close()); const base = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal(await (await fetch(base)).text(), previewHtml);
  assert.equal((await fetch(base + '/app.css')).headers.get('content-type'), 'text/css');
  assert.deepEqual(Buffer.from(await (await fetch(base + '/binary')).arrayBuffer()), previewBytes);
  assert.equal((await fetch(base + '/redirect', { redirect: 'manual' })).headers.get('location'), '/binary');
});
