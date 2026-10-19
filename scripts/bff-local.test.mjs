import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBffLocal } from './bff-local.mjs';
import { resolveTool } from './resolve-tool.mjs';

test('local BFF uses isolated Wrangler D1 databases with atomic batches, persistence and deletion', { timeout: 60_000 }, async t => {
  const statePath = await mkdtemp(join(tmpdir(), 'bff-local-'));
  let local = await startBffLocal({ statePath });
  t.after(async () => { await local.close(); await rm(statePath, { recursive: true, force: true }); });
  async function request(path = '', method = 'GET', body, status = 200, headers = {}) {
    const response = await fetch(`${local.url}${path}`, { method,
      headers: { authorization: `Bearer ${local.token}`, 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal(response.status, status, await response.clone().text());
    return (await response.json()).result;
  }
  const first = randomUUID(), second = randomUUID(), name = `bff-local-${first}`;
  await request('', 'POST', { name }, 403, { authorization: 'Bearer wrong' });
  await request('', 'POST', { name }, 403, { origin: 'https://example.com' });
  await request('', 'POST', { name: '../../delta' }, 400);
  assert.deepEqual(await request(`?name=${name}`), []);
  const created = await Promise.all([request('', 'POST', { name }), request('', 'POST', { name })]);
  assert.deepEqual(created, [{ uuid: first }, { uuid: first }]);
  assert.deepEqual(await request(`?name=${name}`), [{ uuid: first, name }]);
  const query = (id, batch, status) => request(`/${id}/query`, 'POST', { batch }, status);
  await query(first, [{ sql: 'CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT UNIQUE)' },
    { sql: 'INSERT INTO notes(body) VALUES(?)', params: ["It's local"] }]);
  const result = await query(first, [{ sql: 'SELECT body FROM notes' }]);
  assert.deepEqual(result[0].results, [{ body: "It's local" }]);
  assert.equal(result[0].success, true);
  await query(first, [{ sql: 'INSERT INTO notes(body) VALUES(?)', params: ['rolled back'] },
    { sql: 'INSERT INTO notes(body) VALUES(?)', params: ["It's local"] }], 502);
  assert.deepEqual((await query(first, [{ sql: 'SELECT body FROM notes' }]))[0].results, [{ body: "It's local" }]);
  await request('', 'POST', { name: `bff-local-${second}` });
  await query(second, [{ sql: 'SELECT * FROM notes' }], 502);
  const config = JSON.parse(await readFile(join(statePath, 'bff', first, 'wrangler.jsonc'), 'utf8'));
  assert.equal(config.d1_databases[0].database_id, first);
  assert.equal(config.d1_databases[0].remote, false);
  await local.close();
  const cli = spawnSync(process.execPath, [resolveTool('wrangler', 'bin/wrangler.js'),
    'd1', 'execute', 'DB', '--local', '--config', join(statePath, 'bff', first, 'wrangler.jsonc'),
    '--persist-to', join(statePath, 'bff', first), '--command', 'SELECT body FROM notes', '--json'],
  { encoding: 'utf8', timeout: 20_000, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout)[0].results, [{ body: "It's local" }], 'Wrangler CLI must read the same persistent D1 data');
  local = await startBffLocal({ statePath });
  assert.deepEqual((await query(first, [{ sql: 'SELECT body FROM notes' }]))[0].results, [{ body: "It's local" }]);
  await request(`/${first}`, 'DELETE');
  await request(`/${first}`, 'DELETE');
  assert.deepEqual(await request(`?name=${name}`), []);
  await query(first, [{ sql: 'SELECT 1' }], 502);
  await request('', 'POST', { name });
  await query(first, [{ sql: 'SELECT * FROM notes' }], 502);
  await request(`/${second}`, 'DELETE');
});
