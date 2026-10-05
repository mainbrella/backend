import test from 'node:test';
import assert from 'node:assert/strict';
import { benchmark } from './benchmark-api.mjs';
import { verifyAgent } from './verify-agent.mjs';

function fixture({ failedExec = false, failedCleanup = false, ambiguous = false } = {}) {
  const created = [], killed = [];
  let active = 0, peak = 0;
  const client = {
    baseUrl: 'http://localhost:8787',
    async capabilities() { return { apiVersion: 'test', resources: [{ instance: 'lite' }], execution: { foreground: true, background: true, streaming: true }, files: { read: true, write: true } }; },
    async list() { return { active: true, containers: [{ id: 'existing' }], imageCatalog: [{ id: 'node' }], limits: { maxContainers: 4, maxStartsPerMonth: 10 }, usage: { starts: 0 } }; },
    async create({ idempotencyKey }) {
      created.push(idempotencyKey);
      if (ambiguous) throw Object.assign(new Error(), { code: 'creation_ambiguous' });
      active++; peak = Math.max(peak, active);
      let stored;
      return { id: idempotencyKey, createdAt: '2026-10-05T12:00:00.000Z',
        commands: { async run() { await new Promise(resolve => setTimeout(resolve, 1)); return { stdout: failedExec ? 'wrong' : 'mainbrella-probe', exitCode: 0 }; } },
        files: { async write(path, bytes) { stored = bytes; }, async read() { return stored; } },
        async kill() { killed.push(idempotencyKey); active--; if (failedCleanup) throw new Error(); } };
    },
  };
  return { client, created, killed, get peak() { return peak; } };
}
test('benchmark enforces start/concurrency budgets and reports all raw results with bounded fanout', async () => {
  const f = fixture();
  const report = await benchmark(f.client, { samples: 5, concurrency: 2 });
  assert.equal(f.peak, 2); assert.equal(f.created.length, 5); assert.deepEqual(new Set(f.killed), new Set(f.created));
  assert.equal(report.raw.length, 5); assert.equal(report.summary.succeeded, 5); assert.equal(report.region, null);
  assert.ok(report.summary.createP95Ms >= report.summary.createP50Ms);
  await assert.rejects(benchmark(f.client, { samples: 11 }), /insufficient_start_budget/);
  await assert.rejects(benchmark(f.client, { samples: 5, concurrency: 4 }), /insufficient_concurrency/);
});
test('probe cleans up only its own generation and keeps failed/ambiguous cleanup in results', async () => {
  const f = fixture({ failedExec: true });
  const result = await verifyAgent(f.client, { managed: false });
  assert.equal(result.ok, false); assert.equal(result.cleanup, 'completed'); assert.equal(f.killed.length, 1);
  const failed = await verifyAgent(fixture({ failedCleanup: true }).client, { managed: false });
  assert.equal(failed.ok, false); assert.equal(failed.cleanup, 'failed');
  const ambiguous = await verifyAgent(fixture({ ambiguous: true }).client, { managed: false });
  assert.equal(ambiguous.cleanup, 'reconcile_manually'); assert.ok(ambiguous.creationKey);
});
