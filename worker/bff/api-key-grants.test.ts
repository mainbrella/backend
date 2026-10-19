import test from 'node:test';
import assert from 'node:assert/strict';
import { checksum } from './contracts';
import { runtime } from './system-test-helpers';

test('owners add table operations without rotating a browser token or replacing other grants', async t => {
  const f = await runtime(t);
  const project = (await f.json('/projects', 'POST', { name: 'Grant example', template: 'empty' }, 201)).project;
  const base = `/projects/${project.id}`;
  await f.json(`${base}/provision`, 'POST');
  await f.json(`${base}/migrations`, 'POST', { sequence: 1, name: 'tables', sql:
    "CREATE TABLE notes(id TEXT); CREATE TABLE boards(id TEXT); INSERT INTO boards VALUES('general'); CREATE TABLE tags(id TEXT); CREATE TABLE teams(id TEXT); CREATE TABLE constructor(id TEXT);" });
  await f.json(`${base}/functions/read_notes`, 'PUT', { source: 'export default () => 1', expectedVersion: 0 }, 201);
  const { key, token } = await f.json(`${base}/api-keys`, 'POST', { name: 'Existing frontend',
    origins: ['https://board.example', 'http://localhost:5173'], tables: { notes: ['select', 'update'] }, functions: { read_notes: 1 } }, 201);
  const issued = await f.mf.dispatchFetch('https://api.mainbrella.com/api-keys', { method: 'POST',
    headers: { cookie: 'mainbrella_session=owner', origin: 'https://mainbrella.com' }, body: JSON.stringify({ name: 'CLI' }) });
  assert.equal(issued.status, 201);
  const account = await issued.json() as { key: { id: string }; token: string };
  await f.json(`${base}/api-keys/${account.key.id}`, 'PATCH', { table: 'boards', operation: 'select' }, 404);
  const patch = (table: string, operation = 'select') => f.request(`${base}/api-keys/${key.id}`, 'PATCH', { table, operation }, 'owner',
    { authorization: `Bearer ${account.token}` });
  const browser = (origin = 'https://board.example', method = 'GET') => f.mf.dispatchFetch(
    `https://api.mainbrella.com/bff/data/${project.id}/tables/boards`, { method,
      headers: { apikey: token, origin, 'content-type': 'application/json' },
      ...(method === 'POST' ? { body: '{"id":"forbidden"}' } : {}) });
  assert.equal((await browser()).status, 403);
  const granted = await patch('boards');
  assert.equal(granted.status, 200, await granted.clone().text());
  const result = await granted.json() as { key: typeof key };
  assert.deepEqual(result, { key: { ...key, tables: { ...key.tables, boards: ['select'] } } });
  assert.equal((await browser()).status, 403, 'A key grant still requires a public read policy');
  assert.deepEqual((await f.json(`${base}/policies`)).policies, []);
  await f.json(`${base}/policies/boards`, 'PUT', { select: 'public' });
  const read = await browser();
  assert.equal(read.status, 200);
  assert.deepEqual((await read.json() as { data: unknown }).data, [{ id: 'general' }]);
  assert.equal((await browser('https://wrong.example')).status, 403);
  assert.equal((await browser('https://board.example', 'POST')).status, 403);
  assert.equal((await f.db.prepare('SELECT token_hash FROM api_keys WHERE id=?').bind(key.id).first())!.token_hash, await checksum(token));
  assert.ok(!JSON.stringify(result).includes(token));
  assert.ok(!JSON.stringify(result).includes(await checksum(token)));

  // Separate additions and identical retries both merge against current grants.
  const concurrent = await Promise.all([patch('tags'), patch('teams'), patch('boards'), patch('boards', 'insert'), patch('boards', 'delete'), patch('constructor')]);
  assert.deepEqual(concurrent.map(response => response.status), [200, 200, 200, 200, 200, 200]);
  const saved = (await f.json(`${base}/api-keys`)).keys[0];
  assert.deepEqual(saved.tables.notes, ['select', 'update']);
  assert.deepEqual(saved.tables.boards.slice().sort(), ['delete', 'insert', 'select'].sort());
  assert.deepEqual(saved.tables.tags, ['select']);
  assert.deepEqual(saved.tables.teams, ['select']);
  assert.deepEqual(saved.tables.constructor, ['select']);
  const revoking = await Promise.all([patch('boards'), f.request(`${base}/api-keys/${key.id}`, 'DELETE')]);
  assert.ok([200, 404].includes(revoking[0].status));
  assert.equal(revoking[1].status, 200);
  assert.deepEqual((await f.json(`${base}/api-keys`)).keys, []);
  assert.equal((await browser()).status, 401, 'A concurrent grant cannot restore a revoked key');
});

test('browser grants require owner access, an existing project key and table, and a ready project', async t => {
  const f = await runtime(t);
  const project = (await f.json('/projects', 'POST', { name: 'Grant authorization', template: 'empty' }, 201)).project;
  const base = `/projects/${project.id}`;
  await f.json(`${base}/provision`, 'POST');
  await f.json(`${base}/migrations`, 'POST', { sequence: 1, name: 'boards', sql: 'CREATE TABLE boards(id TEXT)' });
  const { key, token } = await f.json(`${base}/api-keys`, 'POST', { name: 'Browser', origins: ['https://board.example'], tables: { boards: ['insert'] } }, 201);
  const path = `${base}/api-keys/${key.id}`, grant = { table: 'boards', operation: 'select' };
  await f.json(path, 'PATCH', { ...grant, table: 'missing' }, 404);
  assert.equal((await f.request(path, 'PATCH', grant, 'stranger')).status, 404);
  assert.equal((await f.request(path, 'PATCH', grant, 'no-session')).status, 401);
  assert.equal((await f.request(path, 'PATCH', grant, 'owner', { authorization: `Bearer ${token}` })).status, 401);
  const other = (await f.json('/projects', 'POST', { name: 'Other project', template: 'empty' }, 201)).project;
  await f.json(`/projects/${other.id}/provision`, 'POST');
  await f.json(`/projects/${other.id}/api-keys/${key.id}`, 'PATCH', grant, 404);
  await f.json(`${base}/api-keys/${crypto.randomUUID()}`, 'PATCH', grant, 404);
  for (const input of [{ ...grant, operation: 'upsert' }, { ...grant, origins: ['https://wrong.example'] },
    { ...grant, table: 'sqlite_schema' }, { ...grant, table: '_bff_migrations' }, { table: 'boards' }]) {
    await f.json(path, 'PATCH', input, 400);
  }
  assert.equal((await f.request(path, 'PATCH', grant, 'owner', { 'content-type': 'text/plain' })).status, 415);
  assert.deepEqual((await f.json(`${base}/api-keys`)).keys, [key]);
  await f.json(base, 'PATCH', { suspended: true });
  await f.json(path, 'PATCH', grant, 403);
  await f.json(base, 'PATCH', { suspended: false });
  await f.db.prepare('UPDATE bff_projects SET blocked=1 WHERE id=?').bind(project.id).run();
  await f.json(path, 'PATCH', grant, 403);
  await f.db.prepare("UPDATE bff_projects SET blocked=0,state='pending' WHERE id=?").bind(project.id).run();
  await f.json(path, 'PATCH', grant, 409);
  await f.db.prepare("UPDATE bff_projects SET state='ready' WHERE id=?").bind(project.id).run();
  await f.json(path, 'DELETE');
  await f.json(path, 'PATCH', grant, 404);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM bff_api_key_grants WHERE api_key_id=?').bind(key.id).first())!.n, 0);
});

test('concurrent table grants respect the combined table/function cap and allow retries at capacity', async t => {
  const f = await runtime(t);
  const project = (await f.json('/projects', 'POST', { name: 'Grant quota', template: 'empty' }, 201)).project;
  const base = `/projects/${project.id}`;
  await f.json(`${base}/provision`, 'POST');
  await f.json(`${base}/migrations`, 'POST', { sequence: 1, name: 'tables', sql: 'CREATE TABLE new_a(id TEXT); CREATE TABLE new_b(id TEXT); CREATE TABLE slot0(id TEXT);' });
  await f.json(`${base}/functions/pinned`, 'PUT', { source: 'export default () => null', expectedVersion: 0 }, 201);
  const tables = Object.fromEntries(Array.from({ length: 48 }, (_, i) => [`slot${i}`, ['insert']]));
  const { key } = await f.json(`${base}/api-keys`, 'POST', { name: 'Nearly full', origins: ['https://board.example'], tables, functions: { pinned: 1 } }, 201);
  const path = `${base}/api-keys/${key.id}`;
  const results = await Promise.all(['new_a', 'new_b'].map(table => f.request(path, 'PATCH', { table, operation: 'select' })));
  assert.deepEqual(results.map(response => response.status).sort(), [200, 429]);
  const denied = results.find(response => response.status === 429)!;
  assert.deepEqual(await denied.json(), { error: 'api_key_grant_limit' });
  const saved = (await f.json(`${base}/api-keys`)).keys[0];
  assert.equal(Object.keys(saved.tables).length, 49);
  assert.deepEqual(saved.functions, { pinned: 1 });
  assert.equal(['new_a', 'new_b'].filter(table => Object.hasOwn(saved.tables, table)).length, 1);
  await f.json(path, 'PATCH', { table: 'slot0', operation: 'select' });
  const repeated = await f.json(path, 'PATCH', { table: 'slot0', operation: 'select' });
  assert.deepEqual(repeated.key.tables.slot0, ['insert', 'select']);
  assert.equal(Object.keys(repeated.key.tables).length, 49);
});
