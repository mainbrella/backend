import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleRequest } from './router';
import { containerUser } from './container-auth';
import { hashToken } from './auth-core';
import { paidContainerFixture, SESSION_ONE, SESSION_TWO, USER_ONE, USER_TWO } from './paid-container-test-helpers';

const origin = 'https://mainbrella.com';
function request(method = 'GET', session = SESSION_ONE, body?: unknown, suffix = '') {
  return new Request(`https://api.mainbrella.com/api-keys${suffix}`, {
    method, headers: { Origin: origin, Cookie: `mainbrella_session=${session}`, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
async function fixture(t: Parameters<typeof paidContainerFixture>[0]) {
  const f = await paidContainerFixture(t);
  f.sqlite.exec(readFileSync(new URL('../../migrations/010_api_keys.sql', import.meta.url), 'utf8'));
  t.after(() => f.close());
  return f;
}

test('keys are shown once, stored as hashes, scoped to their owner, and revoked immediately', async t => {
  const { env, sqlite } = await fixture(t);
  const created = await handleRequest(request('POST', SESSION_ONE, { name: '  Deploy script  ' }), env);
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('cache-control'), 'no-store');
  const { key, token } = await created.json() as any;
  assert.match(token, /^mb_[a-f0-9]{64}$/);
  assert.equal(key.name, 'Deploy script');
  const stored = sqlite.prepare('SELECT * FROM api_keys WHERE id = ?').get(key.id) as any;
  assert.equal(stored.token_hash, await hashToken(token));
  assert.ok(!JSON.stringify(stored).includes(token));
  const bearer = () => new Request('https://api.mainbrella.com/containers', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal((await containerUser(env, bearer()))?.id, USER_ONE);
  assert.ok((sqlite.prepare('SELECT last_used_at FROM api_keys WHERE id = ?').get(key.id) as any).last_used_at);
  const listed = await handleRequest(request(), env);
  assert.equal((await listed.json() as any).keys.length, 1);
  assert.ok(!(await (await handleRequest(request(), env)).text()).includes(token));
  assert.deepEqual(await (await handleRequest(request('GET', SESSION_TWO), env)).json(), { keys: [] });
  assert.equal((await handleRequest(request('DELETE', SESSION_TWO, undefined, `?id=${key.id}`), env)).status, 404);
  // A real lifecycle request resolves the key owner's existing paid account.
  assert.equal((await handleRequest(bearer(), env)).status, 200);
  // Browser logout is independent of this automation credential.
  await handleRequest(new Request('https://api.mainbrella.com/auth/logout', { method: 'POST', headers: { Origin: origin, Cookie: `mainbrella_session=${SESSION_ONE}` } }), env);
  assert.equal((await containerUser(env, bearer()))?.id, USER_ONE);
  // Use the second session as the first owner to revoke after logout.
  sqlite.prepare('UPDATE sessions SET user_id = ? WHERE token_hash = ?').run(USER_ONE, await hashToken(SESSION_TWO));
  assert.equal((await handleRequest(request('DELETE', SESSION_TWO, undefined, `?id=${key.id}`), env)).status, 200);
  assert.equal(await containerUser(env, bearer()), null);
});

test('key management requires browser auth and trusted mutation origins; invalid Bearer never falls back', async t => {
  const { env } = await fixture(t);
  assert.equal((await handleRequest(request('GET', 'unknown'), env)).status, 401);
  for (const Origin of [undefined, 'https://attacker.example']) {
    const headers: Record<string, string> = { Cookie: `mainbrella_session=${SESSION_ONE}` };
    if (Origin) headers.Origin = Origin;
    const res = await handleRequest(new Request('https://api.mainbrella.com/api-keys', { method: 'POST', headers, body: '{"name":"test"}' }), env);
    assert.equal(res.status, 403);
  }
  const { token } = await (await handleRequest(request('POST', SESSION_ONE, { name: 'test' }), env)).json() as any;
  assert.equal((await handleRequest(new Request('https://api.mainbrella.com/api-keys', { headers: { Authorization: `Bearer ${token}` } }), env)).status, 401);
  assert.equal(await containerUser(env, new Request('https://api.mainbrella.com/containers', { headers: { Authorization: `Bearer mb_${'0'.repeat(64)}`, Cookie: `mainbrella_session=${SESSION_TWO}` } })), null);
  assert.equal((await containerUser(env, new Request('https://api.mainbrella.com/containers', { headers: { Cookie: `mainbrella_session=${SESSION_TWO}` } })))?.id, USER_TWO);
});

test('validates names and enforces the per-account key limit without affecting other accounts', async t => {
  const { env } = await fixture(t);
  for (const body of [null, {}, { name: '' }, { name: ' ' }, { name: 1 }, { name: 'a'.repeat(81) }]) {
    assert.equal((await handleRequest(request('POST', SESSION_ONE, body), env)).status, 400);
  }
  const invalid = new Request('https://api.mainbrella.com/api-keys', { method: 'POST', headers: { Origin: origin, Cookie: `mainbrella_session=${SESSION_ONE}` }, body: '{' });
  assert.equal((await handleRequest(invalid, env)).status, 400);
  for (let i = 0; i < 20; i++) assert.equal((await handleRequest(request('POST', SESSION_ONE, { name: `key-${i}` }), env)).status, 201);
  assert.equal((await handleRequest(request('POST', SESSION_ONE, { name: 'extra' }), env)).status, 429);
  assert.equal((await handleRequest(request('POST', SESSION_TWO, { name: 'other owner' }), env)).status, 201);
});
