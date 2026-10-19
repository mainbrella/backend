import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { runtime } from './system-test-helpers';

test('existing account keys authenticate BFF SQL, table data, functions, and project key management', async t => {
  const f = await runtime(t);
  const created = await f.mf.dispatchFetch('https://api.mainbrella.com/api-keys', {
    method: 'POST', headers: { cookie: 'mainbrella_session=owner', origin: 'https://mainbrella.com' }, body: JSON.stringify({ name: 'Existing account key' }),
  });
  assert.equal(created.status, 201);
  const { key, token } = await created.json() as any;
  assert.match(token, /^mb_[a-f0-9]{64}$/);
  const request = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => f.mf.dispatchFetch(`https://api.mainbrella.com/bff${path}`, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  async function json(path: string, method = 'GET', body?: unknown, status = 200) {
    const response = await request(path, method, body);
    assert.equal(response.status, status, await response.clone().text());
    return response.json() as Promise<any>;
  }
  const project = (await json('/projects', 'POST', { name: 'Account key backend', template: 'empty' }, 201)).project;
  const base = `/projects/${project.id}`, table = `/data/${project.id}/tables/notes`;
  await json(`${base}/provision`, 'POST');
  await json(`${base}/migrations`, 'POST', { sequence: 1, name: 'notes', sql: 'CREATE TABLE notes(id TEXT PRIMARY KEY, body TEXT);' });
  await json(`${base}/query`, 'POST', { sql: 'INSERT INTO notes VALUES(?,?)', params: ['one', 'Account key works'] });
  assert.equal((await json(`${base}/query`, 'POST', { sql: 'SELECT * FROM notes' })).result.results[0].body, 'Account key works');
  assert.equal((await json(table)).data[0].body, 'Account key works');
  assert.equal((await json(table, 'POST', { id: 'two', body: null }, 201)).data[0].id, 'two');
  assert.equal((await json(`${table}?id=eq.two`, 'PATCH', { body: 'Changed' })).data[0].body, 'Changed');
  assert.equal((await json(`${table}?id=eq.two`, 'DELETE')).meta.changes, 1);
  await json(table, 'PATCH', { body: 'Missing filter' }, 400);
  await json(table, 'DELETE', undefined, 400);
  await json(table, 'POST', {}, 400);
  const policy = await json(`${base}/policies/notes`, 'PUT', { select: 'public' });
  assert.equal(policy.policy.select, 'public');
  assert.equal((await json(`${base}/policies`)).policies[0].table, 'notes');
  await json(`${base}/policies/notes`, 'DELETE');
  await json(`${base}/functions/hello`, 'PUT', { source: `export default () => 'hello'`, expectedVersion: 0 }, 201);
  assert.equal((await json(`${base}/functions/hello/invoke`, 'POST', { input: null })).value, 'hello');
  assert.equal((await json(`/data/${project.id}/functions/hello/invoke`, 'POST', { input: null })).value, 'hello');
  const browser = await json(`${base}/api-keys`, 'POST', { name: 'Browser', origins: ['https://app.example'], tables: { notes: ['select'] } }, 201);
  await json(`${base}/api-keys/${browser.key.id}`, 'DELETE');
  assert.equal((await json(`${base}/api-keys`)).keys.length, 0);
  assert.ok((await f.db.prepare('SELECT last_used_at FROM api_keys WHERE id=?').bind(key.id).first())!.last_used_at);
  assert.equal((await request(table, 'GET', undefined, { origin: 'https://app.example' })).status, 403, 'Account keys cannot use arbitrary browser origins');
  assert.equal((await request('/projects', 'GET', undefined, { cookie: 'mainbrella_session=owner', authorization: `Bearer mb_${'0'.repeat(64)}` })).status, 401);
  assert.equal((await request('/projects', 'GET', undefined, { authorization: 'Bearer invalid', cookie: 'mainbrella_session=owner' })).status, 401);
  const strangerProject = (await f.request('/projects', 'POST', { name: 'Other account backend', template: 'empty' }, 'stranger').then(response => response.json()) as any).project;
  await json(`/projects/${strangerProject.id}`, 'GET', undefined, 404);
  await json(`/data/${strangerProject.id}/tables/notes`, 'GET', undefined, 404);
  const revoked = await f.mf.dispatchFetch(`https://api.mainbrella.com/api-keys?id=${key.id}`, { method: 'DELETE', headers: { cookie: 'mainbrella_session=owner', origin: 'https://mainbrella.com' } });
  assert.equal(revoked.status, 200);
  await json(`${base}/query`, 'POST', { sql: 'SELECT * FROM notes' }, 401);
  await json(table, 'GET', undefined, 401);
});

test('shared key migration preserves existing browser tokens and cascades revocation and project deletion', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys=ON');
  const migrate = (name: string) => db.exec(readFileSync(new URL(`../../migrations/${name}.sql`, import.meta.url), 'utf8'));
  for (const name of ['001_initial', '010_api_keys', '050_bff', '051_bff_api_keys']) migrate(name);
  db.exec("INSERT INTO users(id,name) VALUES('owner','Owner'); INSERT INTO bff_projects(id,user_id,name,created_at) VALUES('project','owner','Project','2026-10-16')");
  db.exec(`INSERT INTO bff_api_keys(id,project_id,name,token_hash,prefix,origins,tables,functions,created_at)
    VALUES('legacy','project','Old browser key','unchanged-hash','bff_pk_old','["https://app.example"]','{"notes":["select"]}','{}','2026-10-16')`);
  migrate('052_bff_shared_api_keys');
  assert.equal(db.prepare("SELECT token_hash FROM api_keys WHERE id='legacy'").get()!.token_hash, 'unchanged-hash');
  assert.equal(db.prepare("SELECT tables FROM bff_api_key_grants WHERE api_key_id='legacy'").get()!.tables, '{"notes":["select"]}');
  db.exec("DELETE FROM api_keys WHERE id='legacy'");
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bff_api_key_grants').get()!.n, 0);
  db.exec("INSERT INTO api_keys(id,user_id,name,token_hash,prefix,created_at) VALUES('scoped','owner','Scoped','second-hash','bff_pk_new','2026-10-16')");
  db.exec("INSERT INTO bff_api_key_grants VALUES('scoped','project','[]','{}','{}'); DELETE FROM bff_projects WHERE id='project'");
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM api_keys').get()!.n, 0);
});
