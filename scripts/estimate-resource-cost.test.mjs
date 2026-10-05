import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateResourceCost } from './estimate-resource-cost.mjs';

test('cost estimate scales provisioned memory/disk by runtime and CPU by active usage', () => {
  const report = estimateResourceCost({ containers: 10, cpuSeconds: 30, memoryMiB: 4096, diskGB: 8, runningSeconds: 600,
    rates: { cpuPerVcpuSecond: 0.00002, memoryPerGiBSecond: 0.0000025, diskPerGBSecond: 0.00000007 }, egressGB: 1, egressPerGB: 0.025 });
  assert.ok(Math.abs(report.resourceCost.cpu - 0.006) < 1e-12);
  assert.ok(Math.abs(report.resourceCost.memory - 0.06) < 1e-12);
  assert.ok(Math.abs(report.resourceCost.disk - 0.00336) < 1e-12);
  assert.equal(report.resourceCost.egress, 0.025);
  assert.ok(Math.abs(report.resourceCost.total - 0.09436) < 1e-12);
  assert.ok(report.exclusions.includes('included allowances'));
});

test('cost estimates require explicit finite rates and whole container counts', () => {
  const inputs = { cpuSeconds: 0, memoryMiB: 256, diskGB: 2, runningSeconds: 60,
    rates: { cpuPerVcpuSecond: 0, memoryPerGiBSecond: 0, diskPerGBSecond: 0 } };
  for (const change of [{ rates: undefined }, { containers: 1.5 }, { runningSeconds: Infinity }, { cpuSeconds: -1 }]) {
    assert.throws(() => estimateResourceCost({ ...inputs, ...change }), /invalid_cost_inputs/);
  }
});
