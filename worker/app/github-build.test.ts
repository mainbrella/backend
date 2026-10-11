import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleRequest } from './router';
import { paidContainerFixture, SESSION_ONE, SESSION_TWO, USER_ONE, USER_TWO } from './paid-container-test-helpers';
import { githubBuildAPI, githubBuildUserToken, sealGithubBuildCredentials } from '../lib/github-build';
import { githubUserToken, sealGithubCredentials } from '../lib/github-import';

const api = (path: string, method = 'GET', body?: unknown, session = SESSION_ONE, origin: string | null = 'https://mainbrella.com') => new Request(`https://api.mainbrella.com${path}`, {
  method, headers: { Cookie: `mainbrella_session=${session}`, ...(origin ? { Origin: origin } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}) });
async function fixture(t: TestContext) {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  f.sqlite.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT, created_at TEXT);
    CREATE TABLE build_apps (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, project_id TEXT);
    CREATE TABLE build_turns (id TEXT PRIMARY KEY, app_id TEXT NOT NULL);`);
  f.sqlite.prepare('INSERT INTO projects (id, user_id, name, created_at) VALUES (?, ?, ?, ?)').run('11111111-1111-4111-8111-111111111111', USER_ONE, 'One', new Date().toISOString());
  f.sqlite.prepare('INSERT INTO projects (id, user_id, name, created_at) VALUES (?, ?, ?, ?)').run('22222222-2222-4222-8222-222222222222', USER_TWO, 'Two', new Date().toISOString());
  f.sqlite.exec(readFileSync(new URL('../../migrations/028_github_import.sql', import.meta.url), 'utf8'));
  f.sqlite.exec(readFileSync(new URL('../../migrations/035_project_github.sql', import.meta.url), 'utf8'));
  Object.assign(f.env, { GITHUB_BUILD_CLIENT_ID: 'build-client', GITHUB_BUILD_CLIENT_SECRET: 'build-secret',
    GITHUB_BUILD_APP_SLUG: 'mainbrella-build', GITHUB_BUILD_ENCRYPTION_KEY: 'b'.repeat(64),
    GITHUB_IMPORT_CLIENT_ID: 'import-client', GITHUB_IMPORT_CLIENT_SECRET: 'import-secret',
    GITHUB_IMPORT_APP_SLUG: 'mainbrella-import', GITHUB_IMPORT_ENCRYPTION_KEY: 'a'.repeat(64) });
  const calls: { url: string; init?: RequestInit }[] = [];
  let failRefresh = false;
  const githubPages = new Map<string, unknown>();
  const delegate = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('github.com')) {
      calls.push({ url, init });
      const parsed = new URL(url);
      if (githubPages.has(parsed.pathname + parsed.search)) return Response.json(githubPages.get(parsed.pathname + parsed.search));
      if (url.endsWith('/user')) return Response.json({ id: 456, login: 'build-user' });
      if (url.endsWith('/access_token')) {
        if (failRefresh && String(init?.body).includes('grant_type=refresh_token')) throw new Error('connection reset after request');
        return Response.json({ access_token: 'ghu_build-token', refresh_token: 'ghr_build-token', expires_in: 28800 });
      }
    }
    return delegate(input, init);
  });
  const start = async (projectId = '11111111-1111-4111-8111-111111111111', session = SESSION_ONE,
    returnTo = '/projects/?githubProject=11111111-1111-4111-8111-111111111111&githubRepo=acme%2Fsite&githubBranch=release%2F2026') => {
    const response = await handleRequest(api('/github/build/connect', 'POST', { projectId, repo: 'acme/site', branch: 'release/2026', returnTo }, session), f.env);
    return { response, data: await response.json() as any };
  };
  return { ...f, calls, start, githubPages, failRefresh(value: boolean) { failRefresh = value; } };
}

test('repository-free connect installs first, then authorizes and returns to the project picker', async t => {
  const f = await fixture(t);
  const projectId = '11111111-1111-4111-8111-111111111111';
  const response = await handleRequest(api('/github/build/connect', 'POST', { projectId }), f.env);
  assert.equal(response.status, 200);
  const install = new URL((await response.json() as any).url);
  assert.equal(install.pathname, '/apps/mainbrella-build/installations/new');
  assert.equal(f.calls.length, 0);
  const setup = `/github/build/setup?state=${install.searchParams.get('state')}&installation_id=987`;
  assert.equal((await handleRequest(api(setup, 'GET', undefined, SESSION_TWO, null), f.env)).status, 400);
  const authorization = await handleRequest(api(setup, 'GET', undefined, SESSION_ONE, null), f.env);
  const authorize = new URL(authorization.headers.get('Location')!);
  assert.equal(authorize.pathname, '/login/oauth/authorize');
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.equal((await handleRequest(api(setup, 'GET', undefined, SESSION_ONE, null), f.env)).status, 400);
  const callback = `/github/build/callback?state=${authorize.searchParams.get('state')}&code=installed-code`;
  const returned = await handleRequest(api(callback, 'GET', undefined, SESSION_ONE, null), f.env);
  const destination = new URL(returned.headers.get('Location')!);
  assert.equal(destination.origin, 'https://mainbrella.com');
  assert.equal(destination.pathname, '/projects/');
  assert.equal(destination.searchParams.get('githubProject'), projectId);
  assert.equal(destination.searchParams.get('github'), 'connected');
  assert.equal(destination.searchParams.has('githubRepo'), false);
  assert.equal(await githubBuildUserToken(f.env, USER_ONE), 'ghu_build-token');
  assert.equal((await handleRequest(api(callback, 'GET', undefined, SESSION_ONE, null), f.env)).status, 400);
});

test('install-first organization approval stays pending and preserves project storage', async t => {
  const f = await fixture(t);
  const response = await handleRequest(api('/github/build/connect', 'POST', { projectId: '11111111-1111-4111-8111-111111111111' }), f.env);
  const install = new URL((await response.json() as any).url);
  const returned = await handleRequest(api(`/github/build/setup?state=${install.searchParams.get('state')}&setup_action=request`, 'GET', undefined, SESSION_ONE, null), f.env);
  assert.equal(new URL(returned.headers.get('Location')!).searchParams.get('github'), 'approval_pending');
  assert.equal(f.calls.length, 0);
  assert.equal((f.sqlite.prepare('SELECT github_repo FROM projects').get() as any).github_repo, null);
});

async function connectUser(f: Awaited<ReturnType<typeof fixture>>) {
  const credentials = await sealGithubBuildCredentials(f.env, USER_ONE, { access_token: 'ghu_picker-token' });
  f.sqlite.prepare('INSERT INTO github_build_connections(user_id,github_user_id,github_login,credentials,expires_at) VALUES(?,?,?,?,?)')
    .run(USER_ONE, '456', 'build-user', credentials, Date.now() + 60_000_000);
}

test('repository picker lists only writable app installations and paginates personal and organization repos', async t => {
  const f = await fixture(t);
  assert.equal((await handleRequest(api('/github/build/repositories'), f.env)).status, 400);
  assert.equal((await handleRequest(api('/github/build/repositories', 'GET', undefined, ''), f.env)).status, 401);
  await connectUser(f);
  const installation = (id: number, extra = {}) => ({ id, app_slug: 'mainbrella-build', permissions: { contents: 'write' }, ...extra });
  f.githubPages.set('/user/installations?per_page=100&page=1', { installations: [
    installation(1, { app_slug: 'other-app' }), installation(2, { permissions: { contents: 'read' } }),
    installation(3, { suspended_at: new Date().toISOString() }), installation(4), installation(5),
  ] });
  const repository = (id: number, extra = {}) => ({ id, full_name: `personal/repo-${id}`, default_branch: 'main', private: true, permissions: { push: true }, ...extra });
  f.githubPages.set('/user/installations/4/repositories?per_page=100&page=1', { repositories: [
    repository(1, { permissions: { push: false } }), repository(2, { archived: true }), repository(3, { disabled: true }),
    ...Array.from({ length: 97 }, (_, index) => repository(index + 4)),
  ] });
  f.githubPages.set('/user/installations/4/repositories?per_page=100&page=2', { repositories: [repository(101)] });
  f.githubPages.set('/user/installations/5/repositories?per_page=100&page=1', { repositories: [repository(102, { full_name: 'organization/website', default_branch: 'master', private: false })] });
  const first = await (await handleRequest(api('/github/build/repositories'), f.env)).json() as any;
  assert.equal(first.repositories.length, 97);
  assert.equal(first.nextCursor, '1:3:2');
  assert.deepEqual(first.repositories[0], { id: 4, fullName: 'personal/repo-4', defaultBranch: 'main', private: true });
  const second = await (await handleRequest(api(`/github/build/repositories?cursor=${encodeURIComponent(first.nextCursor)}`), f.env)).json() as any;
  assert.equal(second.repositories[0].id, 101);
  assert.equal(second.nextCursor, '1:4:1');
  const last = await (await handleRequest(api(`/github/build/repositories?cursor=${encodeURIComponent(second.nextCursor)}`), f.env)).json() as any;
  assert.deepEqual(last, { repositories: [{ id: 102, fullName: 'organization/website', defaultBranch: 'master', private: false }], nextCursor: null });
  assert.equal(f.calls.filter(call => call.url.includes('/user/installations/')).length, 3);
  for (const call of f.calls) assert.equal((call.init?.headers as any).Authorization, 'Bearer ghu_picker-token');
  for (const query of ['cursor=bad', 'cursor=1:100:1', 'cursor=1:0:1&cursor=1:0:2', 'installation_id=4'])
    assert.equal((await handleRequest(api(`/github/build/repositories?${query}`), f.env)).status, 400);
});


test('Build app config and auth state are independent from read-only Import', async t => {
  const f = await fixture(t);
  assert.deepEqual(await (await handleRequest(api('/github/build/config'), f.env)).json(), { enabled: true });
  assert.deepEqual(await (await handleRequest(api('/github/import/config'), f.env)).json(), { enabled: true });
  const { response, data } = await f.start();
  assert.equal(response.status, 200);
  const authorize = new URL(data.url);
  assert.equal(authorize.searchParams.get('redirect_uri'), 'https://api.mainbrella.com/github/build/callback');
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(authorize.searchParams.get('code_challenge'));
  assert.equal(f.calls.length, 0);
  assert.equal((await handleRequest(api('/github/build/connect', 'POST', { projectId: '11111111-1111-4111-8111-111111111111', repo: 'acme/site' }, SESSION_ONE, null), f.env)).status, 403);
});

test('Build GitHub API supports writes and maps protected branches and access failures safely', async t => {
  const requests: { url: string; init?: RequestInit }[] = [];
  let status = 200, message = '';
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return Response.json(message ? { message } : { sha: 'abc' }, { status });
  });
  const pushed = await githubBuildAPI('/repos/acme/site/git/refs/heads/main', 'ghu_secret', 'PATCH', { sha: 'abc', force: false });
  assert.deepEqual(pushed, { sha: 'abc' });
  assert.equal(requests[0].init?.method, 'PATCH');
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), { sha: 'abc', force: false });
  status = 422; message = 'protected branch update failed';
  await assert.rejects(githubBuildAPI('/repos/acme/site/git/refs/heads/main', 'ghu_secret', 'PATCH', { sha: 'abc' }), /github_branch_protected/);
  status = 403; message = 'Resource not accessible by integration';
  await assert.rejects(githubBuildAPI('/repos/acme/site/contents/index.html', 'ghu_secret', 'PUT', {}), /github_write_access_required/);
  status = 404; message = '';
  await assert.rejects(githubBuildAPI('/repos/acme/missing', 'ghu_secret'), /github_repository_access_required/);
  status = 429;
  await assert.rejects(githubBuildAPI('/repos/acme/site', 'ghu_secret'), /github_rate_limited/);
});

test('Build OAuth state is project owner-bound and one-use; only encrypted Build credentials are persisted', async t => {
  const f = await fixture(t);
  const { data } = await f.start(); const authorize = new URL(data.url); const state = authorize.searchParams.get('state')!;
  const callback = `/github/build/callback?state=${state}&code=build-code`;
  assert.equal((await handleRequest(api(callback, 'GET', undefined, SESSION_TWO, null), f.env)).status, 400);
  const response = await handleRequest(api(callback, 'GET', undefined, SESSION_ONE, null), f.env);
  assert.equal(response.status, 302);
  const install = new URL(response.headers.get('Location')!);
  assert.equal(install.pathname, '/apps/mainbrella-build/installations/new');
  const stored = f.sqlite.prepare('SELECT credentials FROM github_build_connections WHERE user_id = ?').get(USER_ONE) as any;
  assert.doesNotMatch(stored.credentials, /ghu_|ghr_/);
  assert.equal(await githubBuildUserToken(f.env, USER_ONE), 'ghu_build-token');
  const setupState = install.searchParams.get('state')!;
  assert.equal((await handleRequest(api(`/github/build/setup?state=${setupState}`, 'GET', undefined, SESSION_TWO, null), f.env)).status, 400);
  const returned = await handleRequest(api(`/github/build/setup?state=${setupState}&installation_id=987`, 'GET', undefined, SESSION_ONE, null), f.env);
  assert.equal(returned.status, 302);
  const destination = new URL(returned.headers.get('Location')!);
  assert.equal(destination.pathname, '/projects/');
  assert.equal(destination.searchParams.get('githubProject'), '11111111-1111-4111-8111-111111111111');
  assert.equal(destination.searchParams.get('githubRepo'), 'acme/site');
  assert.equal(destination.searchParams.get('githubBranch'), 'release/2026');
  assert.equal(destination.searchParams.get('github'), 'connected');
  assert.equal((await handleRequest(api(`/github/build/setup?state=${setupState}`, 'GET', undefined, SESSION_ONE, null), f.env)).status, 400);
});

test('Build connect validates project ownership, safe branch names and fixed return path', async t => {
  const f = await fixture(t);
  assert.equal((await f.start('11111111-1111-4111-8111-111111111111', SESSION_TWO)).response.status, 404);
  for (const branch of ['../main', 'main..x', 'bad branch', 'topic/', 'main.lock']) {
    const response = await handleRequest(api('/github/build/connect', 'POST', { projectId: '11111111-1111-4111-8111-111111111111', repo: 'acme/site', branch }, SESSION_ONE), f.env);
    assert.equal(response.status, 400, branch);
  }
  for (const returnTo of ['https://evil.example/projects/', '//evil.example/projects/', '/pricing/?githubProject=11111111-1111-4111-8111-111111111111',
    '/projects/?githubProject=22222222-2222-4222-8222-222222222222&githubRepo=acme%2Fsite&githubBranch=release%2F2026']) {
    const body = { projectId: '11111111-1111-4111-8111-111111111111', repo: 'acme/site', branch: 'release/2026', returnTo };
    assert.equal((await handleRequest(api('/github/build/connect', 'POST', body), f.env)).status, 400, returnTo);
  }
  const connected = await handleRequest(api('/github/build/connection'), f.env);
  assert.deepEqual(await connected.json(), { connected: false, login: null, manageUrl: 'https://github.com/settings/installations' });
});

test('expired Build OAuth state cannot authorize or install a connection', async t => {
  const f = await fixture(t);
  const { data } = await f.start();
  const state = new URL(data.url).searchParams.get('state')!;
  f.sqlite.prepare('UPDATE github_build_states SET expires_at=0 WHERE user_id=?').run(USER_ONE);
  const response = await handleRequest(api(`/github/build/callback?state=${state}&code=expired-code`, 'GET', undefined, SESSION_ONE, null), f.env);
  assert.equal(response.status, 400);
  assert.equal(f.calls.length, 0);
  const connectionCount = f.sqlite.prepare('SELECT COUNT(*) AS count FROM github_build_connections').get() as any;
  assert.equal(connectionCount.count, 0);
});

test('expired refresh keeps a one-use token lease and does not replay after uncertain exchange', async t => {
  const f = await fixture(t);
  const sealed = await sealGithubBuildCredentials(f.env, USER_ONE, { access_token: 'ghu_expired', refresh_token: 'ghr_one-use' });
  f.sqlite.prepare('INSERT INTO github_build_connections (user_id, github_user_id, github_login, credentials, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(USER_ONE, '456', 'build-user', sealed, 0);
  f.failRefresh(true);
  await assert.rejects(githubBuildUserToken(f.env, USER_ONE), /github_unavailable/);
  const callsAfterExchange = f.calls.length;
  await assert.rejects(githubBuildUserToken(f.env, USER_ONE), /github_connection_busy/);
  assert.equal(f.calls.length, callsAfterExchange);
  f.sqlite.prepare('UPDATE github_build_connections SET refresh_until=0 WHERE user_id=?').run(USER_ONE);
  await assert.rejects(githubBuildUserToken(f.env, USER_ONE), /github_connection_required/);
  assert.equal(f.calls.length, callsAfterExchange);
});

test('read-only Import credentials are neither read nor reused by the Build app', async t => {
  const f = await fixture(t);
  const importCredentials = await sealGithubCredentials(f.env, USER_ONE, { access_token: 'ghu_import-only', refresh_token: 'ghr_import-only' });
  f.sqlite.prepare('INSERT INTO github_import_connections (user_id, github_user_id, github_login, credentials, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(USER_ONE, '123', 'import-user', importCredentials, Date.now() + 60_000_000);
  assert.equal(await githubUserToken(f.env, USER_ONE), 'ghu_import-only');
  await assert.rejects(githubBuildUserToken(f.env, USER_ONE), /github_connection_required/);
});
