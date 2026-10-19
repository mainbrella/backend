import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBffLocal } from '../../scripts/bff-local.mjs';
import { runtime } from './system-test-helpers';

test('local BFF provisions the starter, migrates, queries and invokes functions without Cloudflare credentials', { timeout: 60_000 }, async t => {
  const statePath = await mkdtemp(join(tmpdir(), 'bff-worker-local-'));
  const local = await startBffLocal({ statePath });
  t.after(async () => { await local.close(); await rm(statePath, { recursive: true, force: true }); });
  const f = await runtime(t, { LOCAL_DEV: 'true', BFF_LOCAL_URL: local.url, BFF_LOCAL_TOKEN: local.token,
    BFF_CLOUDFLARE_ACCOUNT_ID: '', BFF_CLOUDFLARE_API_TOKEN: '' });
  assert.equal((await f.json('/config')).available, true);
  const { project } = await f.json('/projects', 'POST', { name: 'Local board' }, 201);
  const base = `/projects/${project.id}`;
  assert.equal((await f.json(`${base}/provision`, 'POST')).project.state, 'ready');
  assert.deepEqual((await f.json(`${base}/schema`)).tables.map((table: any) => [table.name, table.count]), [['messages', 2], ['users', 2]]);
  assert.equal((await f.json(`${base}/functions/list_messages/invoke`, 'POST', { input: null })).ok, true);
  await f.json(`${base}/migrations`, 'POST', { sequence: 2, name: 'notes', sql: 'CREATE TABLE notes(body TEXT);' });
  await f.json(`${base}/query`, 'POST', { sql: 'INSERT INTO notes(body) VALUES(?)', params: ['Local data'] });
  assert.deepEqual((await f.json(`${base}/query`, 'POST', { sql: 'SELECT * FROM notes' })).result.results, [{ body: 'Local data' }]);
  const other = (await f.json('/projects', 'POST', { name: 'Other', template: 'empty' }, 201)).project;
  await f.json(`/projects/${other.id}/provision`, 'POST');
  assert.deepEqual((await f.json(`/projects/${other.id}/schema`)).tables, []);
  assert.equal((await f.request(`${base}/query`, 'POST', { sql: 'SELECT 1' }, 'stranger')).status, 404);
  assert.equal(f.databases.size, 0, 'Local projects must not use the remote Cloudflare database provider');
  await f.db.prepare("DELETE FROM users WHERE id='owner'").run();
  await f.db.prepare("UPDATE bff_database_deletions SET created_at='2020-01-01'").run();
  await f.mf.dispatchFetch('https://internal/__test_cleanup');
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM bff_database_deletions').first())!.n, 0);
  const response = await fetch(`${local.url}?name=bff-local-${project.id}`, { headers: { authorization: `Bearer ${local.token}` } });
  assert.deepEqual((await response.json() as any).result, []);
});

test('local BFF fails closed without its local provider, even with remote credentials', { timeout: 30_000 }, async t => {
  const f = await runtime(t, { LOCAL_DEV: 'true' });
  assert.equal((await f.json('/config')).available, false);
  const { project } = await f.json('/projects', 'POST', { name: 'Unavailable', template: 'empty' }, 201);
  await f.json(`/projects/${project.id}/provision`, 'POST', undefined, 503);
  assert.deepEqual(f.outboundTargets, []);
});
