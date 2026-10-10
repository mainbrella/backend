import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleRequest } from './router';
import { hashToken } from './auth-core';
import { paidContainerFixture, SESSION_ONE, SESSION_TWO, USER_ONE, USER_TWO } from './paid-container-test-helpers';
import { githubUserToken, sealGithubCredentials } from '../lib/github-import';

const api = (path: string, method = 'GET', body?: unknown, session = SESSION_ONE, origin: string | null = 'https://mainbrella.com') => new Request(`https://api.mainbrella.com${path}`, {
  method, headers: { Cookie: `mainbrella_session=${session}`, ...(origin ? { Origin: origin } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}) });
async function fixture(t: TestContext) {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  f.sqlite.exec(readFileSync(new URL('../../migrations/028_github_import.sql', import.meta.url), 'utf8'));
  Object.assign(f.env, { GITHUB_IMPORT_CLIENT_ID: 'test-client', GITHUB_IMPORT_CLIENT_SECRET: 'test-secret',
    GITHUB_IMPORT_APP_SLUG: 'mainbrella-import', GITHUB_IMPORT_ENCRYPTION_KEY: 'e'.repeat(64) });
  const calls: { url: string; init?: RequestInit }[] = [];
  let tokenFailure = false;
  const delegate = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('github.com')) {
      calls.push({ url, init });
      if (url.endsWith('/user')) return Response.json({ id: 123, login: 'github-one' });
      if (url.endsWith('/access_token')) return tokenFailure ? Response.json({ error: 'bad_verification_code' })
        : Response.json({ access_token: 'ghu_test-secret-token', refresh_token: 'ghr_test-refresh-token', expires_in: 28800, refresh_token_expires_in: 15897600 });
    }
    return delegate(input, init);
  });
  const start = async (session = SESSION_ONE, returnTo = '/run/?repo=acme/private&private=1#config=12345678-1234-1234-1234-123456789abc') => {
    const response = await handleRequest(api('/github/import/connect', 'POST', { repo: 'acme/private', returnTo }, session), f.env);
    assert.equal(response.status, 200);
    return new URL((await response.json() as any).url);
  };
  return { ...f, calls, start, tokenFailure() { tokenFailure = true; } };
}

test('GitHub connection requires a browser session and trusted Origin, accepts no open redirect, and allocates nothing', async t => {
  const f = await fixture(t);
  assert.deepEqual(await (await handleRequest(api('/github/import/config'), f.env)).json(), { enabled: true });
  assert.equal((await handleRequest(api('/github/import/connect', 'POST', { repo: 'acme/private' }, 'unknown'), f.env)).status, 401);
  for (const origin of [null, 'https://evil.example']) assert.equal((await handleRequest(api('/github/import/connect', 'POST', { repo: 'acme/private' }, SESSION_ONE, origin), f.env)).status, 403);
  for (const returnTo of ['https://evil.example/run/', '//evil.example/run/', '/pricing/'])
    assert.equal((await handleRequest(api('/github/import/connect', 'POST', { repo: 'acme/private', returnTo }), f.env)).status, 400);
  const authorize = await f.start();
  assert.equal(authorize.origin, 'https://github.com'); assert.equal(authorize.pathname, '/login/oauth/authorize');
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256'); assert.equal(authorize.searchParams.get('code_challenge')!.length, 43);
  assert.equal(authorize.searchParams.get('redirect_uri'), 'https://api.mainbrella.com/github/import/callback');
  assert.equal(authorize.searchParams.has('scope'), false);
  assert.equal(f.accountCalls.length, 0); assert.equal(f.calls.length, 0);
});

test('OAuth state is account-bound and single-use; PKCE tokens are encrypted and never returned to the browser', async t => {
  const f = await fixture(t);
  const authorize = await f.start(); const state = authorize.searchParams.get('state')!;
  const path = `/github/import/callback?state=${state}&code=test-code`;
  assert.equal((await handleRequest(api(path, 'GET', undefined, SESSION_TWO, null), f.env)).status, 400);
  assert.equal(f.calls.length, 0);
  const response = await handleRequest(api(path, 'GET', undefined, SESSION_ONE, null), f.env);
  assert.equal(response.status, 302);
  const install = new URL(response.headers.get('Location')!);
  assert.equal(install.pathname, '/apps/mainbrella-import/installations/new');
  const exchangeBody = new URLSearchParams(f.calls[0].init?.body as URLSearchParams);
  assert.equal(exchangeBody.get('code'), 'test-code'); assert.equal(exchangeBody.get('code_verifier')!.length, 64);
  assert.equal(f.calls[0].init?.redirect, 'manual');
  const stored = f.sqlite.prepare('SELECT credentials FROM github_import_connections WHERE user_id = ?').get(USER_ONE) as any;
  assert.doesNotMatch(stored.credentials, /ghu_|ghr_/);
  assert.equal(await githubUserToken(f.env, USER_ONE), 'ghu_test-secret-token');
  assert.equal((await handleRequest(api(path, 'GET', undefined, SESSION_ONE, null), f.env)).status, 400);
  const returned = await handleRequest(api(`/github/import/setup?state=${install.searchParams.get('state')}&installation_id=999`, 'GET', undefined, SESSION_ONE, null), f.env);
  assert.equal(returned.status, 302);
  const destination = new URL(returned.headers.get('Location')!);
  assert.equal(destination.origin, 'https://mainbrella.com'); assert.equal(destination.searchParams.get('github'), 'connected');
  assert.match(destination.hash, /^#config=/); assert.doesNotMatch(destination.href, /ghu_|ghr_|test-code/);
});

test('expired states and cancelled authorization cannot connect an account; installation approval remains pending', async t => {
  const f = await fixture(t);
  const expired = (await f.start()).searchParams.get('state')!;
  f.sqlite.prepare('UPDATE github_import_states SET expires_at = 0').run();
  assert.equal((await handleRequest(api(`/github/import/callback?state=${expired}&code=test`, 'GET', undefined, SESSION_ONE, null), f.env)).status, 400);
  const cancelled = (await f.start()).searchParams.get('state')!;
  const response = await handleRequest(api(`/github/import/callback?state=${cancelled}&error=access_denied`, 'GET', undefined, SESSION_ONE, null), f.env);
  assert.equal(new URL(response.headers.get('Location')!).searchParams.get('github'), 'cancelled'); assert.equal(f.calls.length, 0);
  const state = (await f.start()).searchParams.get('state')!;
  const authorized = await handleRequest(api(`/github/import/callback?state=${state}&code=test`, 'GET', undefined, SESSION_ONE, null), f.env);
  const installation = new URL(authorized.headers.get('Location')!).searchParams.get('state')!;
  const pending = await handleRequest(api(`/github/import/setup?state=${installation}&setup_action=request`, 'GET', undefined, SESSION_ONE, null), f.env);
  assert.equal(new URL(pending.headers.get('Location')!).searchParams.get('github'), 'approval_pending');
});

test('encrypted credentials cannot be moved between users; refresh rotates once and an uncertain rotation requires reconnection', async t => {
  const f = await fixture(t);
  const sealed = await sealGithubCredentials(f.env, USER_ONE, { access_token: 'ghu_expired', refresh_token: 'ghr_single-use' });
  f.sqlite.prepare('INSERT INTO github_import_connections (user_id, github_user_id, github_login, credentials, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(USER_ONE, '123', 'github-one', sealed, 0);
  f.sqlite.prepare('INSERT INTO github_import_connections (user_id, github_user_id, github_login, credentials, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(USER_TWO, '123', 'github-one', sealed, Date.now() + 86400000);
  await assert.rejects(githubUserToken(f.env, USER_TWO));
  assert.equal(await githubUserToken(f.env, USER_ONE), 'ghu_test-secret-token');
  assert.equal(await githubUserToken(f.env, USER_ONE), 'ghu_test-secret-token');
  assert.equal(f.calls.length, 1);
  f.sqlite.prepare('UPDATE github_import_connections SET expires_at = 0, refresh_lock = ?, refresh_until = 0 WHERE user_id = ?').run('uncertain', USER_ONE);
  await assert.rejects(githubUserToken(f.env, USER_ONE), /github_connection_required/); assert.equal(f.calls.length, 1);
});

test('disconnect is owner-scoped and removes pending credentials without affecting existing containers', async t => {
  const f = await fixture(t);
  const state = (await f.start()).searchParams.get('state')!;
  await handleRequest(api(`/github/import/callback?state=${state}&code=test`, 'GET', undefined, SESSION_ONE, null), f.env);
  assert.equal((await handleRequest(api('/github/import/connection', 'DELETE', undefined, SESSION_ONE, null), f.env)).status, 403);
  await handleRequest(api('/github/import/connection', 'DELETE', undefined, SESSION_TWO), f.env);
  assert.equal(await githubUserToken(f.env, USER_ONE), 'ghu_test-secret-token');
  const response = await handleRequest(api('/github/import/connection', 'DELETE'), f.env);
  assert.deepEqual(await response.json(), { ok: true });
  await assert.rejects(githubUserToken(f.env, USER_ONE), /github_connection_required/);
  assert.equal((f.sqlite.prepare('SELECT COUNT(*) AS count FROM github_import_states WHERE user_id = ?').get(USER_ONE) as any).count, 0);
  assert.equal(f.accountCalls.length, 0);
});
