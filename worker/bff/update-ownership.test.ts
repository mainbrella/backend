import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './system-test-helpers';

test('own-row updates check existing and proposed authors through HTTP and functions', { timeout: 60_000 }, async t => {
  const f = await runtime(t);
  const { project } = await f.json('/projects', 'POST', { name: 'Update ownership', template: 'empty' }, 201);
  const base = `/projects/${project.id}`;
  await f.json(`${base}/provision`, 'POST');
  await f.json(`${base}/migrations`, 'POST', { sequence: 1, name: 'posts', sql: `
    CREATE TABLE users(id TEXT PRIMARY KEY);
    INSERT INTO users VALUES('alice'),('bob');
    CREATE TABLE posts(id TEXT PRIMARY KEY, author_id TEXT, body TEXT);
    INSERT INTO posts VALUES('alice-post','alice','Alice original'),('bob-post','bob','Bob original');
  ` });
  await f.json(`${base}/policies/posts`, 'PUT', { select: 'public', insert: 'own', update: 'own', ownerColumn: 'author_id' });
  await f.json(`${base}/functions/update_post`, 'PUT', { expectedVersion: 0, databaseAccess: 'write',
    source: `export default (input,ctx) => ctx.db.update('posts', input.filters, input.row)` }, 201);
  const { token } = await f.json(`${base}/api-keys`, 'POST', { name: 'Posts', origins: ['https://posts.example'],
    tables: { posts: ['select', 'insert', 'update'] }, functions: { update_post: 1 } }, 201);
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
    const update = async (id: string, row: Record<string, string | null>, denied = false) => {
      if (transport === 'http') return (await request(`/tables/posts?id=eq.${id}`, 'PATCH', row, denied ? 403 : 200)).data;
      const result = await request('/functions/update_post/invoke', 'POST', { input: { filters: { id }, row } });
      assert.equal(result.ok, !denied);
      if (denied) assert.match(result.error, /permission_denied/);
      return result.value?.results;
    };
    const before = await snapshot();
    // A valid proposed author cannot authorize taking someone else's existing row.
    for (const column of ['author_id', 'AUTHOR_ID', 'Author_Id']) {
      assert.deepEqual(await update('bob-post', { [column]: 'alice', body: 'Stolen' }), []);
    }
    // An existing owner cannot transfer or clear authorship, including via aliases.
    for (const column of ['author_id', 'AUTHOR_ID', 'Author_Id']) {
      for (const author of ['bob', null]) await update('alice-post', { [column]: author, body: 'Transferred' }, true);
    }
    await update('alice-post', { author_id: 'alice', AUTHOR_ID: 'bob' }, true);
    await update('alice-post', { AUTHOR_ID: 'bob', author_id: 'alice' }, true);
    assert.deepEqual(await snapshot(), before);
    const edited = await update('alice-post', { AUTHOR_ID: 'alice', body: `Edited via ${transport}` });
    assert.equal(edited[0].author_id, 'alice');
    assert.equal(edited[0].body, `Edited via ${transport}`);
  }
  // Inserts use the same proposed-owner check, including duplicate column aliases.
  for (const row of [{ AUTHOR_ID: 'bob' }, { author_id: 'alice', AUTHOR_ID: 'bob' }]) {
    await request('/tables/posts', 'POST', { id: 'forged', body: 'Forged', ...row }, 403);
  }
  const inserted = await request('/tables/posts', 'POST', { id: 'new', AUTHOR_ID: 'alice', body: 'Valid' }, 201);
  assert.equal(inserted.data[0].author_id, 'alice');
});
