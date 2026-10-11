import assert from 'node:assert/strict';
import test from 'node:test';
import { imageCacheHit, qualifyImageBuild } from './qualify-image-build.mjs';

function fixture({ cacheHit = true, lostBuildReply = false, lostCreateReply = false } = {}) {
  const records = [], snapshots = [], creates = [], deleted = [];
  let alive = false, ticks = 0;
  const client = {
    images: {
      async list() { return { images: records, buildsEnabled: true, privateRegistriesEnabled: true,
        limits: { maxBuildsPerMonth: 10, maxSavedImages: 3 }, usage: { builds: 0 } }; },
      async create(options) {
        creates.push(options);
        const image = { id: `image-${creates.length}`, name: options.name, status: 'ready', digest: 'sha256:' + 'a'.repeat(64) };
        records.push(image);
        if (lostBuildReply) throw new Error('secret-sensitive-message');
        return { image };
      },
      async get(id) { return { image: records.find(image => image.id === id) }; },
      async logs() { return { logs: "#5 [2/2] RUN mkdir -p /workspace && printf 'mainbrella-image-qualified' > /workspace/.mainbrella-image-qualification\n#5 " + (cacheHit ? 'CACHED' : 'DONE 0.1s') }; },
      async delete(id) { deleted.push(id); },
    },
    async create() {
      if (lostCreateReply) throw new Error('ambiguous start');
      alive = true;
      return { id: 'c1', createdAt: '2026-10-11T00:00:00.000Z',
        commands: { async run() { return { exitCode: 0, stdout: 'mainbrella-image-qualified' }; } },
        async kill() { alive = false; } };
    },
    async list() { return { containers: alive ? [{ id: 'c1', createdAt: '2026-10-11T00:00:00.000Z' }] : [] }; },
  };
  const options = { checkpoint: async report => snapshots.push(report), preflight: async () => {}, now: () => ticks += 100, sleep: async () => {} };
  return { client, options, creates, deleted, snapshots };
}

test('image qualification bounds builds, checks the exact cached RUN and cleans exact generations', async () => {
  const f = fixture();
  const report = await qualifyImageBuild(f.client, f.options);
  assert.equal(report.ok, true);
  assert.equal(f.creates.length, 2);
  assert.equal(f.creates[1].cacheFrom, 'image-1');
  assert.deepEqual(f.deleted, ['image-1', 'image-2']);
  assert.ok(f.snapshots.some(snapshot => snapshot.builds[0]?.state === 'request_pending' && !snapshot.builds[0]?.id));
  assert.ok(f.snapshots.some(snapshot => snapshot.creationKey && !snapshot.container));
  assert.equal(imageCacheHit('#4 [1/2] FROM base\n#4 CACHED'), false);
});

test('cache miss fails qualification while still cleaning created images', async () => {
  const f = fixture({ cacheHit: false });
  const report = await qualifyImageBuild(f.client, f.options);
  assert.equal(report.ok, false);
  assert.equal(report.error, 'cache_failed');
  assert.equal(report.cleanup, 'completed');
  assert.equal(report.creationKey, undefined);
});

test('lost build reply is not retried and is reconciled by its pre-recorded unique name', async () => {
  const f = fixture({ lostBuildReply: true });
  const report = await qualifyImageBuild(f.client, f.options);
  assert.equal(f.creates.length, 1);
  assert.equal(report.ok, false);
  assert.equal(report.cleanup, 'completed');
  assert.equal(report.builds[0].id, 'image-1');
  assert.doesNotMatch(JSON.stringify(f.snapshots), /secret-sensitive-message/);
});

test('ambiguous container start preserves its key and images for manual reconciliation', async () => {
  const f = fixture({ lostCreateReply: true });
  const report = await qualifyImageBuild(f.client, f.options);
  assert.equal(report.cleanup, 'reconcile_manually');
  assert.ok(report.creationKey);
  assert.deepEqual(f.deleted, []);
});

test('unavailable builds consume no build or sandbox budget', async () => {
  const f = fixture();
  f.client.images.list = async () => ({ buildsEnabled: false });
  const report = await qualifyImageBuild(f.client, f.options);
  assert.equal(report.error, 'preflight_failed');
  assert.deepEqual(f.creates, []);
});
