import test from 'node:test';
import assert from 'node:assert/strict';
import { checksum, LIMITS } from './contracts';
import { runtime } from './system-test-helpers';

test('browser Data API: scoped public reads, CORS, pinned functions, and revocation', { timeout: 60_000 }, async t => {
  const f = await runtime(t);
  const project = (await f.json('/projects', 'POST', { name: 'Browser backend', template: 'empty' }, 201)).project;
  const base = `/projects/${project.id}`;
  await f.json(`${base}/provision`, 'POST');
  await f.json(`${base}/migrations`, 'POST', { sequence: 1, name: 'notes', sql: 'CREATE TABLE notes(id TEXT PRIMARY KEY, body TEXT, rank INTEGER); CREATE TABLE private_notes(secret TEXT);' });
  await f.json(`${base}/query`, 'POST', { sql: 'INSERT INTO notes VALUES(?,?,?)', params: ['one', 'First note', 1] });
  await f.json(`${base}/policies/notes`, 'PUT', { select: 'public' });
  await f.json(`${base}/functions/read_notes`, 'PUT', {
    source: `export default async (input, ctx) => (await ctx.db.select('notes', {id:input.id})).results`,
    databaseAccess: 'read', expectedVersion: 0,
  }, 201);
  const origin = 'https://customer.example';
  const grants = { name: 'Web app', origins: [origin], tables: { notes: ['select'] }, functions: { read_notes: 1 } };
  await f.json(`${base}/api-keys`, 'POST', { ...grants, origins: ['*'] }, 400);
  await f.json(`${base}/api-keys`, 'POST', { ...grants, origins: [`${origin}/path`] }, 400);
  await f.json(`${base}/api-keys`, 'POST', { ...grants, tables: { sqlite_schema: ['select'] } }, 400);
  await f.json(`${base}/api-keys`, 'POST', { ...grants, functions: { absent: 1 } }, 404);
  await f.json(`${base}/api-keys`, 'POST', { name: 'Empty', origins: [origin] }, 400);
  assert.equal((await f.request(`${base}/api-keys`, 'POST', grants, 'stranger')).status, 404);
  const { key, token } = await f.json(`${base}/api-keys`, 'POST', grants, 201);
  assert.match(token, /^bff_pk_[a-f0-9]{64}$/);
  assert.equal((await f.db.prepare('SELECT token_hash FROM api_keys WHERE id=?').bind(key.id).first())!.token_hash, await checksum(token));
  const listed = await f.json(`${base}/api-keys`);
  assert.deepEqual(listed.keys, [key]);
  assert.ok(!JSON.stringify(listed).includes(token));
  assert.ok(!JSON.stringify(listed).includes(await checksum(token)));
  const accountKeys = await f.mf.dispatchFetch('https://api.mainbrella.com/api-keys', { headers: { cookie: 'mainbrella_session=owner' } });
  const sharedList = await accountKeys.json() as any;
  assert.equal(sharedList.keys[0].id, key.id);
  assert.equal(sharedList.keys[0].scope, 'bff');
  assert.ok(!JSON.stringify(sharedList).includes(token));
  assert.equal((await f.mf.dispatchFetch('https://api.mainbrella.com/api-keys/me', { headers: { authorization: `Bearer ${token}` } })).status, 401);
  assert.equal((await f.request('/projects', 'GET', undefined, 'owner', { authorization: `Bearer ${token}` })).status, 401);

  const dataBase = `/data/${project.id}`;
  const table = `${dataBase}/tables/notes`;
  const request = (path: string, method = 'GET', body?: unknown, credential = token, headers: Record<string, string> = {}) => f.mf.dispatchFetch(`https://api.mainbrella.com/bff${path}`, {
    method, headers: { origin, apikey: credential, 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  async function json(path: string, method = 'GET', body?: unknown, status = 200, credential = token) {
    const response = await request(path, method, body, credential);
    assert.equal(response.status, status, await response.clone().text());
    return response.json() as Promise<any>;
  }
  const preflight = await f.mf.dispatchFetch(`https://api.mainbrella.com/bff${table}`, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'apikey, content-type' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
  assert.equal(preflight.headers.get('access-control-allow-credentials'), null);
  assert.match(preflight.headers.get('access-control-allow-headers')!, /apikey/);
  assert.equal((await request(table, 'OPTIONS', undefined, '', { 'access-control-request-headers': 'x-unapproved' })).status, 403);
  assert.equal((await request(table, 'GET', undefined, token, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await request(table, 'GET', undefined, '', { cookie: 'mainbrella_session=owner' })).status, 401);
  assert.equal((await request(table, 'GET', undefined, `bff_pk_${'0'.repeat(64)}`)).status, 401);
  const bearer = await request(table, 'GET', undefined, '', { apikey: '', authorization: `Bearer ${token}` });
  assert.equal(bearer.status, 200);
  assert.equal(bearer.headers.get('cache-control'), 'no-store');
  assert.equal(bearer.headers.get('vary'), 'Origin');
  assert.equal((await request(table, 'GET', undefined, token, { authorization: `Bearer bff_pk_${'0'.repeat(64)}` })).status, 401);
  assert.deepEqual((await json(table)).data, [{ id: 'one', body: 'First note', rank: 1 }]);
  assert.deepEqual((await json(`${table}?select=id,body&id=eq.one&limit=1&order=id.asc`)).data, [{ id: 'one', body: 'First note' }]);
  assert.deepEqual((await json(`${table}?offset=1`)).data, []);
  assert.deepEqual((await json(`${table}?id=eq.${encodeURIComponent("one' OR 1=1 --")}`)).data, []);
  const providerCalls = f.calls.length;
  for (const suffix of ['?limit=101', '?limit=1&limit=2', '?select=id;DROP%20TABLE%20notes', '?order=id.desc;DROP', '?id=neq.one', '?select=sqlite_schema']) await json(`${table}${suffix}`, 'GET', undefined, 400);
  for (const resource of ['private_notes', 'constructor', 'toString']) await json(`${dataBase}/tables/${resource}`, 'GET', undefined, 403);
  await json(`${dataBase}/tables/sqlite_schema`, 'GET', undefined, 400);
  await json(table, 'POST', { id: 'denied' }, 403);
  await json(table, 'PATCH', { body: 'denied' }, 403);
  await json(`${table}?id=eq.one`, 'DELETE', undefined, 403);
  assert.equal(f.calls.length, providerCalls, 'Invalid or forbidden table requests never reach project D1');
  assert.equal((await request(`${base}/query`, 'POST', { sql: 'SELECT * FROM notes' }, token, { origin: 'https://mainbrella.com' })).status, 401);

  const fn = `${dataBase}/functions/read_notes/invoke`;
  assert.deepEqual((await json(fn, 'POST', { input: { id: 'one' } })).value, [{ id: 'one', body: 'First note', rank: 1 }]);
  await f.json(`${base}/functions/read_notes`, 'PUT', { source: `export default () => 'new version'`, expectedVersion: 1 }, 201);
  const pinned = await json(fn, 'POST', { input: { id: 'one' } });
  assert.equal(pinned.version, 1);
  assert.equal(pinned.value[0].body, 'First note');
  await json(fn, 'POST', { input: null, version: 2 }, 400);
  await json(`${dataBase}/functions/constructor/invoke`, 'POST', { input: null }, 403);
  await json(`${dataBase}/functions/absent/invoke`, 'POST', { input: null }, 403);
  assert.equal((await request(fn, 'OPTIONS', undefined, '', { 'access-control-request-method': 'GET' })).status, 403);

  const writable = await f.json(`${base}/api-keys`, 'POST', { name: 'Editor', origins: [origin], tables: { notes: ['select', 'insert', 'update', 'delete'] } }, 201);
  await json(table, 'POST', { id: 'two', body: null, rank: 2 }, 403, writable.token);
  await f.json(`${base}/query`, 'POST', { sql: 'INSERT INTO notes VALUES(?,?,?)', params: ['two', null, 2] });
  assert.deepEqual((await json(`${table}?rank=eq.2`)).data.map((row: any) => row.id), ['two']);
  assert.deepEqual((await json(`${table}?body=is.null`)).data.map((row: any) => row.id), ['two']);
  assert.deepEqual((await json(`${table}?order=rank.desc&select=id&limit=1`)).data, [{ id: 'two' }]);
  await json(table, 'PATCH', { body: 'No filter' }, 403, writable.token);
  await json(table, 'DELETE', undefined, 403, writable.token);
  await json(`${table}?id=eq.two`, 'PATCH', { body: "Bound ' ; value" }, 403, writable.token);
  await json(`${table}?id=eq.two`, 'DELETE', undefined, 403, writable.token);

  const otherOriginKey = await f.json(`${base}/api-keys`, 'POST', { ...grants, origins: ['https://another.example'] }, 201);
  assert.equal((await request(table, 'GET', undefined, otherOriginKey.token)).status, 403, 'An origin on another key does not authorize this key');
  const other = (await f.json('/projects', 'POST', { name: 'Other backend', template: 'empty' }, 201)).project;
  await json(`/data/${other.id}/tables/notes`, 'GET', undefined, 401);
  assert.equal((await f.request(`/projects/${other.id}/api-keys/${key.id}`, 'DELETE')).status, 404);
  await f.json(base, 'PATCH', { suspended: true });
  await json(table, 'GET', undefined, 403);
  await json(fn, 'POST', { input: null }, 403);
  await f.json(`${base}/api-keys/${writable.key.id}`, 'DELETE');
  await f.json(base, 'PATCH', { suspended: false });
  await json(table, 'GET', undefined, 401, writable.token);
  await f.db.prepare('UPDATE bff_projects SET blocked=1 WHERE id=?').bind(project.id).run();
  await json(table, 'GET', undefined, 403);
  await f.db.prepare('UPDATE bff_projects SET blocked=0 WHERE id=?').bind(project.id).run();
  const day = new Date().toISOString().slice(0, 10);
  await f.db.prepare('UPDATE bff_daily_usage SET invocations=? WHERE project_id=? AND day=?').bind(LIMITS.invocationsPerDay, project.id, day).run();
  await json(fn, 'POST', { input: null }, 429);
  await f.db.prepare('UPDATE bff_daily_usage SET queries=? WHERE project_id=? AND day=?').bind(LIMITS.queriesPerDay, project.id, day).run();
  await json(table, 'GET', undefined, 429);
  const revoked = await f.mf.dispatchFetch(`https://api.mainbrella.com/api-keys?id=${key.id}`, { method: 'DELETE', headers: { cookie: 'mainbrella_session=owner', origin: 'https://mainbrella.com' } });
  assert.equal(revoked.status, 200);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM bff_api_key_grants WHERE api_key_id=?').bind(key.id).first())!.n, 0);
  await json(table, 'GET', undefined, 401);
  // The cap is enforced by an atomic INSERT, including simultaneous creation.
  for (let i = 0; i < LIMITS.apiKeys - 2; i++) await f.json(`${base}/api-keys`, 'POST', grants, 201);
  const lastKeys = await Promise.all([f.request(`${base}/api-keys`, 'POST', grants), f.request(`${base}/api-keys`, 'POST', grants)]);
  assert.deepEqual(lastKeys.map(response => response.status).sort(), [201, 429]);
  assert.equal((await f.json(`${base}/api-keys`)).keys.length, LIMITS.apiKeys);
  await f.db.prepare("DELETE FROM users WHERE id='owner'").run();
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM api_keys').first())!.n, 0);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM bff_api_key_grants').first())!.n, 0);
});

test('disabled BFF denies the Data API while owners can still inspect and revoke keys', async t => {
  const f = await runtime(t, { BFF_ENABLED: 'false' });
  const projectId = crypto.randomUUID(), keyId = crypto.randomUUID(), token = `bff_pk_${'a'.repeat(64)}`;
  await f.db.prepare("INSERT INTO bff_projects(id,user_id,name,state,created_at) VALUES(?,'owner','Paused service','ready',?)").bind(projectId, new Date().toISOString()).run();
  await f.db.prepare('INSERT INTO api_keys(id,user_id,name,token_hash,prefix,created_at) VALUES(?,?,?,?,?,?)')
    .bind(keyId, 'owner', 'Browser', await checksum(token), token.slice(0, 15), new Date().toISOString()).run();
  await f.db.prepare('INSERT INTO bff_api_key_grants(api_key_id,project_id,origins,tables,functions) VALUES(?,?,?,?,?)')
    .bind(keyId, projectId, '["https://customer.example"]', '{"notes":["select"]}', '{}').run();
  const response = await f.mf.dispatchFetch(`https://api.mainbrella.com/bff/data/${projectId}/tables/notes`, { headers: { apikey: token } });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'bff_unavailable' });
  assert.equal(f.calls.length, 0);
  assert.equal((await f.json(`/projects/${projectId}/api-keys`)).keys.length, 1);
  await f.json(`/projects/${projectId}/api-keys`, 'POST', { name: 'New', origins: ['https://customer.example'], tables: { notes: ['select'] } }, 503);
  await f.json(`/projects/${projectId}/api-keys/${keyId}`, 'PATCH', { table: 'notes', operation: 'select' }, 503);
  await f.json(`/projects/${projectId}/api-keys/${keyId}`, 'DELETE');
  assert.deepEqual((await f.json(`/projects/${projectId}/api-keys`)).keys, []);
});
