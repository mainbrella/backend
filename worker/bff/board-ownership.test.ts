import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runtime } from './system-test-helpers';

const initial = readFileSync(new URL('./fixtures/message-board/001_init.sql', import.meta.url), 'utf8');
const boards = readFileSync(new URL('./fixtures/message-board/002_boards.sql', import.meta.url), 'utf8');
const owners = readFileSync(new URL('./fixtures/message-board/003_board_owners.sql', import.meta.url), 'utf8');

test('signed-in users can post across boards while board edits remain owner-only', { timeout: 60_000 }, async t => {
  const f = await runtime(t);
  const project = (await f.json('/projects', 'POST', { name: 'Board ownership', template: 'empty' }, 201)).project;
  const base = `/projects/${project.id}`;
  await f.json(`${base}/provision`, 'POST');
  for (const [sequence, name, sql] of [[1, 'init', initial], [2, 'boards', boards], [3, 'board_owners', owners]] as const) {
    await f.json(`${base}/migrations`, 'POST', { sequence, name, sql });
  }
  const database = [...f.databases.values()][0].db;
  database.exec('PRAGMA foreign_keys=ON');

  const { key, token } = await f.json(`${base}/api-keys`, 'POST', { name: 'Board frontend',
    origins: ['https://board.example'], tables: { messages: ['select', 'update'], boards: ['select'] } }, 201);
  await f.json(`${base}/policies/messages`, 'PUT', { select: 'public', insert: 'own', update: 'own', delete: 'own', ownerColumn: 'user_id' });
  await f.json(`${base}/policies/boards`, 'PUT', { select: 'public', insert: 'own', update: 'own', delete: 'own', ownerColumn: 'user_id' });

  const browser = async (table: string, method: string, input?: unknown, session?: string, status = 200, query = '') => {
    const response = await f.mf.dispatchFetch(`https://api.mainbrella.com/bff/data/${project.id}/tables/${table}${query}`, {
      method, headers: { apikey: token, origin: 'https://board.example', 'content-type': 'application/json',
        ...(session ? { authorization: `Bearer ${session}` } : {}) },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    assert.equal(response.status, status, await response.clone().text());
    return response.json() as Promise<any>;
  };
  const alice = (await f.json(`${base}/sessions`, 'POST', { userId: 'alice' }, 201)).token as string;
  const bob = (await f.json(`${base}/sessions`, 'POST', { userId: 'bob' }, 201)).token as string;
  await browser('messages', 'POST', { board_id: 'general', body: 'Denied without the key grant' }, alice, 403);

  await f.json(`${base}/api-keys/${key.id}`, 'PATCH', { table: 'messages', operation: 'insert' });
  await f.json(`${base}/api-keys/${key.id}`, 'PATCH', { table: 'messages', operation: 'insert' });
  await f.json(`${base}/api-keys/${key.id}`, 'PATCH', { table: 'boards', operation: 'insert' });
  await f.json(`${base}/api-keys/${key.id}`, 'PATCH', { table: 'boards', operation: 'update' });
  await f.json(`${base}/api-keys/${key.id}`, 'PATCH', { table: 'boards', operation: 'delete' });
  assert.deepEqual((await f.json(`${base}/api-keys`)).keys[0].tables.messages, ['select', 'update', 'insert']);
  await browser('boards', 'POST', { slug: 'anonymous-board', name: 'Anonymous' }, undefined, 403);

  const aliceBoard = (await browser('boards', 'POST', { slug: 'alice-board', name: 'Alice board' }, alice, 201)).data[0];
  const bobBoard = (await browser('boards', 'POST', { slug: 'bob-board', name: 'Bob board' }, bob, 201)).data[0];
  const unusedBoard = (await browser('boards', 'POST', { slug: 'alice-unused', name: 'Unused' }, alice, 201)).data[0];
  assert.equal(aliceBoard.user_id, 'alice');
  assert.equal(bobBoard.user_id, 'bob');
  assert.equal(unusedBoard.user_id, 'alice');
  await browser('boards', 'POST', { slug: 'forged-board', name: 'Forged', user_id: 'alice' }, bob, 403);

  const alicePost = (await browser('messages', 'POST', { board_id: bobBoard.id, body: 'Alice on Bob board' }, alice, 201)).data[0];
  const bobPost = (await browser('messages', 'POST', { board_id: aliceBoard.id, body: 'Bob on Alice board' }, bob, 201)).data[0];
  assert.equal(alicePost.user_id, 'alice');
  assert.equal(alicePost.board_id, bobBoard.id);
  assert.equal(bobPost.user_id, 'bob');
  assert.equal(bobPost.board_id, aliceBoard.id);
  const bobEdit = await browser('messages', 'PATCH', { body: 'Bob edited his post in Alice board' }, bob, 200, `?id=eq.${bobPost.id}`);
  assert.equal(bobEdit.data[0].body, 'Bob edited his post in Alice board');
  assert.deepEqual((await browser('messages', 'PATCH', { body: 'Alice cannot edit Bob post' }, alice, 200, `?id=eq.${bobPost.id}`)).data, []);
  await browser('messages', 'POST', { board_id: aliceBoard.id, body: 'Forged author', user_id: 'alice' }, bob, 403);
  await browser('messages', 'POST', { board_id: 'missing', body: 'Missing board' }, alice, 502);
  await browser('messages', 'POST', { board_id: aliceBoard.id, body: 'Anonymous' }, undefined, 403);

  assert.deepEqual((await browser('boards', 'PATCH', { name: 'Stolen' }, bob, 200, `?id=eq.${aliceBoard.id}`)).data, []);
  assert.deepEqual((await browser('boards', 'DELETE', undefined, bob, 200, `?id=eq.${aliceBoard.id}`)).data, []);
  await browser('boards', 'PATCH', { user_id: 'bob' }, alice, 403, `?id=eq.${aliceBoard.id}`);
  const changed = await browser('boards', 'PATCH', { name: 'Alice edited her board' }, alice, 200, `?id=eq.${aliceBoard.id}`);
  assert.equal(changed.data[0].name, 'Alice edited her board');
  const removed = await browser('boards', 'DELETE', undefined, alice, 200, `?id=eq.${unusedBoard.id}`);
  assert.equal(removed.meta.changes, 1);
});
