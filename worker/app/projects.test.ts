import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleRequest } from './router';
import { paidContainerFixture, SESSION_ONE, SESSION_TWO, USER_ONE, USER_TWO } from './paid-container-test-helpers';

function request(method = 'GET', session = SESSION_ONE, body?: unknown) {
  return new Request('https://api.mainbrella.com/projects', {
    method, headers: { Origin: 'https://mainbrella.com', Cookie: `mainbrella_session=${session}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function fixture(t: Parameters<typeof paidContainerFixture>[0], shared = true) {
  const f = await paidContainerFixture(t);
  for (const migration of ['014_projects.sql', '015_project_domain.sql', '016_project_domains.sql', '017_project_domain_provider.sql', '020_accounting_ledger.sql', '023_build.sql', '024_build_activity.sql',
    '025_build_images.sql', '026_build_ai_billing.sql', '027_build_model_effort.sql', '028_build_operations.sql',
    '029_remove_build_daily_limit.sql', '030_build_git.sql', '031_r2_billing.sql', '032_storage_retention.sql', ...(shared ? ['034_shared_projects.sql', '035_project_github.sql'] : [])])
    f.sqlite.exec(readFileSync(new URL(`../../migrations/${migration}`, import.meta.url), 'utf8'));
  f.env.DB.batch = (async (statements: D1PreparedStatement[]) => {
    f.sqlite.exec('BEGIN');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      f.sqlite.exec('COMMIT');
      return results;
    } catch (error) { f.sqlite.exec('ROLLBACK'); throw error; }
  }) as D1Database['batch'];
  t.after(() => f.close());
  return f;
}

test('projects persist names and domains and are scoped to their session owner, including without a subscription', async t => {
  const { env, sqlite } = await fixture(t);
  sqlite.exec('DELETE FROM pro_billing');
  assert.deepEqual(await (await handleRequest(request(), env)).json(), { projects: [] });
  const response = await handleRequest(request('POST', SESSION_ONE, { name: '  First project  ', domain: '  example.com  ', user_id: 'account-two' }), env);
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const { project } = await response.json() as any;
  assert.equal(project.name, 'First project');
  assert.equal(project.domain, 'example.com');
  assert.match(project.id, /^[a-f0-9-]{36}$/);
  assert.equal((sqlite.prepare('SELECT user_id FROM projects WHERE id = ?').get(project.id) as any).user_id, USER_ONE);
  assert.deepEqual(await (await handleRequest(request(), env)).json(), { projects: [project] });
  assert.equal((sqlite.prepare('SELECT domain FROM projects WHERE id = ?').get(project.id) as any).domain, 'example.com');
  assert.deepEqual(await (await handleRequest(request('GET', SESSION_TWO), env)).json(), { projects: [] });
  assert.equal((await handleRequest(request('POST', SESSION_TWO, { name: 'Second project' }), env)).status, 201);
  sqlite.prepare('DELETE FROM users WHERE id = ?').run(USER_ONE);
  assert.equal((sqlite.prepare('SELECT COUNT(*) AS count FROM projects WHERE user_id = ?').get(USER_ONE) as any).count, 0);
});

function insertApp(sqlite: Awaited<ReturnType<typeof fixture>>['sqlite'], userId = USER_ONE, name = 'Builder app') {
  const id = crypto.randomUUID(), now = new Date().toISOString();
  sqlite.prepare(`INSERT INTO build_apps(id,user_id,create_key,initial_prompt,name,source_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?)`).run(id, userId, id, 'Original brief', name, '{"src/App.tsx":"Saved source"}', now, now);
  return id;
}

function patchProject(id: string, body: unknown, session = SESSION_ONE) {
  return new Request(`https://api.mainbrella.com/projects?id=${id}`, { method: 'PATCH',
    headers: { Origin: 'https://mainbrella.com', Cookie: `mainbrella_session=${session}` }, body: JSON.stringify(body) });
}

test('shared migration backfills Builder identity without changing source, Git heads or existing projects', async t => {
  const f = await fixture(t, false);
  const manualId = crypto.randomUUID();
  f.sqlite.prepare('INSERT INTO projects(id,user_id,name,domain,created_at) VALUES(?,?,?,?,?)')
    .run(manualId, USER_ONE, 'Manual project', 'example.com', '2024-01-01T00:00:00.000Z');
  const appId = insertApp(f.sqlite);
  f.sqlite.prepare('UPDATE build_apps SET git_version_id=?,verified_git_version_id=? WHERE id=?').run('saved-head', 'verified-head', appId);
  const before = f.sqlite.prepare('SELECT * FROM build_apps WHERE id=?').get(appId)!;
  f.sqlite.exec(readFileSync(new URL('../../migrations/034_shared_projects.sql', import.meta.url), 'utf8'));
  const after = f.sqlite.prepare('SELECT * FROM build_apps WHERE id=?').get(appId)!;
  assert.deepEqual({ ...after }, { ...before, project_id: appId });
  f.sqlite.exec(readFileSync(new URL('../../migrations/035_project_github.sql', import.meta.url), 'utf8'));
  const { projects } = await (await handleRequest(request(), f.env)).json() as any;
  assert.equal(projects.length, 2);
  assert.deepEqual(projects.find((project: any) => project.id === appId), {
    id: appId, name: before.name, domain: null, created_at: before.created_at, build_app_id: appId, git_version_id: 'saved-head', github_repo: null, github_branch: null, github_commit_id: null,
  });
  assert.equal(projects.find((project: any) => project.id === manualId).domain, 'example.com');
});

test('new Builder workspaces appear once in Projects, sync both rename paths and cascade deletion', async t => {
  const f = await fixture(t);
  const appId = insertApp(f.sqlite);
  insertApp(f.sqlite, USER_TWO, 'Other owner');
  const listing = await (await handleRequest(request(), f.env)).json() as any;
  assert.equal(listing.projects.length, 1);
  assert.equal(listing.projects[0].build_app_id, appId);
  await handleRequest(patchProject(appId, { name: 'From Projects', domain: 'app.example.com' }), f.env);
  assert.equal(f.sqlite.prepare('SELECT name FROM build_apps WHERE id=?').get(appId)!.name, 'From Projects');
  const renamed = await handleRequest(new Request(`https://api.mainbrella.com/build/apps/${appId}`, { method: 'PATCH',
    headers: { Origin: 'https://mainbrella.com', Cookie: `mainbrella_session=${SESSION_ONE}` }, body: JSON.stringify({ name: 'From Builder' }) }), f.env);
  assert.equal(renamed.status, 200);
  const project = f.sqlite.prepare('SELECT name,domain FROM projects WHERE id=?').get(appId)!;
  assert.equal(project.name, 'From Builder');
  assert.equal(project.domain, 'app.example.com');
  assert.equal((await handleRequest(patchProject(appId, { name: 'Hijack', git: true }, SESSION_TWO), f.env)).status, 404);
  f.sqlite.prepare('DELETE FROM build_apps WHERE id=?').run(appId);
  assert.equal(f.sqlite.prepare('SELECT id FROM projects WHERE id=?').get(appId), undefined);
  const another = insertApp(f.sqlite);
  f.sqlite.prepare('DELETE FROM projects WHERE id=?').run(another);
  assert.equal(f.sqlite.prepare('SELECT id FROM build_apps WHERE id=?').get(another), undefined);
});

test('Git is optional and can be enabled once on a project without a build, subscription or storage writes', async t => {
  const f = await fixture(t);
  f.sqlite.exec('DELETE FROM pro_billing');
  const plain = await (await handleRequest(request('POST', SESSION_ONE, { name: 'Plain project' }), f.env)).json() as any;
  assert.equal(plain.project.build_app_id, null);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS count FROM build_apps').get()!.count, 0);
  const created = await handleRequest(request('POST', SESSION_ONE, { name: 'With Git', git: true }), f.env);
  assert.equal(created.status, 201);
  const { project } = await created.json() as any;
  assert.equal(project.build_app_id, project.id);
  assert.equal(project.git_version_id, null);
  assert.equal(f.sqlite.prepare('SELECT active_turn_id,source_json FROM build_apps WHERE id=?').get(project.id)!.active_turn_id, null);
  for (const git of [true, true, false]) {
    const response = await handleRequest(patchProject(plain.project.id, { name: 'Enabled later', git }), f.env);
    assert.equal(response.status, 200);
    assert.equal((await response.json() as any).project.build_app_id, plain.project.id);
  }
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS count FROM build_apps').get()!.count, 2);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS count FROM build_turns').get()!.count, 0);
  assert.equal(f.accountCalls.length, 0);
  assert.equal(f.machineCalls.length, 0);
  const versions = await handleRequest(new Request(`https://api.mainbrella.com/build/apps/${project.id}/versions`, {
    headers: { Origin: 'https://mainbrella.com', Cookie: `mainbrella_session=${SESSION_ONE}` } }), f.env);
  assert.equal(versions.status, 200);
  assert.deepEqual(await versions.json(), { versions: [], versionId: null, verifiedVersionId: null });
  assert.throws(() => f.sqlite.prepare(`INSERT INTO build_apps(id,project_id,user_id,create_key,initial_prompt,name,source_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(crypto.randomUUID(), plain.project.id, USER_TWO, 'foreign', '', 'Foreign', '{}', 'now', 'now'), /project_identity_conflict/);
  for (const git of ['true', 1, null, {}])
    assert.equal((await handleRequest(request('POST', SESSION_ONE, { name: 'Invalid Git', git }), f.env)).status, 400);
});

test('workspace limit rolls back project creation and edits while plain projects remain available', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 50; index++) insertApp(f.sqlite);
  assert.equal((await handleRequest(request('POST', SESSION_ONE, { name: 'Too many', git: true }), f.env)).status, 429);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS count FROM projects').get()!.count, 50);
  const { project } = await (await handleRequest(request('POST', SESSION_ONE, { name: 'Plain still works' }), f.env)).json() as any;
  assert.equal((await handleRequest(patchProject(project.id, { name: 'Unsaved rename', git: true }), f.env)).status, 429);
  assert.equal(f.sqlite.prepare('SELECT name FROM projects WHERE id=?').get(project.id)!.name, 'Plain still works');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS count FROM build_apps').get()!.count, 50);
});

test('Builder deletion preserves hosted projects until endpoints, cleanup journals and domains are removed', async t => {
  const f = await fixture(t);
  f.sqlite.exec(readFileSync(new URL('../../preview-migrations/002_project_endpoints.sql', import.meta.url), 'utf8'));
  f.env.PREVIEW_ROUTES = f.env.DB;
  const appId = insertApp(f.sqlite);
  const deleting = () => handleRequest(new Request(`https://api.mainbrella.com/build/apps/${appId}`, { method: 'DELETE',
    headers: { Origin: 'https://mainbrella.com', Cookie: `mainbrella_session=${SESSION_ONE}` } }), f.env);
  f.sqlite.prepare('INSERT INTO project_endpoints(project_id,user_id,target_json,container_name,created_at,revision,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run(appId, USER_ONE, '{}', 'container', 'now', 'revision', 'now');
  let response = await deleting();
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'project_hosting_in_use' });
  assert.ok(f.sqlite.prepare('SELECT id FROM build_apps WHERE id=?').get(appId));
  f.sqlite.prepare('DELETE FROM project_endpoints WHERE project_id=?').run(appId);
  f.sqlite.prepare('INSERT INTO project_binding_operations(revision,project_id,user_id,route_json,updated_at) VALUES(?,?,?,?,?)')
    .run('revision', appId, USER_ONE, '{}', 'now');
  assert.equal((await deleting()).status, 409);
  f.sqlite.prepare('DELETE FROM project_binding_operations WHERE project_id=?').run(appId);
  f.sqlite.prepare('INSERT INTO project_domains(id,project_id,hostname,challenge,created_at) VALUES(?,?,?,?,?)')
    .run('domain', appId, 'example.com', 'challenge', 'now');
  assert.equal((await deleting()).status, 409);
  f.sqlite.prepare('DELETE FROM project_domains WHERE project_id=?').run(appId);
  response = await deleting();
  assert.equal(response.status, 200);
  assert.equal(f.sqlite.prepare('SELECT id FROM projects WHERE id=?').get(appId), undefined);
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

test('project domains default to null, trim, clear, preserve when omitted, and enforce the trimmed length', async t => {
  const { env, sqlite } = await fixture(t);
  const omitted = await (await handleRequest(request('POST', SESSION_ONE, { name: 'Omitted domain' }), env)).json() as any;
  assert.equal(omitted.project.domain, null);
  const blank = await (await handleRequest(request('POST', SESSION_ONE, { name: 'Blank domain', domain: '   ' }), env)).json() as any;
  assert.equal(blank.project.domain, null);
  const spaced = await (await handleRequest(request('POST', SESSION_ONE, { name: 'Trim domain', domain: ` ${'a'.repeat(253)} ` }), env)).json() as any;
  assert.equal(spaced.project.domain, 'a'.repeat(253));

  const update = (id: string, body: unknown) => new Request(`https://api.mainbrella.com/projects?id=${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: { Origin: 'https://mainbrella.com', Cookie: `mainbrella_session=${SESSION_ONE}` }, body: JSON.stringify(body),
  });
  const created = await (await handleRequest(request('POST', SESSION_ONE, { name: 'Preserve domain', domain: 'original.example' }), env)).json() as any;
  const preserved = await (await handleRequest(update(created.project.id, { name: 'Renamed' }), env)).json() as any;
  assert.equal(preserved.project.domain, 'original.example');
  const changed = await (await handleRequest(update(created.project.id, { name: 'Renamed', domain: '  changed.example  ' }), env)).json() as any;
  assert.equal(changed.project.domain, 'changed.example');
  const clearedByNull = await (await handleRequest(update(created.project.id, { name: 'Renamed', domain: null }), env)).json() as any;
  assert.equal(clearedByNull.project.domain, null);
  await handleRequest(update(created.project.id, { name: 'Renamed', domain: 'again.example' }), env);
  const clearedByBlank = await (await handleRequest(update(created.project.id, { name: 'Renamed', domain: '  ' }), env)).json() as any;
  assert.equal(clearedByBlank.project.domain, null);
  assert.equal((sqlite.prepare('SELECT domain FROM projects WHERE id = ?').get(created.project.id) as any).domain, null);

  for (const domain of [1, false, {}, [], 'a'.repeat(254)]) {
    assert.equal((await handleRequest(request('POST', SESSION_ONE, { name: 'Invalid', domain }), env)).status, 400, `POST ${String(domain)}`);
    assert.equal((await handleRequest(update(created.project.id, { name: 'Invalid', domain }), env)).status, 400, `PATCH ${String(domain)}`);
  }
  assert.equal((await handleRequest(request('POST', SESSION_TWO, { name: 'Other user', domain: 'other.example' }), env)).status, 201);
  assert.equal((await handleRequest(update(created.project.id, { name: 'Renamed', domain: 'owner.example' }), env)).status, 200);
  const otherOwnerUpdate = await handleRequest(new Request(`https://api.mainbrella.com/projects?id=${created.project.id}`, {
    method: 'PATCH', headers: { Origin: 'https://mainbrella.com', Cookie: `mainbrella_session=${SESSION_TWO}` }, body: JSON.stringify({ name: 'Hijack', domain: 'other.example' }),
  }), env);
  assert.equal(otherOwnerUpdate.status, 404);
  assert.equal((sqlite.prepare('SELECT domain FROM projects WHERE id = ?').get(created.project.id) as any).domain, 'owner.example');
});

test('project domain migration preserves existing rows with a null domain', async t => {
  const f = await paidContainerFixture(t);
  f.sqlite.exec(readFileSync(new URL('../../migrations/014_projects.sql', import.meta.url), 'utf8'));
  f.sqlite.prepare('INSERT INTO projects (id, user_id, name, created_at) VALUES (?, ?, ?, ?)')
    .run('legacy-project', USER_ONE, 'Legacy project', '2024-01-01T00:00:00.000Z');
  f.sqlite.exec(readFileSync(new URL('../../migrations/015_project_domain.sql', import.meta.url), 'utf8'));
  const legacy = f.sqlite.prepare('SELECT id, user_id, name, domain, created_at FROM projects WHERE id = ?').get('legacy-project') as any;
  assert.deepEqual({ ...legacy }, {
    id: 'legacy-project', user_id: USER_ONE, name: 'Legacy project', domain: null, created_at: '2024-01-01T00:00:00.000Z',
  });
  assert.throws(() => f.sqlite.prepare('UPDATE projects SET domain = ? WHERE id = ?').run('a'.repeat(254), 'legacy-project'));
  t.after(() => f.close());
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
  assert.equal(Object.keys(project).sort().join(','), 'build_app_id,created_at,domain,git_version_id,github_branch,github_commit_id,github_repo,id,name');

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
