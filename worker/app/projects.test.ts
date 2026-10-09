import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleRequest } from './router';
import { paidContainerFixture, SESSION_ONE, SESSION_TWO, USER_ONE } from './paid-container-test-helpers';

function request(method = 'GET', session = SESSION_ONE, body?: unknown) {
  return new Request('https://api.mainbrella.com/projects', {
    method, headers: { Origin: 'https://mainbrella.com', Cookie: `mainbrella_session=${session}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function fixture(t: Parameters<typeof paidContainerFixture>[0]) {
  const f = await paidContainerFixture(t);
  f.sqlite.exec(readFileSync(new URL('../../migrations/014_projects.sql', import.meta.url), 'utf8'));
  t.after(() => f.close());
  return f;
}

test('projects persist names and are scoped to their session owner, including without a subscription', async t => {
  const { env, sqlite } = await fixture(t);
  sqlite.exec('DELETE FROM pro_billing');
  assert.deepEqual(await (await handleRequest(request(), env)).json(), { projects: [] });
  const response = await handleRequest(request('POST', SESSION_ONE, { name: '  First project  ', user_id: 'account-two' }), env);
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const { project } = await response.json() as any;
  assert.equal(project.name, 'First project');
  assert.match(project.id, /^[a-f0-9-]{36}$/);
  assert.equal((sqlite.prepare('SELECT user_id FROM projects WHERE id = ?').get(project.id) as any).user_id, USER_ONE);
  assert.deepEqual(await (await handleRequest(request(), env)).json(), { projects: [project] });
  assert.deepEqual(await (await handleRequest(request('GET', SESSION_TWO), env)).json(), { projects: [] });
  assert.equal((await handleRequest(request('POST', SESSION_TWO, { name: 'Second project' }), env)).status, 201);
  sqlite.prepare('DELETE FROM users WHERE id = ?').run(USER_ONE);
  assert.equal((sqlite.prepare('SELECT COUNT(*) AS count FROM projects WHERE user_id = ?').get(USER_ONE) as any).count, 0);
});

test('project routes validate names and require authenticated trusted browser requests', async t => {
  const { env } = await fixture(t);
  for (const body of [null, {}, { name: '' }, { name: ' ' }, { name: 1 }, { name: 'a'.repeat(81) }]) {
    assert.equal((await handleRequest(request('POST', SESSION_ONE, body), env)).status, 400);
  }
  assert.equal((await handleRequest(request('POST', SESSION_ONE, { name: 'a'.repeat(80) }), env)).status, 201);
  for (const Origin of [undefined, 'https://attacker.example']) {
    const headers: Record<string, string> = { Cookie: `mainbrella_session=${SESSION_ONE}` };
    if (Origin) headers.Origin = Origin;
    assert.equal((await handleRequest(new Request('https://api.mainbrella.com/projects', { method: 'POST', headers, body: '{"name":"test"}' }), env)).status, 403);
  }
  assert.equal((await handleRequest(request('GET', 'unknown'), env)).status, 401);
  assert.equal((await handleRequest(request('POST', 'unknown', { name: 'test' }), env)).status, 401);
  assert.equal((await handleRequest(request('DELETE'), env)).status, 405);
  const invalid = new Request('https://api.mainbrella.com/projects', { method: 'POST', headers: { Origin: 'https://mainbrella.com', Cookie: `mainbrella_session=${SESSION_ONE}` }, body: '{' });
  assert.equal((await handleRequest(invalid, env)).status, 400);
  const oversized = new Request('https://api.mainbrella.com/projects', { method: 'POST', headers: { Origin: 'https://mainbrella.com', Cookie: `mainbrella_session=${SESSION_ONE}` }, body: JSON.stringify({ name: 'test', extra: 'a'.repeat(1024) }) });
  assert.equal((await handleRequest(oversized, env)).status, 400);
  const preflight = await handleRequest(request('OPTIONS'), env);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://mainbrella.com');
});
