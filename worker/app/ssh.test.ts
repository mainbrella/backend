import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleSSHRequest } from './ssh';
import { hashToken } from './auth-core';

const GATEWAY_SECRET = 'gateway-secret-for-tests-12345678901234567890';
const USER_ONE = 'account-one';
const USER_TWO = 'account-two';
const SESSION_ONE = 'browser-session-one';
const SESSION_TWO = 'browser-session-two';
const GENERATION_ONE = '2026-10-05T12:00:00.000Z';
const GENERATION_TWO = '2026-10-05T13:00:00.000Z';

async function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, name TEXT, dob TEXT, google_sub TEXT, created_at TEXT);
    CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT, expires_at TEXT);
    CREATE TABLE ssh_access_tokens (token_hash TEXT PRIMARY KEY, user_id TEXT, container_created_at TEXT, expires_at INTEGER);
  `);
  for (const [id, session] of [[USER_ONE, SESSION_ONE], [USER_TWO, SESSION_TWO]]) {
    sqlite.prepare("INSERT INTO users (id, email, name, created_at) VALUES (?, ?, 'Test User', ?)")
      .run(id, `${id}@example.com`, GENERATION_ONE);
    sqlite.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(await hashToken(session), id, '2099-01-01T00:00:00.000Z');
  }
  const containers = new Map<string, { createdAt: string; expiresAt: string } | undefined>([
    [USER_ONE, { createdAt: GENERATION_ONE, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }],
    [USER_TWO, { createdAt: GENERATION_TWO, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }],
  ]);
  const names: string[] = [];
  const forwarded: { name: string; request: Request }[] = [];
  let connectResponse: Response = { status: 101 } as Response;
  const db = {
    prepare(sql: string) {
      let values: unknown[] = [];
      return {
        bind(...args: unknown[]) { values = args; return this; },
        first() { return sqlite.prepare(sql).get(...values as Parameters<ReturnType<DatabaseSync['prepare']>['get']>) ?? null; },
        run() { const result = sqlite.prepare(sql).run(...values as Parameters<ReturnType<DatabaseSync['prepare']>['run']>); return { meta: { changes: result.changes } }; },
      };
    },
  } as unknown as D1Database;
  const env = {
    DB: db,
    SSH_GATEWAY_SECRET: GATEWAY_SECRET,
    SSH_HOSTNAME: 'ssh.mainbrella.com',
    USER_CONTAINER: {
      idFromName(name: string) { names.push(name); return name; },
      get(name: string) { return { async fetch(request: Request) {
        forwarded.push({ name, request });
        if (new URL(request.url).pathname === '/ssh') return connectResponse;
        const userId = name.slice('user:'.length);
        const container = containers.get(userId);
        return Response.json({ containers: container ? [container] : [] });
      } }; },
    },
  } as unknown as Env;
  const browserRequest = (session = SESSION_ONE, origin: string | null = 'https://mainbrella.com') =>
    new Request('https://api.mainbrella.com/containers/ssh', {
      method: 'POST',
      headers: { ...(origin ? { Origin: origin } : {}), ...(session ? { Cookie: `mainbrella_session=${session}` } : {}) },
    });
  const gatewayRequest = (path: '/ssh/validate' | '/ssh/connect', token: string, secret = GATEWAY_SECRET) =>
    new Request(`https://api.mainbrella.com${path}`, {
      method: path === '/ssh/connect' ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        ...(path === '/ssh/connect' ? { Upgrade: 'websocket', 'x-mainbrella-ssh-token': token } : { 'Content-Type': 'application/json' }),
      },
      ...(path === '/ssh/validate' ? { body: JSON.stringify({ token }) } : {}),
    });
  async function issue(session = SESSION_ONE, origin: string | null = 'https://mainbrella.com') {
    return handleSSHRequest(browserRequest(session, origin), env);
  }
  async function issueToken(session = SESSION_ONE) {
    const response = await issue(session);
    assert.equal(response.status, 200);
    const body = await response.json() as { command: string; expiresAt: number; hostname: string };
    const token = body.command.match(/ ([a-f0-9]{64})@/)?.[1];
    assert.ok(token);
    return { token, body };
  }
  return { sqlite, env, names, forwarded, containers, browserRequest, gatewayRequest, issue, issueToken,
    setConnectResponse(value: Response) { connectResponse = value; } };
}

test('browser issuance requires a session and trusted Origin', async () => {
  const f = await fixture();
  assert.equal((await f.issue('', 'https://mainbrella.com')).status, 401);
  assert.equal((await f.issue(SESSION_ONE, null)).status, 403);
  assert.equal((await f.issue(SESSION_ONE, 'https://attacker.example')).status, 403);
  assert.equal(f.names.length, 0);
  assert.equal((f.sqlite.prepare('SELECT COUNT(*) AS count FROM ssh_access_tokens').get() as { count: number }).count, 0);
});

test('issued token is opaque, stored hashed, owned by browser user, and capped at 15 minutes or container expiry', async () => {
  const f = await fixture();
  const before = Date.now();
  const { token, body } = await f.issueToken();
  const after = Date.now();
  assert.equal(f.names.at(-1), `user:${USER_ONE}`);
  assert.ok(body.expiresAt >= before && body.expiresAt <= after + 15 * 60_000);
  assert.equal(body.hostname, 'ssh.mainbrella.com');
  const row = f.sqlite.prepare('SELECT * FROM ssh_access_tokens').get() as Record<string, unknown>;
  assert.equal(row.token_hash, await hashToken(token));
  assert.notEqual(row.token_hash, token);
  assert.equal(row.user_id, USER_ONE);
  assert.equal(row.container_created_at, GENERATION_ONE);
  assert.equal(row.expires_at, body.expiresAt);
  f.containers.set(USER_ONE, { createdAt: GENERATION_ONE, expiresAt: new Date(Date.now() + 90_000).toISOString() });
  const short = await f.issueToken();
  assert.ok(short.body.expiresAt <= Date.now() + 90_000);
});

test('gateway rejects missing or wrong Bearer secret, invalid token, expired token, and stale generation', async () => {
  const f = await fixture();
  const { token } = await f.issueToken();
  assert.equal((await handleSSHRequest(new Request('https://api.mainbrella.com/ssh/validate', {
    method: 'POST', body: JSON.stringify({ token }),
  }), f.env)).status, 401);
  assert.equal((await handleSSHRequest(f.gatewayRequest('/ssh/validate', token, 'wrong-secret-123456789012345678901234'), f.env)).status, 401);
  assert.equal((await handleSSHRequest(f.gatewayRequest('/ssh/validate', 'f'.repeat(64)), f.env)).status, 401);
  assert.equal((await handleSSHRequest(f.gatewayRequest('/ssh/validate', token), f.env)).status, 200);
  f.sqlite.prepare('UPDATE ssh_access_tokens SET expires_at = ?').run(Date.now() - 1);
  assert.equal((await handleSSHRequest(f.gatewayRequest('/ssh/validate', token), f.env)).status, 401);
  f.sqlite.prepare('UPDATE ssh_access_tokens SET expires_at = ?').run(Date.now() + 60_000);
  f.containers.set(USER_ONE, { createdAt: GENERATION_TWO, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  assert.equal((await handleSSHRequest(f.gatewayRequest('/ssh/validate', token), f.env)).status, 409);
  assert.equal((await handleSSHRequest(f.gatewayRequest('/ssh/connect', token), f.env)).status, 409);
  assert.equal(f.names.at(-1), `user:${USER_ONE}`);
});

test('connect forwards only trusted generation and expiry to the owning DO', async () => {
  const f = await fixture();
  const { token, body } = await f.issueToken(SESSION_TWO);
  const response = await handleSSHRequest(f.gatewayRequest('/ssh/connect', token), f.env);
  assert.equal(response.status, 101);
  assert.equal(f.names.at(-1), `user:${USER_TWO}`);
  const { request } = f.forwarded.at(-1)!;
  assert.equal(request.url, 'https://internal/ssh');
  assert.equal(request.method, 'GET');
  assert.equal(request.headers.get('upgrade'), 'websocket');
  assert.equal(request.headers.get('x-ssh-created-at'), GENERATION_TWO);
  assert.equal(request.headers.get('x-ssh-expires-at'), String(body.expiresAt));
  assert.equal(request.headers.get('Cookie'), null);
  assert.equal(request.headers.get('Authorization'), null);
  assert.equal(request.headers.get('x-mainbrella-ssh-token'), null);
  assert.deepEqual([...request.headers.keys()].sort(), ['upgrade', 'x-ssh-created-at', 'x-ssh-expires-at']);
  assert.equal((await handleSSHRequest(new Request(`https://api.mainbrella.com/ssh/connect?token=${token}`, {
    headers: { Authorization: `Bearer ${GATEWAY_SECRET}`, Upgrade: 'websocket', 'x-mainbrella-ssh-token': token },
  }), f.env)).status, 400);
});

test('per-user cap permits ten live tokens and isolates another user', async () => {
  const f = await fixture();
  for (let i = 0; i < 10; i++) await f.issueToken();
  assert.equal((await f.issue()).status, 429);
  assert.equal((await f.issue(SESSION_TWO)).status, 200);
  const rows = f.sqlite.prepare('SELECT user_id, COUNT(*) AS count FROM ssh_access_tokens GROUP BY user_id ORDER BY user_id').all() as { user_id: string; count: number }[];
  assert.deepEqual(rows.map(({ user_id, count }) => ({ user_id, count })),
    [{ user_id: USER_ONE, count: 10 }, { user_id: USER_TWO, count: 1 }]);
});
