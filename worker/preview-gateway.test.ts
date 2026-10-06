import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { previewDatabase } from './lib/preview-test-helpers';
import gateway, { handlePreviewGateway } from './preview-gateway';
import { previewTokenHash, previewDomain, previewsConfigured, type PreviewRoutingEnv } from './lib/preview-routing';

const domain = 'preview.example';
const token = 'a'.repeat(48);
const grantId = 'b'.repeat(32);
const generation = '2026-10-05T12:00:00.000Z';

async function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  const calls: Request[] = [];
  const names: string[] = [];
  let response = new Response('application', { headers: { 'cache-control': 'no-store' } });
  const env: PreviewRoutingEnv = { PREVIEWS_ENABLED: 'true', PREVIEW_DOMAIN: domain, PREVIEW_ROUTES: previewDatabase(sqlite),
    USER_CONTAINER: {
      idFromName(name: string) { names.push(name); return name; },
      get() { return { fetch(request: Request) { calls.push(request); return response; } }; },
    } as unknown as DurableObjectNamespace };
  sqlite.prepare('INSERT INTO preview_routes VALUES (?, ?, ?, ?, ?)')
    .run(await previewTokenHash(token), grantId, 'user:owner:slot:1', generation, Date.now() + 60_000);
  return { sqlite, env, calls, names, setResponse(value: Response) { response = value; } };
}

test('gateway requires explicit isolated configuration and exact HTTPS bearer host', async t => {
  const f = await fixture(t);
  for (const invalid of ['', 'mainbrella.com', 'apps.mainbrella.com', 'https://preview.example', '*.preview.example',
    'preview.example:443', 'Preview.example', 'preview.example.', 'localhost', '-preview.example']) {
    assert.equal(previewDomain({ PREVIEW_DOMAIN: invalid }), null, invalid);
    assert.equal(previewsConfigured({ ...f.env, PREVIEW_DOMAIN: invalid }), false);
  }
  for (const url of [`http://${token}.${domain}/`, `https://${token}.${domain}:8443/`, `https://${domain}/`,
    `https://extra.${token}.${domain}/`, `https://${token}.${domain}.evil.example/`, `https://${'c'.repeat(48)}.${domain}/`]) {
    const response = await handlePreviewGateway(new Request(url), f.env);
    assert.equal(response.status, 404, url);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal((await handlePreviewGateway(new Request(`https://${token}.${domain}/`, { headers: { host: 'api.mainbrella.com' } }), f.env)).status, 404);
  for (const env of [{}, { ...f.env, PREVIEWS_ENABLED: 'false' }, { ...f.env, PREVIEW_ROUTES: undefined }, { ...f.env, USER_CONTAINER: undefined }]) {
    assert.equal((await handlePreviewGateway(new Request(`https://${token}.${domain}/`), env)).status, 404);
  }
  assert.equal(f.calls.length, 0);
});

test('gateway forwards paths, queries, methods, binary bodies and abort signals with trusted routing headers', async t => {
  const f = await fixture(t);
  const abort = new AbortController();
  const request = new Request(`https://${token}.${domain}/assets/file.bin?x=1&x=2`, { method: 'POST', body: new Uint8Array([0, 255, 1]),
    signal: abort.signal, headers: { authorization: 'Bearer account-secret', cookie: 'mainbrella_session=account-secret',
      'x-preview-created-at': 'attacker', 'x-preview-token': 'attacker', 'x-preview-origin': 'https://attacker.example', 'x-mainbrella-user': 'victim',
      'cf-connecting-ip': 'secret', 'x-forwarded-host': 'api.mainbrella.com', forwarded: 'secret',
      referer: `https://${token}.${domain}/secret`, 'content-type': 'application/octet-stream',
      origin: `https://${token}.${domain}` } });
  const result = await handlePreviewGateway(request, f.env);
  assert.equal(await result.text(), 'application');
  assert.deepEqual(f.names, ['user:owner:slot:1']);
  const internal = f.calls[0];
  assert.equal(internal.url, 'https://internal/preview/assets/file.bin?x=1&x=2');
  assert.equal(internal.method, 'POST');
  assert.deepEqual(new Uint8Array(await internal.arrayBuffer()), new Uint8Array([0, 255, 1]));
  assert.equal(internal.redirect, 'manual');
  assert.equal(internal.headers.get('x-preview-created-at'), generation);
  assert.equal(internal.headers.get('x-preview-token'), token);
  assert.equal(internal.headers.get('x-preview-origin'), `https://${token}.${domain}`);
  for (const key of ['authorization', 'cookie', 'x-mainbrella-user', 'cf-connecting-ip', 'x-forwarded-host', 'forwarded', 'referer']) {
    assert.equal(internal.headers.get(key), null, key);
  }
  assert.equal(internal.headers.get('origin'), `https://${token}.${domain}`);
  abort.abort();
  assert.equal(internal.signal.aborted, true);
});

test('gateway passes WebSocket and streaming responses through without consuming or reconstructing them', async t => {
  const f = await fixture(t);
  const upgrade = Object.defineProperties(new Response(null), { status: { value: 101 }, webSocket: { value: {} } });
  f.setResponse(upgrade);
  assert.equal(await handlePreviewGateway(new Request(`https://${token}.${domain}/socket`, { headers: { Upgrade: 'websocket' } }), f.env), upgrade);
  assert.equal(f.calls[0].headers.get('upgrade'), 'websocket');
  const stream = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([42])); controller.close(); } }));
  f.setResponse(stream);
  assert.equal(await handlePreviewGateway(new Request(`https://${token}.${domain}/`), f.env), stream);
  assert.deepEqual(new Uint8Array(await stream.arrayBuffer()), new Uint8Array([42]));
});

test('missing, expired, revoked and malformed routes fail closed; routing failures disclose no tokens or internals', async t => {
  const f = await fixture(t);
  const call = () => handlePreviewGateway(new Request(`https://${token}.${domain}/`), f.env);
  f.sqlite.prepare('UPDATE preview_routes SET expires_at = ?').run(Date.now() - 1);
  assert.equal((await call()).status, 404);
  f.sqlite.prepare('UPDATE preview_routes SET expires_at = ?, container_name = ?').run(Date.now() + 60_000, 'https://api.mainbrella.com');
  assert.equal((await call()).status, 404);
  f.sqlite.exec('DELETE FROM preview_routes');
  assert.equal((await call()).status, 404);
  f.env.PREVIEW_ROUTES = { prepare() { throw new Error(`private ${token}`); } } as unknown as D1Database;
  const response = await call();
  assert.equal(response.status, 503);
  assert.equal(await response.text(), 'Preview unavailable.');
  assert.equal(f.calls.length, 0);
});

test('scheduled expiry cleanup is bounded and does not delete live routes', async t => {
  const f = await fixture(t);
  const insert = f.sqlite.prepare('INSERT INTO preview_routes VALUES (?, ?, ?, ?, ?)');
  for (let i = 0; i < 1001; i++) insert.run(i.toString(16).padStart(64, '0'), i.toString(16).padStart(32, '0'), 'user:owner', generation, 0);
  await gateway.scheduled({} as ScheduledController, f.env);
  assert.equal((f.sqlite.prepare('SELECT count(*) AS n FROM preview_routes').get() as any).n, 2);
  await gateway.scheduled({} as ScheduledController, f.env);
  assert.equal((f.sqlite.prepare('SELECT count(*) AS n FROM preview_routes').get() as any).n, 1);
  assert.equal((await handlePreviewGateway(new Request(`https://${token}.${domain}/`), f.env)).status, 200);
});
