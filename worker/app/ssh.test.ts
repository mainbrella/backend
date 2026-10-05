import test from 'node:test';
import assert from 'node:assert/strict';
import { handleSSHRequest } from './ssh';
import { hashToken } from './auth-core';
import {
  EXPIRES_AT, GENERATION_ONE, GENERATION_TWO, paidContainerFixture,
  SESSION_ONE, SESSION_TWO, USER_ONE, USER_TWO,
} from './paid-container-test-helpers';

const GATEWAY_SECRET = 'gateway-secret-for-tests-12345678901234567890';

function requests() {
  const browserRequest = (session = SESSION_ONE, origin: string | null = 'https://mainbrella.com', body = '') =>
    new Request('https://api.mainbrella.com/containers/ssh', {
      method: 'POST', headers: { ...(origin ? { Origin: origin } : {}), ...(session ? { Cookie: `mainbrella_session=${session}` } : {}) },
      ...(body ? { body } : {}),
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
  return { browserRequest, gatewayRequest };
}

async function issueToken(f: Awaited<ReturnType<typeof paidContainerFixture>>, body = '', session = SESSION_ONE) {
  const { browserRequest } = requests();
  const response = await handleSSHRequest(browserRequest(session, 'https://mainbrella.com', body), f.env);
  assert.equal(response.status, 200);
  const result = await response.json() as { command: string; expiresAt: number; hostname: string };
  const token = result.command.match(/ ([a-f0-9]{64})@/)?.[1];
  assert.ok(token);
  return { token, body: result };
}

test('browser issuance requires a session and trusted Origin', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  const { browserRequest } = requests();
  assert.equal((await handleSSHRequest(browserRequest('', 'https://mainbrella.com'), f.env)).status, 401);
  assert.equal((await handleSSHRequest(browserRequest(SESSION_ONE, null), f.env)).status, 403);
  assert.equal((await handleSSHRequest(browserRequest(SESSION_ONE, 'https://attacker.example'), f.env)).status, 403);
  assert.equal(f.accountNames.length, 0);
  assert.equal((f.sqlite.prepare('SELECT COUNT(*) AS count FROM ssh_access_tokens').get() as { count: number }).count, 0);
});

test('issued token is opaque, stored hashed with its container ID, and capped at 15 minutes or expiry', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  const before = Date.now();
  const { token, body } = await issueToken(f);
  const after = Date.now();
  assert.equal(f.machineNames.at(-1), `user:${USER_ONE}`);
  assert.ok(body.expiresAt >= before && body.expiresAt <= after + 15 * 60_000);
  assert.equal(body.hostname, 'ssh.mainbrella.com');
  const row = f.sqlite.prepare('SELECT * FROM ssh_access_tokens').get() as Record<string, unknown>;
  assert.equal(row.token_hash, await hashToken(token));
  assert.notEqual(row.token_hash, token);
  assert.equal(row.user_id, USER_ONE);
  assert.equal(row.container_created_at, GENERATION_ONE);
  assert.equal(row.container_id, 'small');
  assert.equal(row.expires_at, body.expiresAt);
});

test('multiple containers require an owned ID and gateway rechecks that exact generation', async t => {
  const f = await paidContainerFixture(t, { [USER_ONE]: [
    { id: 'small', createdAt: GENERATION_ONE, expiresAt: EXPIRES_AT },
    { id: 'c1', createdAt: GENERATION_TWO, expiresAt: EXPIRES_AT },
  ] }); t.after(() => f.close());
  const { browserRequest, gatewayRequest } = requests();
  const missing = await handleSSHRequest(browserRequest(), f.env);
  assert.equal(missing.status, 400);
  assert.deepEqual(await missing.json(), { error: 'container_id_required' });
  assert.equal((await handleSSHRequest(browserRequest(SESSION_ONE, 'https://mainbrella.com', JSON.stringify({ id: 'victim' })), f.env)).status, 400);
  assert.equal((await handleSSHRequest(browserRequest(SESSION_TWO, 'https://mainbrella.com', JSON.stringify({ id: 'c1' })), f.env)).status, 409);
  assert.equal(f.accountNames.at(-1), `account:${USER_TWO}`);
  const { token, body } = await issueToken(f, JSON.stringify({ id: 'c1' }));
  assert.equal(f.machineNames.at(-1), `user:${USER_ONE}:slot:1`);
  const row = f.sqlite.prepare('SELECT container_id, container_created_at FROM ssh_access_tokens').get() as Record<string, unknown>;
  assert.equal(row.container_id, 'c1');
  assert.equal(row.container_created_at, GENERATION_TWO);
  assert.equal((await handleSSHRequest(gatewayRequest('/ssh/validate', token), f.env)).status, 200);
  assert.equal(await (await handleSSHRequest(gatewayRequest('/ssh/connect', token), f.env)).status, 101);
  assert.equal(f.machineNames.at(-1), `user:${USER_ONE}:slot:1`);
  const forwarded = f.machineCalls.at(-1)!.request;
  assert.equal(forwarded.url, 'https://internal/ssh');
  assert.equal(forwarded.headers.get('x-ssh-created-at'), GENERATION_TWO);
  assert.equal(forwarded.headers.get('x-ssh-expires-at'), String(body.expiresAt));
  assert.equal(forwarded.headers.get('Cookie'), null);
  assert.equal(forwarded.headers.get('Authorization'), null);
  assert.equal(forwarded.headers.get('x-mainbrella-ssh-token'), null);
});

test('gateway rejects missing or wrong Bearer secret, invalid and expired tokens, and stale generations', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  const { gatewayRequest } = requests();
  const { token } = await issueToken(f);
  assert.equal((await handleSSHRequest(new Request('https://api.mainbrella.com/ssh/validate', { method: 'POST', body: JSON.stringify({ token }) }), f.env)).status, 401);
  assert.equal((await handleSSHRequest(gatewayRequest('/ssh/validate', token, 'wrong-secret-123456789012345678901234'), f.env)).status, 401);
  assert.equal((await handleSSHRequest(gatewayRequest('/ssh/validate', 'f'.repeat(64)), f.env)).status, 401);
  assert.equal((await handleSSHRequest(gatewayRequest('/ssh/validate', token), f.env)).status, 200);
  f.sqlite.prepare('UPDATE ssh_access_tokens SET expires_at = ?').run(Date.now() - 1);
  assert.equal((await handleSSHRequest(gatewayRequest('/ssh/validate', token), f.env)).status, 401);
  f.sqlite.prepare('UPDATE ssh_access_tokens SET expires_at = ?').run(Date.now() + 60_000);
  f.containers.set(USER_ONE, [{ id: 'small', createdAt: GENERATION_TWO, expiresAt: EXPIRES_AT }]);
  assert.equal((await handleSSHRequest(gatewayRequest('/ssh/validate', token), f.env)).status, 409);
  assert.equal((await handleSSHRequest(gatewayRequest('/ssh/connect', token), f.env)).status, 409);
  assert.equal(f.machineNames.at(-1), `user:${USER_ONE}`);
  assert.equal((await handleSSHRequest(new Request(`https://api.mainbrella.com/ssh/connect?token=${token}`, {
    headers: { Authorization: `Bearer ${GATEWAY_SECRET}`, Upgrade: 'websocket', 'x-mainbrella-ssh-token': token },
  }), f.env)).status, 400);
});

test('connect forwards only trusted generation and expiry to the owning machine', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  const { gatewayRequest } = requests();
  const { token, body } = await issueToken(f, '', SESSION_TWO);
  const response = await handleSSHRequest(gatewayRequest('/ssh/connect', token), f.env);
  assert.equal(response.status, 101);
  assert.equal(f.machineNames.at(-1), `user:${USER_TWO}`);
  const forwarded = f.machineCalls.at(-1)!.request;
  assert.equal(forwarded.method, 'GET');
  assert.equal(forwarded.headers.get('upgrade'), 'websocket');
  assert.equal(forwarded.headers.get('x-ssh-created-at'), GENERATION_TWO);
  assert.equal(forwarded.headers.get('x-ssh-expires-at'), String(body.expiresAt));
  assert.deepEqual([...forwarded.headers.keys()].sort(), ['upgrade', 'x-ssh-created-at', 'x-ssh-expires-at']);
});

test('per-user cap permits ten live tokens and isolates another user', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  for (let index = 0; index < 10; index++) await issueToken(f);
  const { browserRequest } = requests();
  assert.equal((await handleSSHRequest(browserRequest(), f.env)).status, 429);
  assert.equal((await handleSSHRequest(browserRequest(SESSION_TWO), f.env)).status, 200);
  const rows = f.sqlite.prepare('SELECT user_id, COUNT(*) AS count FROM ssh_access_tokens GROUP BY user_id ORDER BY user_id').all() as { user_id: string; count: number }[];
  assert.deepEqual(rows.map(({ user_id, count }) => ({ user_id, count })),
    [{ user_id: USER_ONE, count: 10 }, { user_id: USER_TWO, count: 1 }]);
});

test('automation SSH issuance uses the same session owner, expiration and revocation', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  const token = 'a'.repeat(64);
  f.sqlite.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(await hashToken(token), USER_TWO, '2099-01-01T00:00:00.000Z');
  const req = () => new Request('https://api.mainbrella.com/containers/ssh', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, Cookie: `mainbrella_session=${SESSION_ONE}` },
  });
  const issued = await handleSSHRequest(req(), f.env);
  assert.equal(issued.status, 200);
  assert.equal(f.machineNames.at(-1), `user:${USER_TWO}`);
  f.sqlite.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?')
    .run('2000-01-01T00:00:00.000Z', await hashToken(token));
  assert.equal((await handleSSHRequest(req(), f.env)).status, 401);
  f.sqlite.prepare('DELETE FROM sessions WHERE token_hash = ?').run(await hashToken(token));
  assert.equal((await handleSSHRequest(req(), f.env)).status, 401);
  assert.equal(f.machineCalls.length, 0);
});

test('existing SSH tokens are clamped to a shortened container lease', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  const { gatewayRequest } = requests();
  const { token } = await issueToken(f);
  const shortened = Date.now() + 30_000;
  f.containers.set(USER_ONE, [{ id: 'small', status: 'running', createdAt: GENERATION_ONE, expiresAt: new Date(shortened).toISOString() }]);
  const validated = await handleSSHRequest(gatewayRequest('/ssh/validate', token), f.env);
  assert.equal(validated.status, 200);
  assert.deepEqual(await validated.json(), { expiresAt: shortened });
  assert.equal((await handleSSHRequest(gatewayRequest('/ssh/connect', token), f.env)).status, 101);
  assert.equal(f.machineCalls.at(-1)!.request.headers.get('x-ssh-expires-at'), String(shortened));
});
