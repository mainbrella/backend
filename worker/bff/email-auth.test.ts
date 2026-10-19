import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './system-test-helpers';

const origin = 'https://yapern.com';

async function fixture(t: test.TestContext) {
  const f = await runtime(t);
  const { project } = await f.json('/projects', 'POST', { name: 'Email board' }, 201);
  const base = `/projects/${project.id}`;
  await f.json(`${base}/provision`, 'POST');
  const key = await f.json(`${base}/api-keys`, 'POST', {
    name: 'Browser', origins: [origin], tables: { messages: ['select', 'insert'], users: ['select'] },
  }, 201);
  const auth = `/data/${project.id}/auth`;
  async function browser(path: string, method = 'POST', input?: unknown, status = 201, headers: Record<string, string> = {}) {
    const response = await f.request(path, method, input, '', {
      origin, apikey: key.token, 'CF-Connecting-IP': '192.0.2.21', ...headers,
    });
    assert.equal(response.status, status, await response.clone().text());
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('access-control-allow-credentials'), null);
    return response;
  }
  const login = (email = 'Person@example.com', password = 'a strong password') => browser(`${auth}/email`, 'POST', { email, password });
  return { ...f, project, base, key, auth, browser, login };
}

test('email accounts create project users, store private salted hashes, reuse real BFF sessions, and revoke them', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  const first = await f.login(' Person@Example.COM ');
  assert.equal(first.headers.get('access-control-allow-origin'), origin);
  assert.equal(first.headers.get('set-cookie'), null);
  const account = await first.json() as any;
  assert.equal(account.created, true);
  assert.equal(account.user.email, 'person@example.com');
  assert.equal(account.user.id, account.session.user_id);
  assert.match(account.token, /^bff_us_[a-f0-9]{64}$/);
  assert.ok(!['alice', 'bob', 'owner'].includes(account.user.id));
  const credential = await f.db.prepare('SELECT * FROM bff_email_accounts WHERE project_id=?').bind(f.project.id).first<any>();
  assert.match(credential.password_hash, /^scrypt:16384:8:5:[a-f0-9]{32}:[a-f0-9]{64}$/);
  assert.equal(credential.provisioned, 1);
  assert.ok(!JSON.stringify(account).includes('password_hash'));
  const stored = await f.db.prepare('SELECT token_hash FROM bff_user_sessions WHERE id=?').bind(account.session.id).first<any>();
  assert.notEqual(stored.token_hash, account.token);
  const again = await (await f.login('PERSON@example.com')).json() as any;
  assert.equal(again.user.id, account.user.id);
  assert.equal(again.created, false);
  const users = await (await f.browser(`/data/${f.project.id}/tables/users`, 'GET', undefined, 200)).json() as any;
  assert.equal(users.data.filter((user: any) => user.id === account.user.id).length, 1);
  assert.ok(!JSON.stringify(users).includes('person@example.com'));
  assert.ok(!JSON.stringify(users).includes('scrypt:'));
  const authHeaders = { authorization: `Bearer ${account.token}` };
  const session = await (await f.browser(`${f.auth}/session`, 'GET', undefined, 200, authHeaders)).json() as any;
  assert.deepEqual(session, { session: account.session, user: account.user });
  const posted = await (await f.browser(`/data/${f.project.id}/tables/messages`, 'POST', { body: 'A real account posting' }, 201, authHeaders)).json() as any;
  assert.equal(posted.data[0].user_id, account.user.id);
  await f.browser(`${f.auth}/email`, 'POST', { email: 'person@example.com', password: 'wrong password' }, 401);
  const second = await (await f.login('other@example.com')).json() as any;
  const otherCredential = await f.db.prepare('SELECT password_hash FROM bff_email_accounts WHERE project_id=? AND user_id=?').bind(f.project.id, second.user.id).first<any>();
  assert.notEqual(otherCredential.password_hash, credential.password_hash);
  await f.browser(`${f.auth}/session`, 'DELETE', undefined, 200, authHeaders);
  await f.browser(`${f.auth}/session`, 'DELETE', undefined, 200, authHeaders);
  await f.browser(`${f.auth}/session`, 'GET', undefined, 401, authHeaders);
  await f.browser(`/data/${f.project.id}/tables/messages`, 'GET', undefined, 401, authHeaders);
  await f.browser(`${f.auth}/session`, 'GET', undefined, 200, { authorization: `Bearer ${again.token}` });
});

test('email auth checks keys, origins, input, expiry, project boundaries, and preflight', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  const endpoint = `${f.auth}/email`;
  for (const input of [{}, null, { email: 'bad', password: 'password' }, { email: 'ok@example.com', password: '' },
    { email: 'ok@example.com', password: 'x'.repeat(129) }, { email: 'ok@example.com', password: 'password', userId: 'alice' }]) {
    await f.browser(endpoint, 'POST', input, 400);
  }
  assert.deepEqual(await (await f.browser(endpoint, 'POST', { email: 'new@example.com', password: 'short' }, 400)).json(), { error: 'weak_password' });
  await f.browser(endpoint, 'POST', { email: 'ok@example.com', password: 'password' }, 401, { apikey: '' });
  await f.browser(endpoint, 'POST', { email: 'ok@example.com', password: 'password' }, 403, { origin: 'https://evil.example' });
  await f.browser(endpoint, 'POST', { email: 'ok@example.com', password: 'password' }, 401, { authorization: 'Bearer invalid' });
  await f.browser(`${endpoint}?projectId=other`, 'POST', {}, 400);
  const options = await f.browser(endpoint, 'OPTIONS', undefined, 204, { apikey: '', 'access-control-request-method': 'POST', 'access-control-request-headers': 'apikey,content-type' });
  assert.equal(options.headers.get('access-control-allow-origin'), origin);
  await f.browser(endpoint, 'OPTIONS', undefined, 403, { 'access-control-request-method': 'DELETE' });
  await f.browser(endpoint, 'OPTIONS', undefined, 403, { origin: 'https://evil.example' });
  const account = await (await f.login()).json() as any;
  const authHeaders = { authorization: `Bearer ${account.token}` };
  const { project: other } = await f.json('/projects', 'POST', { name: 'Other board' }, 201);
  await f.json(`/projects/${other.id}/provision`, 'POST');
  const otherKey = await f.json(`/projects/${other.id}/api-keys`, 'POST', { name: 'Other key', origins: [origin], tables: { users: ['select'] } }, 201);
  await f.browser(`/data/${other.id}/auth/session`, 'GET', undefined, 401, { ...authHeaders, apikey: otherKey.token });
  await f.browser(`${f.auth}/session`, 'GET', undefined, 401, { ...authHeaders, apikey: otherKey.token });
  await f.db.prepare("UPDATE bff_user_sessions SET expires_at='2000-01-01' WHERE id=?").bind(account.session.id).run();
  await f.browser(`${f.auth}/session`, 'GET', undefined, 401, authHeaders);
  const active = await (await f.login()).json() as any;
  await f.json(f.base, 'PATCH', { suspended: true });
  await f.browser(endpoint, 'POST', { email: 'person@example.com', password: 'a strong password' }, 403);
  await f.browser(`${f.auth}/session`, 'DELETE', undefined, 200, { authorization: `Bearer ${active.token}` });
});

test('email auth retries provisioning safely and never replaces a password or restores a deleted user', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  f.redirectNextQuery();
  await f.browser(`${f.auth}/email`, 'POST', { email: 'person@example.com', password: 'a strong password' }, 502);
  const account = await (await f.login()).json() as any;
  await f.browser(`${f.auth}/email`, 'POST', { email: 'person@example.com', password: 'different password' }, 401);
  await f.json(`${f.base}/query`, 'POST', { sql: 'DELETE FROM users WHERE id=?', params: [account.user.id] });
  await f.browser(`${f.auth}/session`, 'GET', undefined, 401, { authorization: `Bearer ${account.token}` });
  await f.browser(`${f.auth}/email`, 'POST', { email: 'person@example.com', password: 'a strong password' }, 404);
});

test('email auth is rate limited before password hashing or account creation', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  for (let i = 0; i < 21; i++) {
    const response = await f.browser(`${f.auth}/email`, 'POST', {}, i < 20 ? 400 : 429);
    if (i === 20) assert.deepEqual(await response.json(), { error: 'rate_limited' });
  }
  assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM bff_email_accounts').first('n'), 0);
});

test('concurrent signups keep one account and authenticate the winning password', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  const passwords = ['first strong password', 'second strong password'];
  const responses = await Promise.all(passwords.map(password => f.request(`${f.auth}/email`, 'POST', {
    email: 'race@example.com', password,
  }, '', { origin, apikey: f.key.token, 'CF-Connecting-IP': '192.0.2.22' })));
  assert.deepEqual(responses.map(response => response.status).sort(), [201, 401]);
  const winningIndex = responses.findIndex(response => response.status === 201);
  const winning = await responses[winningIndex].json() as any;
  assert.equal(winning.created, true);
  const retry = await (await f.login('race@example.com', passwords[winningIndex])).json() as any;
  assert.equal(retry.user.id, winning.user.id);
  assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM bff_email_accounts WHERE project_id=?').bind(f.project.id).first('n'), 1);
  await f.browser(`${f.auth}/email`, 'POST', { email: 'race@example.com', password: passwords[1 - winningIndex] }, 401);
});
