import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleRequest } from './router';
import { paidContainerFixture, SESSION_ONE, SESSION_TWO, USER_ONE, USER_TWO } from './paid-container-test-helpers';

async function fixture(t: Parameters<typeof paidContainerFixture>[0]) {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  f.sqlite.exec(readFileSync(new URL('../../migrations/010_api_keys.sql', import.meta.url), 'utf8'));
  const names: string[] = [], calls: Request[] = [];
  const upgraded = Object.defineProperties(new Response(null), { status: { value: 101 }, webSocket: { value: {} } });
  const env = { ...f.env, ACTIVITY_WEBSOCKET_ENABLED: 'true', ACCOUNT_ACTIVITY: {
    idFromName(name: string) { names.push(name); return name; }, get() { return { async fetch(request: Request) { calls.push(request); return upgraded; } }; },
  } } as unknown as Env;
  return { ...f, env, names, calls, upgraded };
}
function request(headers: Record<string, string> = {}, suffix = '', method = 'GET') {
  return new Request('https://api.mainbrella.com/containers/activity' + suffix, { method,
    headers: { Upgrade: 'websocket', ...headers } });
}

test('activity authenticates account ownership, strips spoofed identities and preserves the upgrade', async t => {
  const f = await fixture(t);
  const response = await handleRequest(request({ Origin: 'https://mainbrella.com', Cookie: `mainbrella_session=${SESSION_ONE}`, 'x-mainbrella-user': 'victim' }), f.env);
  assert.equal(response.status, 101); assert.equal((response as any).webSocket, (f.upgraded as any).webSocket);
  assert.deepEqual(f.names, [`activity:${USER_ONE}`]);
  assert.deepEqual([...f.calls[0].headers.keys()].sort(), ['upgrade', 'x-mainbrella-user']);
  assert.equal(f.calls[0].headers.get('x-mainbrella-user'), USER_ONE);
  await handleRequest(request({ Origin: 'https://mainbrella.com', Cookie: `mainbrella_session=${SESSION_TWO}` }), f.env);
  assert.equal(f.names.at(-1), `activity:${USER_TWO}`);
  assert.equal(f.accountCalls.length, 0); assert.equal(f.machineCalls.length, 0);
});

test('native API key works without Origin; invalid or revoked Bearer never falls back to cookies', async t => {
  const f = await fixture(t);
  const created = await handleRequest(new Request('https://api.mainbrella.com/api-keys', { method: 'POST',
    headers: { Origin: 'https://mainbrella.com', Cookie: `mainbrella_session=${SESSION_ONE}` }, body: JSON.stringify({ name: 'Activity check' }) }), f.env);
  const { token, key } = await created.json() as any;
  assert.equal((await handleRequest(request({ Authorization: `Bearer ${token}` }), f.env)).status, 101);
  assert.equal((await handleRequest(request({ Authorization: 'Bearer invalid', Origin: 'https://mainbrella.com', Cookie: `mainbrella_session=${SESSION_ONE}` }), f.env)).status, 401);
  f.sqlite.prepare('DELETE FROM api_keys WHERE id = ?').run(key.id);
  assert.equal((await handleRequest(request({ Authorization: `Bearer ${token}` }), f.env)).status, 401);
});

test('activity requires cookie Origin, rejects URL tokens and mutations, and fails closed without configuration', async t => {
  const f = await fixture(t);
  assert.equal((await handleRequest(request({ Cookie: `mainbrella_session=${SESSION_ONE}` }), f.env)).status, 403);
  assert.equal((await handleRequest(request({ Origin: 'https://attacker.test', Cookie: `mainbrella_session=${SESSION_ONE}` }), f.env)).status, 403);
  assert.equal((await handleRequest(request({ Origin: 'https://mainbrella.com' }), f.env)).status, 401);
  for (const suffix of ['?token=secret', '?userId=other', '?cursor=0']) assert.equal((await handleRequest(request({}, suffix), f.env)).status, 400);
  assert.equal((await handleRequest(request({}, '', 'POST'), f.env)).status, 405);
  assert.equal((await handleRequest(request({ Origin: 'https://mainbrella.com', Cookie: `mainbrella_session=${SESSION_ONE}` }), { ...f.env, ACTIVITY_WEBSOCKET_ENABLED: 'false' } as unknown as Env)).status, 503);
  assert.equal(f.calls.length, 0);
});
