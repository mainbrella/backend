import test from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS } from './contracts';
import { runtime } from './system-test-helpers';

test('public SELECT policies deny by default and apply to direct reads and every function database call', { timeout: 30_000 }, async t => {
  const f = await runtime(t);
  const project = (await f.json('/projects', 'POST', { name: 'Public read example', template: 'empty' }, 201)).project;
  const base = `/projects/${project.id}`, data = `/data/${project.id}`;
  await f.json(`${base}/provision`, 'POST');
  await f.json(`${base}/migrations`, 'POST', { sequence: 1, name: 'example', sql: "CREATE TABLE products(id TEXT PRIMARY KEY, name TEXT); INSERT INTO products VALUES('one','Coffee'),('two','Tea'); CREATE TABLE private_notes(secret TEXT); INSERT INTO private_notes VALUES('private'); CREATE TABLE spare(id TEXT);" });
  assert.deepEqual((await f.json(`${base}/policies`)).policies, []);
  const save = async (name: string, source: string) => f.json(`${base}/functions/${name}`, 'PUT', { source, expectedVersion: 0, databaseAccess: 'write' }, 201);
  await save('read', `export default async (_, ctx) => (await ctx.db.select('products')).results`);
  await save('private_read', `export default async (_, ctx) => ctx.db.select('private_notes')`);
  await save('write', `export default async (_, ctx) => ctx.db.insert('products', {id:'bad',name:'Bad'})`);
  await save('repeat_read', `export default async (_, ctx) => { await ctx.db.select('products'); await new Promise(resolve => setTimeout(resolve,500)); return ctx.db.select('products'); }`);
  const { token } = await f.json(`${base}/api-keys`, 'POST', { name: 'Example frontend', origins: ['http://localhost:3000'],
    tables: { products: ['select', 'insert'], private_notes: ['select'] }, functions: { read: 1, private_read: 1, write: 1, repeat_read: 1 } }, 201);
  async function browser(path: string, method = 'GET', input?: unknown, expected = 200) {
    const response = await f.mf.dispatchFetch(`https://api.mainbrella.com/bff${data}${path}`, {
      method, headers: { apikey: token, origin: 'http://localhost:3000', 'content-type': 'application/json' },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    assert.equal(response.status, expected, await response.clone().text());
    assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:3000');
    return response.json() as Promise<any>;
  }
  const deniedCalls = f.calls.length;
  await browser('/tables/products?select=*', 'GET', undefined, 403);
  await browser('/tables/products?id=eq.one', 'GET', undefined, 403);
  assert.equal(f.calls.length, deniedCalls);
  const beforePolicy = await browser('/functions/read/invoke', 'POST', { input: { role: 'owner' } });
  assert.equal(beforePolicy.ok, false);
  assert.match(beforePolicy.error, /permission_denied/);
  assert.equal((await f.request(`${base}/policies/products`, 'PUT', { select: 'public' }, 'stranger')).status, 404);
  assert.equal((await f.request(`${base}/policies/products`, 'PUT', { select: 'public' }, 'owner', { authorization: `Bearer ${token}` })).status, 401);
  for (const value of [{ select: true }, { select: 'public', insert: 'public' }, { select: 'owner' }]) await f.json(`${base}/policies/products`, 'PUT', value, 400);
  await f.json(`${base}/policies/sqlite_schema`, 'PUT', { select: 'public' }, 400);
  await f.json(`${base}/policies/missing`, 'PUT', { select: 'public' }, 404);
  await f.json(`${base}/policies/products`, 'PUT', { select: 'public' });
  assert.equal((await f.json(`${base}/policies`)).policies[0].select, 'public');
  // The exact frontend request: no owner key, session, user token, or row filter.
  assert.deepEqual((await browser('/tables/products?select=*&order=id.asc')).data, [{ id: 'one', name: 'Coffee' }, { id: 'two', name: 'Tea' }]);
  const reloaded = await browser('/tables/products?select=*');
  assert.equal(reloaded.data.length, 2);
  assert.equal((await browser('/functions/read/invoke', 'POST', { input: null })).value.length, 2);
  await browser('/tables/private_notes', 'GET', undefined, 403);
  const privateRead = await browser('/functions/private_read/invoke', 'POST', { input: { role: 'owner', userId: 'owner' } });
  assert.equal(privateRead.ok, false);
  assert.match(privateRead.error, /permission_denied/);
  await browser('/tables/products', 'POST', { id: 'bad', name: 'Bad' }, 403);
  const write = await browser('/functions/write/invoke', 'POST', { input: null });
  assert.equal(write.ok, false);
  assert.match(write.error, /permission_denied/);
  // A running function must re-read policy before its next database call.
  const callsBefore = f.calls.length;
  const running = browser('/functions/repeat_read/invoke', 'POST', { input: null });
  for (let i = 0; f.calls.length === callsBefore && i < 200; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(f.calls.length > callsBefore, 'The first function database read completed');
  await f.json(`${base}/policies/products`, 'DELETE');
  const interrupted = await running;
  assert.equal(interrupted.ok, false);
  assert.match(interrupted.error, /permission_denied/);
  await browser('/tables/products', 'GET', undefined, 403);
  await f.json(`${base}/policies/products`, 'PUT', { select: 'none' });
  await browser('/tables/products', 'GET', undefined, 403);
  await f.json(`${base}/policies/products`, 'PUT', { select: 'public' });
  await f.json(base, 'PATCH', { suspended: true });
  await browser('/tables/products', 'GET', undefined, 403);
  await f.json(`${base}/policies/products`, 'DELETE');
  assert.deepEqual((await f.json(`${base}/policies`)).policies, []);
  await f.json(base, 'PATCH', { suspended: false });
  await browser('/tables/products', 'GET', undefined, 403);
  // A public table still needs a key grant; policy cannot widen a restricted key.
  await f.json(`${base}/policies/spare`, 'PUT', { select: 'public' });
  await browser('/tables/spare', 'GET', undefined, 403);
  for (let i = 0; i < LIMITS.tablePolicies - 1; i++) await f.db.prepare("INSERT INTO bff_table_policies(project_id,table_name,select_access,updated_at) VALUES(?,?,'none',?)").bind(project.id, `policy${i}`, new Date().toISOString()).run();
  await f.json(`${base}/policies/products`, 'PUT', { select: 'public' }, 429);
  await f.json(`${base}/policies/spare`, 'PUT', { select: 'none' });
  await f.db.prepare("DELETE FROM users WHERE id='owner'").run();
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM bff_table_policies').first())!.n, 0);
});
