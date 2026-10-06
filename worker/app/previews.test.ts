import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleRequest } from './router';
import { handlePreviewGateway } from '../preview-gateway';
import { previewDatabase } from '../lib/preview-test-helpers';
import { previewTokenHash } from '../lib/preview-routing';
import { previewGrantSchema } from './openapi-previews';
import { Mainbrella } from '../../sdk/javascript/index.js';
import { hashToken } from './auth-core';
import { paidContainerFixture, GENERATION_ONE, GENERATION_TWO, SESSION_ONE, SESSION_TWO, USER_ONE, USER_TWO } from './paid-container-test-helpers';

const token = 'a'.repeat(48);
const previewId = 'b'.repeat(32);
const grant = () => ({ id: previewId, port: 3000, createdAt: GENERATION_ONE, expiresAt: Date.now() + 900_000 });
const query = new URLSearchParams({ id: 'small', createdAt: GENERATION_ONE });
function request(method = 'GET', body?: string, suffix = query.toString(), headers: Record<string, string> = {}) {
  return new Request(`https://api.mainbrella.com/containers/previews?${suffix}`, { method, body,
    headers: { Origin: 'https://mainbrella.com', Cookie: `mainbrella_session=${SESSION_ONE}`, 'content-type': 'application/json', ...headers } });
}

async function fixture(t: TestContext) {
  const f = await paidContainerFixture(t);
  t.after(() => f.close());
  f.sqlite.exec(readFileSync(new URL('../../migrations/010_api_keys.sql', import.meta.url), 'utf8'));
  f.env.PREVIEWS_ENABLED = 'true';
  f.env.PREVIEW_DOMAIN = 'preview.example';
  f.env.PREVIEW_ROUTES = previewDatabase(f.sqlite);
  const calls: { name: string; request: Request }[] = [];
  let failRevoke = false;
  let issued: unknown = { ...grant(), token };
  let runtimeStatus = 201;
  const presentByName = new Map<string, boolean>();
  const original = f.env.USER_CONTAINER;
  f.env.USER_CONTAINER = { ...original, get(name: string) {
    return { async fetch(req: Request) {
      calls.push({ name, request: req });
      const present = presentByName.get(name) ?? true;
      if (new URL(req.url).pathname.startsWith('/preview/')) return new Response(present ? 'application' : 'Preview unavailable.', { status: present ? 200 : 403 });
      if (req.method === 'DELETE') {
        if (failRevoke) throw new Error('private revoke error');
        presentByName.set(name, false);
        return Response.json({ revoked: true });
      }
      if (req.method === 'POST') { presentByName.set(name, true); return Response.json(issued, { status: runtimeStatus }); }
      return Response.json({ previews: present ? [{ ...grant(), token, tokenHash: 'private-hash' }] : [] });
    } };
  } } as unknown as DurableObjectNamespace;
  return { ...f, calls, setRevokeFailure(value: boolean) { failRevoke = value; },
    setIssued(value: unknown, status = 201) { issued = value; runtimeStatus = status; } };
}

test('issuance binds routing to owner and generation, stores only hashes, lists metadata and revokes idempotently', async t => {
  const f = await fixture(t);
  const created = await handleRequest(request('POST', '{"port":3000,"ttlSeconds":900}', undefined, {
    'x-preview-created-at': GENERATION_TWO, 'x-preview-token': 'attacker', 'x-mainbrella-user': USER_TWO,
  }), f.env);
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('cache-control'), 'no-store');
  const issued = await created.json() as any;
  previewGrantSchema.parse(issued);
  assert.equal(issued.url, `https://${token}.preview.example/`);
  assert.equal(issued.token, undefined);
  const row = f.sqlite.prepare('SELECT * FROM preview_routes').get() as any;
  assert.equal(row.token_hash, await previewTokenHash(token));
  assert.equal(row.container_name, 'user:account-one');
  assert.equal(row.created_at, GENERATION_ONE);
  assert.ok(!JSON.stringify(row).includes(token));
  const internal = f.calls[0].request;
  assert.equal(internal.headers.get('x-preview-created-at'), GENERATION_ONE);
  for (const header of ['x-preview-token', 'x-mainbrella-user', 'cookie', 'authorization']) assert.equal(internal.headers.get(header), null);
  assert.deepEqual(await internal.json(), { port: 3000, ttlSeconds: 900 });
  const listing = await handleRequest(request(), f.env);
  assert.equal(listing.status, 200);
  const listed = await listing.json() as any;
  assert.deepEqual(Object.keys(listed.previews[0]).sort(), ['createdAt', 'expiresAt', 'id', 'port']);
  assert.ok(!JSON.stringify(listed).includes(token));
  const open = () => handlePreviewGateway(new Request(issued.url + 'assets/app.js?v=1'), f.env);
  assert.equal((await open()).status, 200);
  for (let i = 0; i < 2; i++) {
    const revoked = await handleRequest(request('DELETE', undefined, `${query}&previewId=${previewId}`), f.env);
    assert.equal(revoked.status, 200);
    assert.deepEqual(await revoked.json(), { revoked: true });
  }
  assert.equal((await open()).status, 404);
  assert.equal(f.sqlite.prepare('SELECT * FROM preview_routes').get(), undefined);
  assert.ok(f.calls.every(call => call.name === 'user:account-one'));
});

test('SDK preview helpers use real API authorization and isolate generation-bound grants', async t => {
  const f = await fixture(t);
  const apiKey = `mb_${'a'.repeat(64)}`;
  f.sqlite.prepare('INSERT INTO api_keys (id, user_id, name, token_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('sdk-preview-key', USER_ONE, 'SDK previews', await hashToken(apiKey), 'mb_aaaa', GENERATION_ONE);
  const client = new Mainbrella({ apiKey, fetch: (async (input: RequestInfo | URL, options?: RequestInit) =>
    handleRequest(new Request(input, options), f.env)) as typeof fetch });
  const sandbox = client.connect({ id: 'small', createdAt: GENERATION_ONE });
  assert.equal((await client.capabilities()).previews.supported, true);
  const preview = await sandbox.previews.create(3000);
  assert.equal(preview.url, `https://${token}.preview.example/`);
  const { previews } = await sandbox.previews.list();
  assert.deepEqual(Object.keys(previews[0]).sort(), ['createdAt', 'expiresAt', 'id', 'port']);
  await assert.rejects(client.connect({ id: 'small', createdAt: GENERATION_TWO }).previews.revoke(preview.id),
    { code: 'container_not_running', status: 409 });
  f.env.PREVIEWS_ENABLED = 'false';
  assert.equal((await sandbox.previews.list()).previews.length, 1);
  f.setRevokeFailure(true);
  await assert.rejects(sandbox.previews.revoke(preview.id),
    { code: 'preview_reconciliation_required', status: 503, previewId: preview.id });
  f.setRevokeFailure(false);
  assert.deepEqual(await sandbox.previews.revoke(preview.id), { revoked: true });
  assert.equal((await sandbox.previews.list()).previews.length, 0);
});

test('validation rejects unsafe ports, malformed generations, duplicate queries and oversized bodies before runtime access', async t => {
  const f = await fixture(t);
  for (const body of ['{}', '{', 'null', '{"port":22}', '{"port":1023}', '{"port":65536}', '{"port":3000.5}',
    '{"port":"3000"}', '{"port":3000,"ttlSeconds":59}', '{"port":3000,"ttlSeconds":3601}', '{"port":3000,"extra":true}']) {
    assert.equal((await handleRequest(request('POST', body), f.env)).status, 400, body);
  }
  assert.equal((await handleRequest(request('POST', ' '.repeat(1025)), f.env)).status, 413);
  for (const suffix of [`${query}&id=small`, `${query}&port=22`, `id=small&createdAt=bad`, `id=small`, `createdAt=${GENERATION_ONE}`]) {
    assert.equal((await handleRequest(request('GET', undefined, suffix), f.env)).status, 400, suffix);
  }
  assert.equal((await handleRequest(request('DELETE', undefined, query.toString()), f.env)).status, 400);
  assert.equal((await handleRequest(request('PATCH'), f.env)).status, 405);
  assert.equal((await handleRequest(request('HEAD'), f.env)).status, 405);
  assert.equal((await handleRequest(request('OPTIONS'), f.env)).status, 204);
  assert.equal(f.calls.length, 0);
});

test('account authentication, trusted origins, paid entitlement and exact running generations are enforced', async t => {
  const f = await fixture(t);
  assert.equal((await handleRequest(request('GET', undefined, undefined, { Cookie: '' }), f.env)).status, 401);
  assert.equal((await handleRequest(request('POST', '{"port":3000}', undefined, { Origin: '' }), f.env)).status, 403);
  assert.equal((await handleRequest(request('POST', '{"port":3000}', undefined, { Origin: 'https://attacker.example' }), f.env)).status, 403);
  assert.equal((await handleRequest(request('GET', undefined, undefined, { Authorization: `Bearer mb_${'0'.repeat(64)}` }), f.env)).status, 401);
  f.containers.set(USER_ONE, []);
  assert.equal((await handleRequest(request('POST', '{"port":3000}'), f.env)).status, 409);
  f.containers.set(USER_ONE, [{ id: 'small', createdAt: GENERATION_TWO, expiresAt: '2099-01-01T00:00:00.000Z' }]);
  assert.equal((await handleRequest(request('GET'), f.env)).status, 409);
  f.containers.get(USER_ONE)![0].createdAt = GENERATION_ONE;
  f.containers.get(USER_ONE)![0].expiresAt = '2020-01-01T00:00:00.000Z';
  assert.equal((await handleRequest(request('GET'), f.env)).status, 409);
  f.setBillingMode('failure');
  assert.equal((await handleRequest(request('GET'), f.env)).status, 503);
  f.setBillingMode('unpaid');
  assert.equal((await handleRequest(request('POST', '{"port":3000}'), f.env)).status, 402);
  assert.equal(f.calls.length, 0);
});

test('cross-account revocation cannot remove another owner route and replacement generations cannot authorize mutations', async t => {
  const f = await fixture(t);
  assert.equal((await handleRequest(request('POST', '{"port":3000}'), f.env)).status, 201);
  const otherQuery = new URLSearchParams({ id: 'small', createdAt: GENERATION_TWO, previewId });
  assert.equal((await handleRequest(request('DELETE', undefined, otherQuery.toString(), { Cookie: `mainbrella_session=${SESSION_TWO}` }), f.env)).status, 200);
  assert.ok(f.sqlite.prepare('SELECT * FROM preview_routes').get());
  assert.equal(f.calls.at(-1)!.name, 'user:account-two');
  assert.equal((await handlePreviewGateway(new Request(`https://${token}.preview.example/`), f.env)).status, 200);
  f.containers.get(USER_ONE)![0].createdAt = GENERATION_TWO;
  const count = f.calls.length;
  assert.equal((await handleRequest(request('DELETE', undefined, `${query}&previewId=${previewId}`), f.env)).status, 409);
  assert.equal(f.calls.length, count);
  assert.ok(f.sqlite.prepare('SELECT * FROM preview_routes').get());
});

test('a named API key can issue previews without Origin and an invalid bearer never falls back to cookies', async t => {
  const f = await fixture(t);
  const response = await handleRequest(new Request('https://api.mainbrella.com/api-keys', { method: 'POST',
    headers: { Origin: 'https://mainbrella.com', Cookie: `mainbrella_session=${SESSION_ONE}` }, body: '{"name":"Preview automation"}' }), f.env);
  const { token: key } = await response.json() as any;
  assert.equal((await handleRequest(request('POST', '{"port":3000}', undefined, { Origin: '', Cookie: '', Authorization: `Bearer ${key}` }), f.env)).status, 201);
});

test('index-write failures revoke grants, including ambiguous writes; rollback failures identify retryable metadata', async t => {
  const f = await fixture(t);
  const original = f.env.PREVIEW_ROUTES!;
  for (const ambiguous of [false, true]) {
    f.env.PREVIEW_ROUTES = { prepare(sql: string) {
      const statement = original.prepare(sql);
      if (!sql.startsWith('INSERT')) return statement;
      return { bind(...values: unknown[]) {
        const bound = statement.bind(...values);
        return { async run() { if (ambiguous) await bound.run(); throw new Error(`private ${token}`); } };
      } };
    } } as unknown as D1Database;
    const response = await handleRequest(request('POST', '{"port":3000}'), f.env);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'previews_unavailable' });
    assert.equal(f.calls.at(-1)!.request.method, 'DELETE');
    assert.equal(f.sqlite.prepare('SELECT * FROM preview_routes').get(), undefined);
  }
  f.setRevokeFailure(true);
  const failed = await handleRequest(request('POST', '{"port":3000}'), f.env);
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { error: 'preview_reconciliation_required', previewId });
  f.setRevokeFailure(false);
  f.env.PREVIEW_ROUTES = original;
  assert.equal((await handleRequest(request('DELETE', undefined, `${query}&previewId=${previewId}`), f.env)).status, 200);
});

test('partial revoke disables routing, always attempts runtime closure, and succeeds on retry', async t => {
  const f = await fixture(t);
  const revoke = () => handleRequest(request('DELETE', undefined, `${query}&previewId=${previewId}`), f.env);
  await handleRequest(request('POST', '{"port":3000}'), f.env);
  f.setRevokeFailure(true);
  assert.equal((await revoke()).status, 503);
  assert.equal(f.sqlite.prepare('SELECT * FROM preview_routes').get(), undefined);
  f.setRevokeFailure(false);
  assert.equal((await revoke()).status, 200);
  await handleRequest(request('POST', '{"port":3000}'), f.env);
  const original = f.env.PREVIEW_ROUTES!;
  f.env.PREVIEW_ROUTES = { prepare() { throw new Error('private database error'); } } as unknown as D1Database;
  assert.equal((await revoke()).status, 503);
  assert.equal(f.calls.at(-1)!.request.method, 'DELETE');
  f.env.PREVIEW_ROUTES = original;
  // A stale route cannot bypass the authoritative runtime revocation.
  assert.equal((await handlePreviewGateway(new Request(`https://${token}.preview.example/`), f.env)).status, 403);
  assert.equal((await revoke()).status, 200);
});

test('disabling preview issuance still permits owner inspection and revocation of existing grants', async t => {
  const f = await fixture(t);
  assert.equal((await handleRequest(request('POST', '{"port":3000}'), f.env)).status, 201);
  f.env.PREVIEWS_ENABLED = 'false';
  assert.equal((await handlePreviewGateway(new Request(`https://${token}.preview.example/`), f.env)).status, 404);
  assert.equal((await handleRequest(request('POST', '{"port":3000}'), f.env)).status, 503);
  assert.equal((await handleRequest(request(), f.env)).status, 200);
  assert.equal((await handleRequest(request('DELETE', undefined, `${query}&previewId=${previewId}`), f.env)).status, 200);
  assert.equal(f.calls.at(-1)!.request.method, 'DELETE');
  assert.equal(f.sqlite.prepare('SELECT * FROM preview_routes').get(), undefined);
});

test('capability enablement fails closed and runtime errors are sanitized with issuance validation', async t => {
  const f = await fixture(t);
  const capability = async () => (await (await handleRequest(new Request('https://api.mainbrella.com/capabilities'), f.env)).json() as any).previews;
  assert.deepEqual(await capability(), { supported: true, signedUrls: false });
  f.env.PREVIEW_DOMAIN = 'apps.mainbrella.com';
  assert.deepEqual(await capability(), { supported: false, signedUrls: false });
  assert.equal((await handleRequest(request('POST', '{"port":3000}'), f.env)).status, 503);
  assert.equal(f.calls.length, 0);
  f.env.PREVIEW_DOMAIN = 'preview.example';
  f.setIssued({ error: 'preview_limit' }, 429);
  assert.equal((await handleRequest(request('POST', '{"port":3000}'), f.env)).status, 429);
  f.setIssued({ error: 'private runtime detail' }, 500);
  assert.deepEqual(await (await handleRequest(request('POST', '{"port":3000}'), f.env)).json(), { error: 'previews_unavailable' });
  for (const value of [{ ...grant(), token, port: 22 }, { ...grant(), token, createdAt: GENERATION_TWO }, { ...grant(), token: 'invalid' }]) {
    f.setIssued(value);
    assert.equal((await handleRequest(request('POST', '{"port":3000}'), f.env)).status, 503);
    assert.equal(f.calls.at(-1)!.request.method, 'DELETE');
  }
});
