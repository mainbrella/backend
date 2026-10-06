import test from 'node:test';
import assert from 'node:assert/strict';
import { metricsProviderEvidence, parseMetricsArgs } from './qualify-workload-metrics';

const ids = ['fff3a3c1-b079-4f29-8d24-d4aee6c57252', '855de86e-ebf4-4faf-a8a7-003a12b18551'];
const from = Date.parse('2026-10-05T00:00:00.000Z'), to = from + 3600_000;
const schema = { dimensions: { fields: [{ name: 'label', args: [{ name: 'name' }] }, { name: 'datetimeMinute' }] },
  maximum: { fields: [{ name: 'memory', description: 'Maximum memory usage' }, { name: 'diskUsage', description: 'Disk usage, in bytes' }] },
  total: { fields: [{ name: 'cpuTimeSec', description: 'Sum of CPU time in seconds' }] }, groups: { fields: [{ name: 'count', description: 'Number of metrics received' }] } };
const bucket = { at: new Date(from).toISOString(), samples: 2, cpuSeconds: 0.1, memoryPeakBytes: 10, diskUsagePeak: 2 };
function options(patch: Record<string, unknown> = {}) {
  return { accountId: 'a'.repeat(32), credential: 'operator-session', from, to,
    graphql: async (query: string) => query.includes('WorkloadSchema') ? { data: schema }
      : { data: { viewer: { accounts: [{ containersMetricsAdaptiveGroups: ids.map(generation => ({ dimensions: { generation } })) }] } } },
    sample: async (id: string) => ids.includes(id) ? [bucket] : [], ...patch };
}

test('read-only evidence uses two historical identities, proves absent-label filtering, and retains rollout gates', async () => {
  const calls: string[] = [];
  const report = await metricsProviderEvidence(options({ sample: async (id: string) => { calls.push(id); return ids.includes(id) ? [bucket] : []; } }));
  assert.equal(report.ok, true);
  assert.equal(report.releaseQualified, false);
  assert.equal(report.startsConsumed, 0);
  assert.equal(report.providerWrites, 0);
  assert.deepEqual(calls.slice(0, 2), ids);
  assert.equal(calls.length, 3);
  assert.equal(report.generations.length, 2);
  assert.equal(report.pendingGates.includes('dedicated_account_analytics_token'), true);
  for (const id of ids) assert.equal(JSON.stringify(report).includes(id), false);
});

test('partial schema, missing histories, provider errors and unexpected absent-label data fail the gate', async () => {
  for (const patch of [
    { graphql: async () => ({ data: {} }) },
    { sample: async () => [] },
    { sample: async () => { throw new Error('private-token-provider-message'); } },
    { sample: async () => [bucket] },
  ]) {
    const report = await metricsProviderEvidence(options(patch));
    assert.equal(report.ok, false);
    assert.equal(report.releaseQualified, false);
    assert.equal(JSON.stringify(report).includes('private-token-provider-message'), false);
  }
});

test('dedicated credential evidence still requires deployed customer isolation and fresh-ingestion qualification', async () => {
  const report = await metricsProviderEvidence(options({ credential: 'analytics-token' }));
  assert.equal(report.ok, true);
  assert.equal(report.pendingGates.includes('dedicated_account_analytics_token'), false);
  assert.equal(report.releaseQualified, false);
  assert.equal(report.pendingGates.includes('fresh_generation_ingestion_delay'), true);
});

test('arguments require a new output destination and bound canonical ranges and credential modes', () => {
  assert.equal(parseMetricsArgs(['--output=/tmp/metrics-check']).credential, 'analytics-token');
  assert.equal(parseMetricsArgs(['--output=/tmp/metrics-check', '--credential=operator-session']).credential, 'operator-session');
  for (const args of [[], ['--output=x', '--output=y'], ['--output=x', '--credential=other'], ['--output=x', '--unknown=1'],
    ['--output=x', '--from=bad'], ['--output=x', '--from=2026-10-01T00:00:00.000Z', '--to=2026-10-03T00:00:00.000Z'],
    ['--output=x', '--to=2099-01-01T00:00:00.000Z']]) assert.throws(() => parseMetricsArgs(args));
});
