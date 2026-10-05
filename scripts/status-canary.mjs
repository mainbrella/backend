import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Mainbrella } from '../sdk/javascript/index.js';
import { preflight, verifyAgent } from './verify-agent.mjs';

export async function statusCanary(client, options = {}) {
  await preflight(client, { ...options, samples: 1, concurrency: 1 });
  const report = await verifyAgent(client, options);
  return { report, observations: [{ component: 'provisioning', state: report.ok ? 'operational' : 'degraded',
    scope: 'synthetic', ...(report.timings.createMs ? { latencyMs: Math.round(report.timings.createMs) } : {}) }] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2 || !process.env.MONITORING_SECRET) throw new Error('invalid_configuration');
    const client = new Mainbrella({ apiKey: process.env.MAINBRELLA_API_KEY, baseUrl: process.env.MAINBRELLA_API_URL });
    const { report, observations } = await statusCanary(client, { catalogId: process.env.MAINBRELLA_CATALOG_ID || 'node' });
    const response = await fetch(new URL('/internal/status/observations', client.baseUrl), {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.MONITORING_SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ observations }), redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error('status_reporting_failed');
    console.log(JSON.stringify(report, null, 2)); process.exitCode = report.ok ? 0 : 1;
  } catch { console.error('Canary could not run or report. Check the dedicated account budget and monitoring configuration.'); process.exitCode = 1; }
}
