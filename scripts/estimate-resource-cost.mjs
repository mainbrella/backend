import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Gross marginal resource cost, before included allowances. Rates are explicit
// inputs so estimates cannot silently rely on an outdated provider price table.
export function estimateResourceCost({ cpuSeconds, memoryMiB, diskGB, runningSeconds, containers = 1,
  rates, egressGB = 0, egressPerGB = 0 }) {
  const values = [cpuSeconds, memoryMiB, diskGB, runningSeconds, containers, rates?.cpuPerVcpuSecond,
    rates?.memoryPerGiBSecond, rates?.diskPerGBSecond, egressGB, egressPerGB];
  if (values.some(value => !Number.isFinite(value) || value < 0) || !Number.isInteger(containers) || containers < 1) throw new Error('invalid_cost_inputs');
  const cpu = containers * cpuSeconds * rates.cpuPerVcpuSecond;
  const memory = containers * memoryMiB / 1024 * runningSeconds * rates.memoryPerGiBSecond;
  const disk = containers * diskGB * runningSeconds * rates.diskPerGBSecond;
  const egress = egressGB * egressPerGB;
  return { currency: 'USD', resourceCost: { cpu, memory, disk, egress, total: cpu + memory + disk + egress },
    assumptions: { cpuSecondsPerContainer: cpuSeconds, memoryMiBPerContainer: memoryMiB, diskGBPerContainer: diskGB,
      runningSecondsPerContainer: runningSeconds, containers, rates, egressGBTotal: egressGB, egressPerGB },
    exclusions: ['included allowances', 'Workers', 'Durable Objects', 'D1', 'logs', 'builds', 'registry', 'snapshots', 'support'] };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2) throw new Error('invalid_arguments');
    let input = '';
    for await (const chunk of process.stdin) { input += chunk; if (input.length > 16_384) throw new Error('input_too_large'); }
    console.log(JSON.stringify(estimateResourceCost(JSON.parse(input)), null, 2));
  } catch { console.error('Supply bounded JSON cost inputs on stdin, including explicit resource rates.'); process.exitCode = 1; }
}
