import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBffLocal } from '../../scripts/bff-local.mjs';
import { demoConfig, localDemoConfig } from './demo-config';
import { checksum } from './contracts';
import { runtime } from './system-test-helpers';

const origin = 'https://mainbrella.com';
const base = `/projects/${demoConfig.projectId}`;
const data = `/bff/data/${demoConfig.projectId}/tables/messages`;
const migration = readFileSync(new URL('../../migrations/055_bff_public_demo.sql', import.meta.url), 'utf8');

async function fixture(t: test.TestContext, config: typeof demoConfig | typeof localDemoConfig = demoConfig,
  bindings: Record<string, string> = {}, browserOrigin = origin) {
  const f = await runtime(t, bindings);
  await f.db.prepare("INSERT INTO bff_projects(id,user_id,name,template,created_at) VALUES(?,'owner','Public demo','message_board',?)")
    .bind(config.projectId, new Date().toISOString()).run();
  await f.json(`/projects/${config.projectId}/provision`, 'POST');
  const keyId = crypto.randomUUID();
  await f.db.prepare('INSERT INTO api_keys(id,user_id,name,token_hash,prefix,created_at) VALUES(?,?,?,?,?,?)')
    .bind(keyId, 'owner', 'Demo', await checksum(config.publicKey), config.publicKey.slice(0, 15), new Date().toISOString()).run();
  await f.db.prepare('INSERT INTO bff_api_key_grants(api_key_id,project_id,origins,tables,functions) VALUES(?,?,?,?,?)')
    .bind(keyId, config.projectId, JSON.stringify([browserOrigin]), JSON.stringify({ messages: ['select'], users: ['select'] }), '{"list_messages":1}').run();
  // The public example only allows edits, not inserts/deletes. Migration 055
  // must leave this existing row policy intact.
  await f.json(`/projects/${config.projectId}/policies/messages`, 'PUT', { select: 'public', update: 'own', ownerColumn: 'user_id' });
  const browser = async (path: string, method: string, body?: unknown, status = 200, headers: Record<string, string> = {}) => {
    const response = await f.mf.dispatchFetch(`${config.apiOrigin}${path}`, { method,
      headers: { origin: browserOrigin, apikey: config.publicKey, 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal(response.status, status, await response.clone().text());
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('access-control-allow-credentials'), null);
    return response.json() as Promise<any>;
  };
  const login = (userId: string) => browser('/bff/demo/session', 'POST', { userId }, 201);
  return { ...f, keyId, browser, login };
}

test('fixed public demo issues real sessions, preserves RLS, and revokes only the logged-out session', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  const otherKey = await f.json(`${base}/api-keys`, 'POST', { name: 'Unrelated reader', origins: [origin], tables: { messages: ['select'] } }, 201);
  const policiesBefore = await f.json(`${base}/policies`);
  await f.db.prepare(migration).run();
  await f.db.prepare(migration).run(); // Idempotent if deployment retries.
  const grant = await f.db.prepare('SELECT * FROM bff_api_key_grants WHERE api_key_id=?').bind(f.keyId).first<any>();
  assert.deepEqual(JSON.parse(grant.tables), { messages: ['select', 'update'], users: ['select'] });
  assert.deepEqual(JSON.parse(grant.origins), [origin]);
  assert.deepEqual(JSON.parse(grant.functions), { list_messages: 1 });
  assert.deepEqual(await f.json(`${base}/policies`), policiesBefore);
  assert.deepEqual(JSON.parse((await f.db.prepare('SELECT tables FROM bff_api_key_grants WHERE api_key_id=?').bind(otherKey.key.id).first<any>())!.tables), { messages: ['select'] });

  const alice = await f.login('alice'), bob = await f.login('bob');
  assert.notEqual(alice.token, bob.token);
  assert.equal(alice.session.user_id, 'alice');
  assert.equal(bob.session.user_id, 'bob');
  const lifetime = Date.parse(alice.session.expires_at) - Date.parse(alice.session.created_at);
  assert.ok(lifetime >= 3_600_000 && lifetime < 3_600_100);
  const stored = await f.db.prepare('SELECT token_hash FROM bff_user_sessions WHERE id=?').bind(alice.session.id).first<any>();
  assert.equal(stored!.token_hash, await checksum(alice.token));
  assert.notEqual(stored!.token_hash, alice.token);
  const rows = (await f.browser(data, 'GET')).data;
  assert.deepEqual(rows.map((row: any) => row.user_id).sort(), ['alice', 'bob']);
  const own = rows.find((row: any) => row.user_id === 'alice'), other = rows.find((row: any) => row.user_id === 'bob');
  const changed = await f.browser(`${data}?id=eq.${own.id}`, 'PATCH', { user_id: own.user_id, body: 'Alice edited her message' }, 200, { authorization: `Bearer ${alice.token}` });
  assert.equal(changed.data[0].body, 'Alice edited her message');
  assert.deepEqual(await f.browser(`${data}?id=eq.${other.id}`, 'PATCH', { user_id: other.user_id, body: 'Forbidden edit' }, 403, { authorization: `Bearer ${alice.token}` }), { error: 'permission_denied' });
  assert.equal((await f.browser(data, 'GET')).data.find((row: any) => row.id === other.id).body, other.body);
  await f.browser(`${data}?id=eq.${own.id}`, 'PATCH', { user_id: own.user_id, body: 'Anonymous edit' }, 403);
  await f.browser(data, 'POST', { body: 'Anonymous insert' }, 403);
  await f.browser(`${data}?id=eq.${own.id}`, 'DELETE', undefined, 403);
  assert.equal((await f.browser(`${data}?id=eq.${other.id}`, 'PATCH', { user_id: other.user_id, body: 'Bob edited his message' }, 200, { authorization: `Bearer ${bob.token}` })).data[0].body, 'Bob edited his message');
  assert.deepEqual(await f.browser('/bff/demo/session', 'DELETE', undefined, 200, { authorization: `Bearer ${alice.token}` }), { revoked: true });
  await f.browser('/bff/demo/session', 'DELETE', undefined, 200, { authorization: `Bearer ${alice.token}` });
  await f.browser(data, 'GET', undefined, 401, { authorization: `Bearer ${alice.token}` });
  await f.browser(data, 'GET', undefined, 200, { authorization: `Bearer ${bob.token}` });
  await f.db.prepare("UPDATE bff_user_sessions SET expires_at='2000-01-01' WHERE id=?").bind(bob.session.id).run();
  await f.browser(data, 'GET', undefined, 401, { authorization: `Bearer ${bob.token}` });
  // Login never updates grants, even if a maintainer later removes update.
  await f.db.prepare('UPDATE bff_api_key_grants SET tables=? WHERE api_key_id=?').bind('{"messages":["select"]}', f.keyId).run();
  const reader = await f.login('alice');
  await f.browser(`${data}?id=eq.${own.id}`, 'PATCH', { user_id: own.user_id, body: 'Missing key grant' }, 403, { authorization: `Bearer ${reader.token}` });
});

test('demo login rejects arbitrary identities, credentials, projects, and origins; preflight is scoped', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  for (const input of [{ userId: 'owner' }, { userId: 'Alice' }, { userId: 'alice', projectId: crypto.randomUUID() }, { userId: 'bob', password: 'ignored' }, {}, null]) {
    await f.browser('/bff/demo/session', 'POST', input, 400);
  }
  await f.browser('/bff/demo/session?projectId=other', 'POST', { userId: 'alice' }, 400);
  await f.browser('/bff/demo/session', 'POST', { userId: 'alice' }, 401, { apikey: '' });
  await f.browser('/bff/demo/session', 'POST', { userId: 'alice' }, 401, { apikey: localDemoConfig.publicKey });
  const reader = await f.json(`${base}/api-keys`, 'POST', { name: 'Other key', origins: [origin], tables: { messages: ['select'] } }, 201);
  await f.browser('/bff/demo/session', 'POST', { userId: 'alice' }, 401, { apikey: reader.token });
  await f.browser('/bff/demo/session', 'POST', { userId: 'alice' }, 401, { authorization: `Bearer mb_${'a'.repeat(64)}` });
  await f.browser('/bff/demo/session', 'DELETE', undefined, 401);
  await f.browser('/bff/demo/session', 'POST', { userId: 'alice' }, 403, { origin: 'https://evil.example' });
  const preflight = (headers: Record<string, string>) => f.mf.dispatchFetch('https://api.mainbrella.com/bff/demo/session', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'apikey,content-type,authorization', ...headers } });
  const allowed = await preflight({});
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get('access-control-allow-origin'), origin);
  assert.equal(allowed.headers.get('access-control-allow-credentials'), null);
  assert.equal((await preflight({ origin: 'https://evil.example' })).status, 403);
  assert.equal((await preflight({ 'access-control-request-method': 'PATCH' })).status, 403);
  assert.equal((await preflight({ 'access-control-request-headers': 'cookie' })).status, 403);

  const other = (await f.json('/projects', 'POST', { name: 'Other project' }, 201)).project;
  await f.json(`/projects/${other.id}/provision`, 'POST');
  const otherSession = await f.json(`/projects/${other.id}/sessions`, 'POST', { userId: 'alice' }, 201);
  await f.browser('/bff/demo/session', 'DELETE', undefined, 200, { authorization: `Bearer ${otherSession.token}` });
  assert.ok(await f.db.prepare('SELECT id FROM bff_user_sessions WHERE id=?').bind(otherSession.session.id).first());
  // A matching token attached to another project neither logs in nor migrates.
  await f.db.prepare('UPDATE bff_api_key_grants SET project_id=? WHERE api_key_id=?').bind(other.id, f.keyId).run();
  await f.db.prepare(migration).run();
  assert.deepEqual(JSON.parse((await f.db.prepare('SELECT tables FROM bff_api_key_grants WHERE api_key_id=?').bind(f.keyId).first<any>())!.tables).messages, ['select']);
  await f.browser('/bff/demo/session', 'POST', { userId: 'alice' }, 401);
  await f.db.prepare('UPDATE bff_api_key_grants SET project_id=? WHERE api_key_id=?').bind(demoConfig.projectId, f.keyId).run();
  await f.db.prepare("UPDATE api_keys SET user_id='stranger' WHERE id=?").bind(f.keyId).run();
  await f.browser('/bff/demo/session', 'POST', { userId: 'alice' }, 401);
  await f.db.prepare("UPDATE api_keys SET user_id='owner' WHERE id=?").bind(f.keyId).run();
  await f.db.prepare("UPDATE bff_projects SET template='empty' WHERE id=?").bind(demoConfig.projectId).run();
  await f.browser('/bff/demo/session', 'POST', { userId: 'alice' }, 404);
  await f.db.prepare("UPDATE bff_projects SET template='message_board' WHERE id=?").bind(demoConfig.projectId).run();
  await f.db.prepare('DELETE FROM api_keys WHERE id=?').bind(f.keyId).run();
  await f.browser('/bff/demo/session', 'POST', { userId: 'alice' }, 401);
  assert.equal((await preflight({})).status, 401);
});

test('local demo issues and revokes sessions only for its fixed project and browser key', { timeout: 60_000 }, async t => {
  const statePath = await mkdtemp(join(tmpdir(), 'bff-demo-local-'));
  const local = await startBffLocal({ statePath });
  t.after(async () => { await local.close(); await rm(statePath, { recursive: true, force: true }); });
  const localOrigin = 'http://localhost:5173';
  const f = await fixture(t, localDemoConfig, { LOCAL_DEV: 'true', BFF_LOCAL_URL: local.url, BFF_LOCAL_TOKEN: local.token }, localOrigin);

  const preflight = await f.mf.dispatchFetch(`${localDemoConfig.apiOrigin}/bff/demo/session`, {
    method: 'OPTIONS', headers: { origin: localOrigin, 'access-control-request-method': 'POST',
      'access-control-request-headers': 'apikey,content-type,authorization' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), localOrigin);
  await f.browser('/bff/demo/session', 'POST', { userId: 'alice' }, 401, { apikey: demoConfig.publicKey });
  await f.browser('/bff/demo/session', 'POST', { userId: 'owner' }, 400);
  await f.browser('/bff/demo/session', 'POST', { userId: 'alice' }, 403, { origin: 'https://evil.example' });

  const alice = await f.login('alice');
  assert.equal(alice.session.user_id, 'alice');
  assert.equal((await f.db.prepare('SELECT project_id FROM bff_user_sessions WHERE id=?')
    .bind(alice.session.id).first<{ project_id: string }>())?.project_id, localDemoConfig.projectId);
  assert.equal((await f.browser(`/bff/data/${localDemoConfig.projectId}/tables/messages`, 'GET', undefined, 200,
    { authorization: `Bearer ${alice.token}` })).data.length, 2);
  assert.deepEqual(await f.browser('/bff/demo/session', 'DELETE', undefined, 200,
    { authorization: `Bearer ${alice.token}` }), { revoked: true });
  assert.equal(await f.db.prepare('SELECT id FROM bff_user_sessions WHERE id=?').bind(alice.session.id).first(), null);

  const otherProject = crypto.randomUUID();
  await f.db.prepare("INSERT INTO bff_projects(id,user_id,name,template,created_at) VALUES(?,'owner','Other local project','message_board',?)")
    .bind(otherProject, new Date().toISOString()).run();
  await f.db.prepare('UPDATE bff_api_key_grants SET project_id=? WHERE api_key_id=?').bind(otherProject, f.keyId).run();
  await f.browser('/bff/demo/session', 'POST', { userId: 'alice' }, 401);
  await f.db.prepare('UPDATE bff_api_key_grants SET project_id=? WHERE api_key_id=?').bind(localDemoConfig.projectId, f.keyId).run();
  await f.db.prepare("UPDATE api_keys SET user_id='stranger' WHERE id=?").bind(f.keyId).run();
  await f.browser('/bff/demo/session', 'POST', { userId: 'alice' }, 401);
  assert.equal((await f.mf.dispatchFetch(`${localDemoConfig.apiOrigin}/bff/demo/session`, {
    method: 'OPTIONS', headers: { origin: localOrigin, 'access-control-request-method': 'POST' },
  })).status, 401);
  await f.db.prepare("UPDATE api_keys SET user_id='owner' WHERE id=?").bind(f.keyId).run();
  await f.db.prepare('DELETE FROM bff_api_key_grants WHERE api_key_id=?').bind(f.keyId).run();
  await f.browser('/bff/demo/session', 'POST', { userId: 'alice' }, 401);
});

test('public session issuance retains readiness, user existence, expiry cleanup, and session cap checks', { timeout: 60_000 }, async t => {
  const f = await fixture(t);
  const alice = await f.login('alice');
  await f.db.prepare('UPDATE bff_projects SET suspended=1 WHERE id=?').bind(demoConfig.projectId).run();
  await f.browser('/bff/demo/session', 'POST', { userId: 'alice' }, 403);
  await f.browser('/bff/demo/session', 'DELETE', undefined, 200, { authorization: `Bearer ${alice.token}` });
  await f.db.prepare("UPDATE bff_projects SET suspended=0,state='pending' WHERE id=?").bind(demoConfig.projectId).run();
  await f.browser('/bff/demo/session', 'POST', { userId: 'alice' }, 409);
  await f.db.prepare("UPDATE bff_projects SET state='ready',blocked=1 WHERE id=?").bind(demoConfig.projectId).run();
  await f.browser('/bff/demo/session', 'POST', { userId: 'alice' }, 403);
  await f.db.prepare('UPDATE bff_projects SET blocked=0 WHERE id=?').bind(demoConfig.projectId).run();
  const created = new Date().toISOString();
  await f.db.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<100)
    INSERT INTO bff_user_sessions(id,project_id,user_id,token_hash,expires_at,created_at)
    SELECT 'cap-'||x,?,'alice','cap-hash-'||x,'2099-01-01',? FROM n`).bind(demoConfig.projectId, created).run();
  await f.browser('/bff/demo/session', 'POST', { userId: 'alice' }, 429);
  await f.db.prepare("UPDATE bff_user_sessions SET expires_at='2000-01-01' WHERE id='cap-1'").run();
  await f.login('alice');
  assert.equal(await f.db.prepare("SELECT id FROM bff_user_sessions WHERE id='cap-1'").first(), null);
  await f.json(`${base}/query`, 'POST', { sql: "DELETE FROM messages WHERE user_id='bob'" });
  await f.json(`${base}/query`, 'POST', { sql: "DELETE FROM users WHERE id='bob'" });
  await f.browser('/bff/demo/session', 'POST', { userId: 'bob' }, 404);
});

test('disabled BFF rejects public login while allowing demo logout', { timeout: 60_000 }, async t => {
  const f = await runtime(t, { BFF_ENABLED: 'false' });
  await f.db.prepare("INSERT INTO bff_projects(id,user_id,name,template,created_at) VALUES(?,'owner','Disabled demo','message_board',?)").bind(demoConfig.projectId, new Date().toISOString()).run();
  const keyId = crypto.randomUUID();
  await f.db.prepare('INSERT INTO api_keys(id,user_id,name,token_hash,prefix,created_at) VALUES(?,?,?,?,?,?)').bind(keyId, 'owner', 'Demo', await checksum(demoConfig.publicKey), demoConfig.publicKey.slice(0, 15), new Date().toISOString()).run();
  await f.db.prepare('INSERT INTO bff_api_key_grants(api_key_id,project_id,origins,tables,functions) VALUES(?,?,?,?,?)').bind(keyId, demoConfig.projectId, JSON.stringify([origin]), '{"messages":["select"]}', '{}').run();
  const token = `bff_us_${'a'.repeat(64)}`;
  await f.db.prepare('INSERT INTO bff_user_sessions VALUES(?,?,?,?,?,?)').bind(crypto.randomUUID(), demoConfig.projectId, 'alice', await checksum(token), '2099-01-01', new Date().toISOString()).run();
  const login = await f.request('/demo/session', 'POST', { userId: 'alice' }, '', { apikey: demoConfig.publicKey });
  assert.equal(login.status, 503);
  const logout = await f.request('/demo/session', 'DELETE', undefined, '', { apikey: demoConfig.publicKey, authorization: `Bearer ${token}` });
  assert.equal(logout.status, 200);
  assert.deepEqual((await f.db.prepare('SELECT id FROM bff_user_sessions').all()).results, []);
});
