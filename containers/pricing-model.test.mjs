import test from 'node:test';
import assert from 'node:assert/strict';
import { MACHINE_SIZES, PLAN_DETAILS } from './plan-policy.js';

// Marginal published rates, checked 2026-10-05. Shared provider credits are
// deliberately excluded. This checks compute economics, not total gross margin.
const costPerHour = size => size.cpuVcpu * 0.072 + size.memoryMiB / 1024 * 0.009 + size.diskGB * 0.000252;
test('full CPU utilization remains within the subscription compute envelope for every size mix', () => {
  const worstCostPerUnit = Math.max(...MACHINE_SIZES.map(size => costPerHour(size) / size.computeUnits));
  for (const plan of Object.values(PLAN_DETAILS).filter(plan => !plan.features.usageBilling)) {
    const maximumCost = worstCostPerUnit * plan.limits.maxComputeUnitHours;
    assert.ok(maximumCost <= plan.price * 0.72, `${plan.name}: ${maximumCost}`);
    assert.ok(plan.limits.maxConcurrentComputeUnits >= 28, 'Every plan can run an XL');
  }
});
test('Small through XL stay below a 43% premium over equivalent competitor CPU/RAM at full Pro allowance', () => {
  const unitPrice = PLAN_DETAILS.pro.price / PLAN_DETAILS.pro.limits.maxComputeUnitHours;
  for (const size of MACHINE_SIZES.filter(size => size.id !== 'lite')) {
    const equivalent = size.cpuVcpu * 0.0504 + size.memoryMiB / 1024 * 0.0162;
    assert.ok(size.computeUnits * unitPrice <= equivalent * 1.43, size.id);
  }
});
