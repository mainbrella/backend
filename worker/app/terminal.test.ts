import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { hashToken } from './auth-core';
import { handleRequest } from './router';

const GENERATION = '2026-10-05T12:00:00.000Z';
async function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE users (id TEXT, email TEXT, name TEXT, dob TEXT, google_sub TEXT, created_at TEXT);
    CREATE TABLE sessions (token_hash TEXT, user_id TEXT, expires_at TEXT);`);
  for (const [id, token] of [['one', 'a'], ['two', 'b']]) {
    db.prepare('INSERT INTO users (id) VALUES (?)').run(id);
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(await hashToken(token), id, '2099-01-01T00:00:00.000Z');
  }
  const names: string[] = [];
  const calls: Request[] = [];
  let running = true;
  let terminalStatus = 101;
  const upgrade = { status: 101, webSocket: {} } as unknown as Response;
  const env = {
    DB: { prepare(sql: string) { return { bind(...args: string[]) { return { first() { return db.prepare(sql).get(...args) ?? null; } }; } }; } },
    USER_CONTAINER: {
      idFromName(name: string) { names.push(name); return name; },
      get() { return { fetch(request: Request) {
        calls.push(request);
        if (new URL(request.url).pathname === '/terminal') return terminalStatus === 101 ? upgrade : Response.json({ secret: 'internal failure' }, { status: terminalStatus });
        return Response.json({ containers: running ? [{ createdAt: GENERATION, expiresAt: '2099-01-01T00:00:00.000Z' }] : [] });
      } }; },
    },
  } as unknown as Env;
  const request = (headers: Record<string, string | null> = {}, query = `createdAt=${GENERATION}&cols=80&rows=24`, method = 'GET') => {
    const values = new Headers({ Origin: 'https://mainbrella.com', Cookie: 'mainbrella_session=a', Upgrade: 'websocket' });
    for (const [key, value] of Object.entries(headers)) { if (value === null) values.delete(key); else values.set(key, value); }
    return new Request(`https://api.mainbrella.com/containers/terminal?${query}`, { headers: values, method });
  };
  return { env, names, calls, upgrade, request, db, setRunning(value: boolean) { running = value; }, setStatus(value: number) { terminalStatus = value; } };
}

test('terminal requires a session, explicit trusted Origin, GET and WebSocket upgrade', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  assert.equal((await handleRequest(f.request({ Cookie: null }), f.env)).status, 401);
  assert.equal((await handleRequest(f.request({ Cookie: 'mainbrella_session=bad' }), f.env)).status, 401);
  assert.equal((await handleRequest(f.request({ Origin: null }), f.env)).status, 403);
  assert.equal((await handleRequest(f.request({ Origin: 'https://attacker.com' }), f.env)).status, 403);
  assert.equal((await handleRequest(f.request({ Upgrade: null }), f.env)).status, 426);
  assert.equal((await handleRequest(f.request({}, undefined, 'POST'), f.env)).status, 405);
  assert.equal(f.calls.length, 0);
});

test('terminal exclusively selects the session owner and strips browser credentials and overrides', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const response = await handleRequest(f.request({ Authorization: 'Bearer secret', 'x-terminal-created-at': 'victim', 'x-user-id': 'victim', 'x-terminal-cols': '999' }), f.env);
  assert.equal(response, f.upgrade);
  assert.deepEqual(f.names, ['user:one']);
  assert.deepEqual(f.calls.map(c => [c.method, c.url]), [['GET', 'https://internal/container'], ['GET', 'https://internal/terminal']]);
  const forwarded = f.calls[1];
  assert.deepEqual([...forwarded.headers.keys()].sort(), ['upgrade', 'x-terminal-cols', 'x-terminal-created-at', 'x-terminal-expires-at', 'x-terminal-rows']);
  assert.equal(forwarded.headers.get('x-terminal-created-at'), GENERATION);
  assert.equal(forwarded.headers.get('x-terminal-cols'), '80');
  assert.equal(forwarded.headers.get('x-terminal-expires-at'), String(Date.parse('2099-01-01T00:00:00.000Z')));
  assert.equal(await forwarded.text(), '');
  await handleRequest(f.request({ Cookie: 'mainbrella_session=b' }), f.env);
  assert.equal(f.names.at(-1), 'user:two');
});

test('stopped and stale generations cannot attach, start, or change start quota', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  f.setRunning(false);
  assert.equal((await handleRequest(f.request(), f.env)).status, 409);
  f.setRunning(true);
  assert.equal((await handleRequest(f.request({}, 'createdAt=2026-10-05T13:00:00.000Z'), f.env)).status, 409);
  assert.ok(f.calls.every(c => c.method === 'GET' && new URL(c.url).pathname === '/container'));
  // DB exposes only read-only session lookup; quota SQL would fail this fixture.
  f.setStatus(409); // Stop/recreate races must also be rejected by the DO.
  assert.equal((await handleRequest(f.request(), f.env)).status, 409);
});

test('dimensions are finite integers, clamped, and selection parameters rejected', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  for (const extra of ['userId=victim', 'id=victim', 'image=other', 'instance=standard-2', 'session=other', 'cols=1&cols=2']) {
    assert.equal((await handleRequest(f.request({}, `createdAt=${GENERATION}&${extra}`), f.env)).status, 400);
  }
  for (const value of ['NaN', 'Infinity', '1.2', '1e2', '']) {
    assert.equal((await handleRequest(f.request({}, `createdAt=${GENERATION}&cols=${value}`), f.env)).status, 400);
  }
  assert.equal((await handleRequest(f.request({}, ''), f.env)).status, 400);
  await handleRequest(f.request({}, `createdAt=${GENERATION}&cols=9999&rows=-1`), f.env);
  assert.equal(f.calls.at(-1)!.headers.get('x-terminal-cols'), '500');
  assert.equal(f.calls.at(-1)!.headers.get('x-terminal-rows'), '1');
  await handleRequest(f.request({}, `createdAt=${GENERATION}`), f.env);
  assert.equal(f.calls.at(-1)!.headers.get('x-terminal-cols'), '80');
  assert.equal(f.calls.at(-1)!.headers.get('x-terminal-rows'), '24');
});

test('terminal service errors are sanitized and session limits preserved', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  f.setStatus(429);
  assert.equal((await handleRequest(f.request(), f.env)).status, 429);
  f.setStatus(500);
  assert.deepEqual(await (await handleRequest(f.request(), f.env)).json(), { error: 'terminal_unavailable' });
  assert.equal((await handleRequest(f.request(), { ...f.env, USER_CONTAINER: undefined } as unknown as Env)).status, 503);
});
