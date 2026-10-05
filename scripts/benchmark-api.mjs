import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Mainbrella } from '../sdk/javascript/index.js';
import { preflight, verifyAgent } from './verify-agent.mjs';

const percentile = (values, fraction) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
};
export async function benchmark(client, { samples = 5, concurrency = 1, catalogId = 'node', revision = null } = {}) {
  const { capabilities } = await preflight(client, { samples, concurrency, catalogId, managed: false });
  const report = { formatVersion: 1, startedAt: new Date().toISOString(), revision, apiVersion: capabilities.apiVersion,
    apiOrigin: client.baseUrl, catalogId, resource: capabilities.resources.length === 1 ? capabilities.resources[0] : null,
    region: null, runtime: process.version, samples, concurrency,
    methodology: 'Fresh account-owned generations through the public API. Create latency includes authentication, entitlement lookup, reservation, startup readiness, polling and transport. No provider cold-cache claim. Each sample checks foreground execution, binary write/read, and generation-specific cleanup. Nearest-rank percentiles over successful samples; all failures retained.',
    raw: new Array(samples), summary: null };
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < samples) {
      const index = next++;
      report.raw[index] = await verifyAgent(client, { catalogId, managed: false });
    }
  }));
  const passed = report.raw.filter(sample => sample.ok);
  const times = passed.map(sample => sample.timings.createMs);
  report.summary = { attempted: samples, succeeded: passed.length, failed: samples - passed.length,
    successRate: passed.length / samples, cleanupFailures: report.raw.filter(sample => sample.cleanup !== 'completed').length,
    createP50Ms: percentile(times, 0.5), createP95Ms: percentile(times, 0.95),
    execP50Ms: percentile(passed.map(sample => sample.timings.execMs), 0.5), execP95Ms: percentile(passed.map(sample => sample.timings.execMs), 0.95) };
  report.finishedAt = new Date().toISOString();
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = {};
    for (const arg of process.argv.slice(2)) {
      const match = /^--(samples|concurrency|output)=(.+)$/.exec(arg);
      if (!match || Object.hasOwn(options, match[1])) throw new Error('invalid_arguments');
      options[match[1]] = match[1] === 'output' ? match[2] : Number(match[2]);
    }
    let revision = null;
    try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' }).trim(); } catch {}
    const client = new Mainbrella({ apiKey: process.env.MAINBRELLA_API_KEY, baseUrl: process.env.MAINBRELLA_API_URL });
    const report = await benchmark(client, { ...options, revision, catalogId: process.env.MAINBRELLA_CATALOG_ID || 'node' });
    const output = resolve(options.output || `results/api-benchmark-${Date.now()}.json`);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ output, summary: report.summary }, null, 2));
    process.exitCode = report.summary.failed ? 1 : 0;
  } catch { console.error('Benchmark could not run. Use --samples=1..100, --concurrency=1..samples and --output=path with sufficient account budget.'); process.exitCode = 1; }
}
