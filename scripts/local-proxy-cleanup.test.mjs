import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serialize } from 'node:v8';
import { DatabaseSync } from 'node:sqlite';
import { LocalProxyCleanup } from './local-proxy-cleanup.mjs';

const name = `workerd-mainbrella-containers-UserContainer-${'a'.repeat(64)}`;
const proxy = { ID: 'proxy-id', Names: `${name}-proxy`, Image: 'cloudflare/proxy-everything:3cb1195' };
function fixture({ record = { computeStoppedAt: 1 }, containers = [proxy], graceMs = 30_000 } = {}) {
  let state = containers;
  const removed = [];
  const cleanup = new LocalProxyCleanup({ statePath: '/checkout/.wrangler/state', workerName: 'mainbrella-containers',
    className: 'UserContainer', now: () => 100_000, graceMs, metadata: async () => record,
    runDocker: async args => {
      if (args[0] === 'ps') return state.map(c => JSON.stringify(c)).join('\n');
      assert.deepEqual(args.slice(0, 2), ['rm', '-f']);
      removed.push(args[2]);
      state = state.filter(c => c.ID !== args[2]);
      return '';
    } });
  return { cleanup, removed, setContainers(value) { state = value; } };
}

test('startup removes only stopped project proxies and leaves unrelated Docker resources', async () => {
  const f = fixture({ containers: [proxy,
    { ...proxy, ID: 'other-worker', Names: proxy.Names.replace('mainbrella-containers', 'other-worker') },
    { ...proxy, ID: 'other-image', Image: 'node:24' },
    { ID: 'unrelated', Names: 'database', Image: 'postgres:17' }] });
  assert.equal(await f.cleanup.sweep(), 1);
  assert.deepEqual(f.removed, ['proxy-id']);
});

test('unknown, running and recently stopped workload state prevents periodic cleanup', async () => {
  for (const record of [null, {}, { computeStoppedAt: 99_000 }, { computeStoppedAt: '1' }]) {
    const f = fixture({ record });
    assert.equal(await f.cleanup.sweep(), 0);
    assert.deepEqual(f.removed, []);
  }
});

test('a sibling app container is preserved during startup, polling and shutdown', async () => {
  for (const State of ['running', 'created', 'exited']) {
    const f = fixture({ containers: [proxy, { ID: 'app', Names: name, Image: 'node:24', State }] });
    assert.equal(await f.cleanup.sweep(), 0);
    assert.equal(await f.cleanup.sweep({ shutdown: true }), 0);
    assert.deepEqual(f.removed, []);
  }
});

test('shutdown cleans new session proxies even when Wrangler exits before recording the stop', async () => {
  const f = fixture({ containers: [], record: {} });
  await f.cleanup.sweep();
  f.setContainers([proxy]);
  assert.equal(await f.cleanup.sweep(), 0);
  assert.equal(await f.cleanup.sweep({ shutdown: true }), 1);
});

test('shutdown preserves preexisting proxies with active or unknown workload state', async () => {
  const f = fixture({ record: {} });
  assert.equal(await f.cleanup.sweep({ shutdown: true }), 0);
});

test('fresh state and Docker checks prevent removal when a workload restarts during inspection', async () => {
  const f = fixture();
  let reads = 0;
  f.cleanup.metadata = async () => ++reads === 1 ? { computeStoppedAt: 1 } : {};
  assert.equal(await f.cleanup.sweep(), 0);
  const g = fixture();
  g.cleanup.metadata = async () => {
    g.setContainers([proxy, { ID: 'app', Names: name, Image: 'node:24' }]);
    return { computeStoppedAt: 1 };
  };
  assert.equal(await g.cleanup.sweep(), 0);
});

test('real persisted SQLite/V8 state scopes cleanup to the selected checkout and supports repeated sweeps', async t => {
  const statePath = mkdtempSync(join(tmpdir(), 'local-proxy-cleanup-'));
  t.after(() => rmSync(statePath, { recursive: true, force: true }));
  const dir = join(statePath, 'v3', 'do', 'mainbrella-containers-UserContainer');
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, `${'a'.repeat(64)}.sqlite`));
  db.exec('CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB)');
  db.prepare('INSERT INTO _cf_KV VALUES (?, ?)').run('builderMachine', serialize({ computeStoppedAt: 1 }));
  db.close();
  const f = fixture();
  const cleanup = new LocalProxyCleanup({ statePath, workerName: 'mainbrella-containers', className: 'UserContainer',
    runDocker: f.cleanup.runDocker, now: () => 100_000 });
  assert.equal(await cleanup.sweep(), 1);
  assert.equal(await cleanup.sweep(), 0);
  assert.deepEqual(f.removed, ['proxy-id']);
});
