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

test('projects can be renamed by their owner while preserving identity and creation time', async t => {
  const { env, sqlite } = await fixture(t);
  const created = await (await handleRequest(request('POST', SESSION_ONE, { name: 'Original' }), env)).json() as any;
  const before = created.project;
  const update = (id: string, body: unknown, session = SESSION_ONE) => new Request(`https://api.mainbrella.com/projects?id=${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: { Origin: 'https://mainbrella.com', Cookie: `mainbrella_session=${session}` }, body: JSON.stringify(body),
  });

  const response = await handleRequest(update(before.id, { name: '  Renamed  ', id: 'replacement', user_id: 'account-two' }), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const { project } = await response.json() as any;
  assert.deepEqual(project, { ...before, name: 'Renamed' });
  const stored = sqlite.prepare('SELECT id, user_id, name, created_at FROM projects WHERE id = ?').get(before.id) as any;
  assert.equal(stored.id, before.id);
  assert.equal(stored.user_id, USER_ONE);
  assert.equal(stored.name, 'Renamed');
  assert.equal(stored.created_at, before.created_at);
  assert.equal(Object.keys(project).sort().join(','), 'created_at,id,name');

  assert.equal((await handleRequest(update(before.id, { name: 'Other owner' }, SESSION_TWO), env)).status, 404);
  assert.equal((await handleRequest(update('4e3cb127-784d-4a9f-9828-afd093c295dc', { name: 'Missing' }), env)).status, 404);
});

test('project updates validate id, body, authentication, and trusted Origin', async t => {
  const { env } = await fixture(t);
  const created = await (await handleRequest(request('POST', SESSION_ONE, { name: 'Original' }), env)).json() as any;
  const url = `https://api.mainbrella.com/projects?id=${created.project.id}`;
  const patch = (target: string, headers: Record<string, string>, body = '{"name":"Valid"}') =>
    new Request(target, { method: 'PATCH', headers, body });
  const trusted = { Origin: 'https://mainbrella.com', Cookie: `mainbrella_session=${SESSION_ONE}` };

  for (const target of [
    'https://api.mainbrella.com/projects',
    'https://api.mainbrella.com/projects?id=',
    'https://api.mainbrella.com/projects?id=bad',
    `${url}&id=${created.project.id}`,
  ]) assert.equal((await handleRequest(patch(target, trusted), env)).status, 400, target);
  for (const body of ['{', '{}', '{"name":""}', '{"name":" "}', '{"name":1}', JSON.stringify({ name: 'a'.repeat(81) }), JSON.stringify({ name: 'x', extra: 'a'.repeat(1024) })]) {
    assert.equal((await handleRequest(patch(url, trusted, body), env)).status, 400, body.slice(0, 40));
  }
  assert.equal((await handleRequest(patch(url, { Cookie: trusted.Cookie }), env)).status, 403);
  assert.equal((await handleRequest(patch(url, { ...trusted, Origin: 'https://attacker.example' }), env)).status, 403);
  assert.equal((await handleRequest(patch(url, { Origin: 'https://mainbrella.com', Cookie: 'mainbrella_session=unknown' }), env)).status, 401);
});
