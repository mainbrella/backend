import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './system-test-helpers';

test('own-row inserts and updates cannot replace another user through schema conflict rules', { timeout: 60_000 }, async t => {
  const f = await runtime(t);
  const { project } = await f.json('/projects', 'POST', { name: 'Replacement ownership', template: 'empty' }, 201);
  const base = `/projects/${project.id}`;
  await f.json(`${base}/provision`, 'POST');
  await f.json(`${base}/migrations`, 'POST', { sequence: 1, name: 'posts', sql: `
    CREATE TABLE users(id TEXT PRIMARY KEY);
    INSERT INTO users VALUES('alice'),('bob');
    CREATE TABLE posts(id TEXT PRIMARY KEY ON CONFLICT REPLACE, slug TEXT UNIQUE ON CONFLICT REPLACE, author_id TEXT, body TEXT);
    INSERT INTO posts VALUES('alice-post','alice-slug','alice','Alice original'),('bob-post','bob-slug','bob','Bob original');
  ` });
  await f.json(`${base}/policies/posts`, 'PUT', { select: 'public', insert: 'own', update: 'own', ownerColumn: 'author_id' });
  await f.json(`${base}/functions/write_post`, 'PUT', { expectedVersion: 0, databaseAccess: 'write', source: `
    export default (input,ctx) => input.operation === 'insert'
      ? ctx.db.insert('posts', input.row) : ctx.db.update('posts', { id: input.id }, input.row);
  ` }, 201);
  const { token } = await f.json(`${base}/api-keys`, 'POST', { name: 'Posts', origins: ['https://posts.example'],
    tables: { posts: ['select', 'insert', 'update'] }, functions: { write_post: 1 } }, 201);
  const alice = (await f.json(`${base}/sessions`, 'POST', { userId: 'alice' }, 201)).token;
  const request = async (path: string, method: string, input?: unknown, status = 200) => {
    const response = await f.mf.dispatchFetch(`https://api.mainbrella.com/bff/data/${project.id}${path}`, {
      method, headers: { apikey: token, authorization: `Bearer ${alice}`, origin: 'https://posts.example', 'content-type': 'application/json' },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    assert.equal(response.status, status, await response.clone().text());
    return response.json() as Promise<any>;
  };
  const snapshot = async () => (await request('/tables/posts?order=id.asc', 'GET')).data;

  for (const transport of ['http', 'function']) {
    const write = async (operation: string, row: Record<string, string>, denied = false) => {
      if (transport === 'http') {
        const result = await request(`/tables/posts${operation === 'update' ? '?id=eq.alice-post' : ''}`,
          operation === 'insert' ? 'POST' : 'PATCH', row, denied ? 502 : operation === 'insert' ? 201 : 200);
        if (denied) assert.equal(result.error, 'database_query_failed');
        return result.data;
      }
      const result = await request('/functions/write_post/invoke', 'POST', { input: { operation, id: 'alice-post', row } });
      assert.equal(result.ok, !denied);
      if (denied) assert.match(result.error, /database_query_failed/);
      return result.value?.results;
    };
    const before = await snapshot();
    for (const [operation, row] of [
      ['insert', { id: 'bob-post', slug: 'new-slug', body: 'Stolen through primary key' }],
      ['insert', { id: 'new-post', slug: 'bob-slug', body: 'Stolen through unique column' }],
      ['update', { id: 'bob-post', body: 'Stolen through primary key' }],
      ['update', { slug: 'bob-slug', body: 'Stolen through unique column' }],
    ] as const) {
      await write(operation, row, true);
      assert.deepEqual(await snapshot(), before, 'Conflicts must leave both users’ rows unchanged');
    }
    const inserted = await write('insert', { id: `${transport}-post`, slug: `${transport}-slug`, body: 'Allowed' });
    assert.equal(inserted[0].author_id, 'alice');
    const updated = await write('update', { body: `Edited via ${transport}` });
    assert.equal(updated[0].author_id, 'alice');
    assert.equal(updated[0].body, `Edited via ${transport}`);
  }
});

test('own-row writes reject rowid aliases through HTTP and functions', { timeout: 60_000 }, async t => {
  const f = await runtime(t);
  const { project } = await f.json('/projects', 'POST', { name: 'Rowid ownership', template: 'empty' }, 201);
  const base = `/projects/${project.id}`;
  await f.json(`${base}/provision`, 'POST');
  await f.json(`${base}/migrations`, 'POST', { sequence: 1, name: 'profiles', sql: `
    CREATE TABLE users(id TEXT PRIMARY KEY);
    INSERT INTO users VALUES('1'),('2'),('3'),('4');
    CREATE TABLE profiles(id INTEGER PRIMARY KEY, body TEXT);
    INSERT INTO profiles VALUES(1,'User one original');
  ` });
  await f.json(`${base}/policies/profiles`, 'PUT', { select: 'public', insert: 'own', update: 'own', ownerColumn: 'id' });
  await f.json(`${base}/functions/write_profile`, 'PUT', { expectedVersion: 0, databaseAccess: 'write', source: `
    export default (input,ctx) => input.operation === 'insert'
      ? ctx.db.insert('profiles', input.row) : ctx.db.update('profiles', { id: 1 }, input.row);
  ` }, 201);
  const { token } = await f.json(`${base}/api-keys`, 'POST', { name: 'Profiles', origins: ['https://profiles.example'],
    tables: { profiles: ['select', 'insert', 'update'] }, functions: { write_profile: 1 } }, 201);
  const one = (await f.json(`${base}/sessions`, 'POST', { userId: '1' }, 201)).token;
  const three = (await f.json(`${base}/sessions`, 'POST', { userId: '3' }, 201)).token;
  const request = async (path: string, method: string, session: string, input?: unknown, status = 200) => {
    const response = await f.mf.dispatchFetch(`https://api.mainbrella.com/bff/data/${project.id}${path}`, {
      method, headers: { apikey: token, authorization: `Bearer ${session}`, origin: 'https://profiles.example', 'content-type': 'application/json' },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    assert.equal(response.status, status, await response.clone().text());
    return response.json() as Promise<any>;
  };
  const snapshot = async () => (await request('/tables/profiles?order=id.asc', 'GET', one)).data;

  for (const transport of ['http', 'function']) {
    const write = async (operation: string, row: Record<string, string | number>, denied = false) => {
      const session = operation === 'insert' ? three : one;
      if (transport === 'http') {
        const result = await request(`/tables/profiles${operation === 'update' ? '?id=eq.1' : ''}`,
          operation === 'insert' ? 'POST' : 'PATCH', session, row, denied ? 403 : operation === 'insert' ? 201 : 200);
        if (denied) assert.equal(result.error, 'permission_denied');
        return result.data;
      }
      const result = await request('/functions/write_profile/invoke', 'POST', session, { input: { operation, row } });
      assert.equal(result.ok, !denied);
      if (denied) assert.match(result.error, /permission_denied/);
      return result.value?.results;
    };
    const before = await snapshot();
    for (const alias of ['rowid', 'ROWID', 'RowId', 'oid', 'OID', 'Oid']) {
      await write('update', { [alias]: 2, body: 'Transferred' }, true);
      // Keep the explicit owner before its alias: overwriting that key during
      // owner injection does not move it to the end of the INSERT column list.
      await write('insert', { id: '3', [alias]: 4, body: 'Forged' }, true);
      assert.deepEqual(await snapshot(), before);
    }
    const updated = await write('update', { body: `Edited via ${transport}` });
    assert.equal(updated[0].id, 1);
    assert.equal(updated[0].body, `Edited via ${transport}`);
  }
  const inserted = await request('/tables/profiles', 'POST', three, { body: 'Allowed' }, 201);
  assert.equal(inserted.data[0].id, 3);
});
