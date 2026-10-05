import test from 'node:test';
import assert from 'node:assert/strict';
import { probeRuntime } from './runtime-probe.js';

function fixture({ badRestore = false, cleanupFails = false } = {}) {
  const values = new Map(), starts = [];
  let commands = 0, alarm;
  const ctx = { storage: { async get(k) { return values.get(k); }, async put(k,v) { values.set(k,v); }, async setAlarm(value) { alarm = value; }, async deleteAlarm() { alarm = undefined; } },
    container: { running: false, images: { terminal: 'registry/image@sha256:' + 'a'.repeat(64) },
      start(options) { starts.push(options); this.running = true; }, async setInactivityTimeout() {},
      async snapshotContainer() { return { id: 'opaque-snapshot', size: 4096 }; },
      async destroy() { if (cleanupFails) throw new Error(); this.running = false; },
      async exec() {
        commands++;
        return { exitCode: Promise.resolve(0), async output() { return { exitCode: 0, stdout: commands === 1 ? 'v24' : commands === 2 ? 'a'.repeat(64) : badRestore ? 'mismatch' : 'verified' }; }, kill() { throw new Error('exited process must not be signaled'); } };
      } } };
  return { ctx, values, starts, get alarm() { return alarm; } };
}
test('isolated resource/snapshot probe restores verified files and cleans up without boot fallback', async () => {
  const f = fixture();
  const result = await probeRuntime(f.ctx, { instance: 'standard-2' });
  assert.equal(result.ok, true); assert.equal(result.filesystemRestored, true); assert.equal(result.cleanup, 'completed');
  assert.equal(f.starts.length, 2); assert.equal(f.starts[1].containerSnapshot.id, 'opaque-snapshot');
  assert.equal(f.starts[1].image, undefined); assert.equal(f.starts[0].enableInternet, false); assert.equal(f.alarm, undefined);
  await assert.rejects(probeRuntime(f.ctx), /probe_already_used/);
});
test('mismatched restore and failed cleanup remain explicit failures', async () => {
  const mismatch = fixture({ badRestore: true });
  const result = await probeRuntime(mismatch.ctx);
  assert.equal(result.ok, false); assert.equal(result.error, 'restore_failed'); assert.equal(mismatch.starts.length, 2);
  const failed = fixture({ cleanupFails: true });
  assert.equal((await probeRuntime(failed.ctx, { snapshot: false })).cleanup, 'failed');
  assert.ok(failed.alarm);
  await assert.rejects(probeRuntime(fixture().ctx, { instance: 'unbounded-size' }), /invalid_probe_options/);
});
