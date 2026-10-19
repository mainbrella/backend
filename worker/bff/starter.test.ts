import test from 'node:test';
import assert from 'node:assert/strict';
import { checksum } from './contracts';
import { messageBoardMigration } from './starter';
import { runtime } from './system-test-helpers';

test('new projects install a recoverable message board with real user ownership on tables and functions', { timeout: 60_000 }, async t => {
  const f = await runtime(t);
  const { project } = await f.json('/projects', 'POST', { name: 'Message board' }, 201);
  const base = `/projects/${project.id}`, data = `/data/${project.id}`;
  f.loseCreateResponse();
  await f.json(`${base}/provision`, 'POST', undefined, 502);
  await f.json(`${base}/provision`, 'POST');
  assert.deepEqual((await f.json(`${base}/schema`)).tables.map((table: any) => [table.name, table.count]), [['messages', 2], ['users', 2]]);
  const migrations = (await f.json(`${base}/migrations`)).migrations;
  assert.equal(migrations.length, 1);
  assert.equal(migrations[0].checksum, await checksum(messageBoardMigration.sql));
  assert.deepEqual((await f.json(`${base}/functions`)).functions.map((fn: any) => fn.name), ['delete_message', 'edit_message', 'list_messages', 'post_message']);
  const policies = (await f.json(`${base}/policies`)).policies;
  assert.equal(policies[0].table, 'messages');
  assert.equal(policies[0].ownerColumn, 'user_id');
  assert.deepEqual(['select', 'insert', 'update', 'delete'].map(op => policies[0][op]), ['public', 'own', 'own', 'own']);

  // Resuming a partially completed provisioning must not duplicate seeds or
  // overwrite a saved function version or a policy edited by the owner.
  await f.json(`${base}/query`, 'POST', { sql: "UPDATE messages SET body='Changed seed' WHERE id='welcome'" });
  await f.db.prepare("UPDATE bff_projects SET state='error' WHERE id=?").bind(project.id).run();
  await f.json(`${base}/provision`, 'POST');
  assert.equal(f.databases.size, 1);
  assert.equal((await f.json(`${base}/query`, 'POST', { sql: "SELECT body FROM messages WHERE id='welcome'" })).result.results[0].body, 'Changed seed');
  assert.equal((await f.json(`${base}/migrations`)).migrations.length, 1);
  await f.json(`${base}/migrations`, 'POST', { sequence: 2, name: 'extra', sql: 'CREATE TABLE private_notes(body TEXT);' });
  for (const policy of [{ select: 'public', insert: 'own' }, { select: 'public', update: 'own', ownerColumn: '_bff_private' }]) {
    await f.json(`${base}/policies/messages`, 'PUT', policy, 400);
  }
  await f.json(`${base}/policies/messages`, 'PUT', { select: 'public', update: 'own', ownerColumn: 'missing' }, 404);
  await f.json(`${base}/functions/forged_author`, 'PUT', { expectedVersion: 0, databaseAccess: 'write',
    source: `export default (_,ctx) => ctx.db.insert('messages', {user_id:'bob',body:'Forged inside a function'})` }, 201);
  await f.json(`${base}/functions/delayed_write`, 'PUT', { expectedVersion: 0, databaseAccess: 'write',
    source: `export default async (_,ctx) => { await ctx.db.select('messages'); await new Promise(resolve => setTimeout(resolve,500)); return ctx.db.insert('messages',{body:'After revocation'}); }` }, 201);

  const origin = 'https://board.example';
  const { key, token } = await f.json(`${base}/api-keys`, 'POST', { name: 'Board', origins: [origin],
    tables: { users: ['select', 'insert', 'update', 'delete'], messages: ['select', 'insert', 'update', 'delete'], private_notes: ['select'] },
    functions: { list_messages: 1, post_message: 1, edit_message: 1, delete_message: 1, forged_author: 1, delayed_write: 1 } }, 201);
  const alice = await f.json(`${base}/sessions`, 'POST', { userId: 'alice' }, 201);
  const bob = await f.json(`${base}/sessions`, 'POST', { userId: 'bob' }, 201);
  assert.match(alice.token, /^bff_us_[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(await f.json(`${base}/sessions`)).includes(alice.token));
  assert.equal((await f.db.prepare('SELECT token_hash FROM bff_user_sessions WHERE id=?').bind(alice.session.id).first())!.token_hash, await checksum(alice.token));
  await f.json(`${base}/sessions`, 'POST', { userId: 'missing' }, 404);
  assert.equal((await f.request(`${base}/sessions`, 'POST', { userId: 'bob' }, 'stranger')).status, 404);
  assert.equal((await f.request(`${base}/sessions`, 'POST', { userId: 'bob' }, 'owner', { authorization: `Bearer ${alice.token}` })).status, 401);

  async function browser(path: string, method = 'GET', body?: unknown, session?: string, status = 200, browserToken = token) {
    const response = await f.mf.dispatchFetch(`https://api.mainbrella.com/bff${data}${path}`, {
      method, headers: { apikey: browserToken, origin, 'content-type': 'application/json', ...(session ? { authorization: `Bearer ${session}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal(response.status, status, await response.clone().text());
    if (status !== 401) assert.equal(response.headers.get('access-control-allow-origin'), origin);
    return response.json() as Promise<any>;
  }
  assert.equal((await browser('/tables/messages')).data.length, 2);
  assert.equal((await browser('/tables/messages', 'GET', undefined, bob.token)).data.length, 2);
  await browser('/tables/messages', 'POST', { body: 'Anonymous', user_id: 'alice' }, undefined, 403);
  await browser('/tables/messages', 'POST', { body: 'Forged author', user_id: 'bob' }, alice.token, 403);
  const posted = (await browser('/tables/messages', 'POST', { body: 'Hello from Alice' }, alice.token, 201)).data[0];
  assert.equal(posted.user_id, 'alice');
  assert.ok(posted.id);
  assert.equal((await browser(`/tables/messages?id=eq.${posted.id}`, 'PATCH', { body: 'Edited' }, alice.token)).data[0].body, 'Edited');
  assert.deepEqual((await browser(`/tables/messages?id=eq.${posted.id}`, 'PATCH', { body: 'Bob cannot edit this' }, bob.token)).data, []);
  assert.equal((await browser(`/tables/messages?id=eq.${posted.id}`, 'DELETE', undefined, bob.token)).meta.changes, 0);
  await browser(`/tables/messages?id=eq.${posted.id}`, 'PATCH', { user_id: 'bob' }, alice.token, 403);
  // Client filters remain ANDed with ownership, including a conflicting author.
  assert.deepEqual((await browser('/tables/messages?user_id=eq.bob', 'PATCH', { body: 'Nope' }, alice.token)).data, []);
  await browser('/tables/messages', 'PATCH', { body: 'No filter' }, alice.token, 400);
  await browser('/tables/messages', 'DELETE', undefined, alice.token, 400);
  await browser('/tables/users?id=eq.alice', 'PATCH', { name: 'Impersonate Alice' }, bob.token, 403);
  await browser('/tables/private_notes', 'GET', undefined, alice.token, 403);

  const call = (name: string, input: unknown, session?: string) => browser(`/functions/${name}/invoke`, 'POST', { input }, session);
  const forged = await call('forged_author', null, alice.token);
  assert.equal(forged.ok, false);
  assert.match(forged.error, /permission_denied/);
  const anonymousPost = await call('post_message', { body: 'Spoof', userId: 'alice', role: 'owner' });
  assert.equal(anonymousPost.ok, false);
  assert.equal((await call('list_messages', {}, bob.token)).value.length, 3);
  const fnPost = await call('post_message', { body: 'Via function', user_id: 'bob', user: { id: 'bob' } }, alice.token);
  assert.equal(fnPost.ok, true);
  assert.equal(fnPost.value[0].user_id, 'alice');
  const fnId = fnPost.value[0].id;
  assert.deepEqual((await call('edit_message', { id: fnId, body: 'Stolen' }, bob.token)).value, []);
  assert.equal((await call('delete_message', { id: fnId }, bob.token)).value.meta.changes, 0);
  assert.equal((await call('edit_message', { id: fnId, body: 'Owner edit' }, alice.token)).value[0].body, 'Owner edit');
  assert.equal((await call('delete_message', { id: fnId }, alice.token)).value.meta.changes, 1);
  assert.equal((await browser(`/tables/messages?id=eq.${posted.id}`, 'DELETE', undefined, alice.token)).meta.changes, 1);

  // A session never expands the key's grants or crosses a project boundary.
  const reader = await f.json(`${base}/api-keys`, 'POST', { name: 'Reader', origins: [origin], tables: { messages: ['select'] } }, 201);
  await browser('/tables/messages', 'POST', { body: 'No grant' }, alice.token, 403, reader.token);
  const other = (await f.json('/projects', 'POST', { name: 'Other board' }, 201)).project;
  await f.json(`/projects/${other.id}/provision`, 'POST');
  const otherSession = await f.json(`/projects/${other.id}/sessions`, 'POST', { userId: 'alice' }, 201);
  await browser('/tables/messages', 'POST', { body: 'Wrong project' }, otherSession.token, 401);
  const temporary = await f.json(`${base}/sessions`, 'POST', { userId: 'alice' }, 201);
  const before = f.calls.length;
  const running = call('delayed_write', null, temporary.token);
  for (let i = 0; i < 200 && !f.calls.slice(before).some(call => call.body?.batch?.some((query: any) => query.sql.startsWith('SELECT * FROM "messages"'))); i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok(f.calls.slice(before).some(call => call.body?.batch?.some((query: any) => query.sql.startsWith('SELECT * FROM "messages"'))));
  await f.json(`${base}/sessions/${temporary.session.id}`, 'DELETE');
  const revokedWhileRunning = await running;
  assert.equal(revokedWhileRunning.ok, false);
  assert.match(revokedWhileRunning.error, /unauthorized/);
  await f.json(`${base}/sessions/${alice.session.id}`, 'DELETE');
  await browser('/tables/messages', 'POST', { body: 'Revoked' }, alice.token, 401);
  await f.db.prepare("UPDATE bff_user_sessions SET expires_at='2020-01-01' WHERE id=?").bind(bob.session.id).run();
  await browser('/tables/messages', 'GET', undefined, bob.token, 401);
  const deletedUser = await f.json(`${base}/sessions`, 'POST', { userId: 'alice' }, 201);
  await f.json(`${base}/query`, 'POST', { sql: "DELETE FROM messages WHERE user_id='alice'" });
  await f.json(`${base}/query`, 'POST', { sql: "DELETE FROM users WHERE id='alice'" });
  await browser('/tables/messages', 'GET', undefined, deletedUser.token, 401);
  await f.json(`${base}/api-keys/${key.id}`, 'DELETE');
  await browser('/tables/messages', 'GET', undefined, undefined, 401);
});

test('existing projects and explicitly empty projects are not seeded', async t => {
  const f = await runtime(t);
  const id = crypto.randomUUID();
  await f.db.prepare("INSERT INTO bff_projects(id,user_id,name,created_at) VALUES(?,'owner','Legacy pending project',?)").bind(id, new Date().toISOString()).run();
  await f.json(`/projects/${id}/provision`, 'POST');
  assert.deepEqual((await f.json(`/projects/${id}/schema`)).tables, []);
  const project = (await f.json('/projects', 'POST', { name: 'Empty', template: 'empty' }, 201)).project;
  await f.json(`/projects/${project.id}/provision`, 'POST');
  assert.deepEqual((await f.json(`/projects/${project.id}/schema`)).tables, []);
});
