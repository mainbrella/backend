import { readFileBytes } from '../../containers/file-contract.js';

export const MAX_METRIC_RANGE_MS = 24 * 3600_000;
export const MAX_METRIC_BUCKETS = 1441;
export const MAX_METRIC_RESPONSE_BYTES = 1024 * 1024;
export const METRIC_BUCKET_MS = 60_000;
export function metricsConfigured(env: Env) {
  return env.WORKLOAD_METRICS_ENABLED === 'true' && /^[a-f0-9]{32}$/.test(env.WORKLOAD_METRICS_ACCOUNT_ID ?? '')
    && Boolean(env.WORKLOAD_METRICS_TOKEN && env.USER_CONTAINER);
}
const query = `query WorkloadMetrics($accountTag: String, $from: Time, $to: Time, $label: String) {
  viewer { accounts(filter: {accountTag: $accountTag}) {
    containersMetricsAdaptiveGroups(limit: 1441, filter: {datetime_geq: $from, datetime_lt: $to, labels_has: $label}, orderBy: [datetimeMinute_ASC]) {
      dimensions { datetimeMinute generation: label(name: "mb_generation") }
      count sum { cpuTimeSec } max { memory diskUsage }
    }
  } }
}`;
export type MetricBucket = { at: string; samples: number; cpuSeconds: number | null; memoryPeakBytes: number | null; diskUsagePeak: number | null };
const numeric = (value: unknown) => value === null || value === undefined ? null
  : typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : (() => { throw new Error('metrics_unavailable'); })();
export function decodeMetrics(data: unknown, telemetryId: string, from: number, to: number): MetricBucket[] {
  const result = data as { errors?: unknown[]; data?: { viewer?: { accounts?: {containersMetricsAdaptiveGroups?: unknown[]}[] } } };
  if (!result || result.errors && (!Array.isArray(result.errors) || result.errors.length)
    || !Array.isArray(result.data?.viewer?.accounts) || result.data.viewer.accounts.length !== 1) throw new Error('metrics_unavailable');
  const rows = result.data.viewer.accounts[0].containersMetricsAdaptiveGroups;
  if (!Array.isArray(rows) || rows.length > MAX_METRIC_BUCKETS) throw new Error('metrics_unavailable');
  const seen = new Set<number>();
  return rows.map(value => {
    const row = value as { dimensions?: { datetimeMinute?: string; generation?: string }; count?: number;
      sum?: { cpuTimeSec?: number }; max?: { memory?: number; diskUsage?: number } };
    const at = Date.parse(row?.dimensions?.datetimeMinute ?? '');
    // Buckets can begin just before an unaligned requested start. The filter
    // still binds their samples to the requested half-open interval.
    if (row?.dimensions?.generation !== telemetryId || !Number.isSafeInteger(at) || at % METRIC_BUCKET_MS !== 0
      || at < Math.floor(from / METRIC_BUCKET_MS) * METRIC_BUCKET_MS || at >= to || seen.has(at)
      || !Number.isSafeInteger(row.count) || row.count! < 1) throw new Error('metrics_unavailable');
    seen.add(at);
    return { at: new Date(at).toISOString(), samples: row.count!, cpuSeconds: numeric(row.sum?.cpuTimeSec),
      memoryPeakBytes: numeric(row.max?.memory), diskUsagePeak: numeric(row.max?.diskUsage) };
  }).sort((a, b) => a.at.localeCompare(b.at));
}
export async function queryMetrics(env: Env, telemetryId: string, from: number, to: number, signal: AbortSignal): Promise<MetricBucket[]> {
  const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST', redirect: 'manual', signal: boundedSignal,
    headers: { Authorization: `Bearer ${env.WORKLOAD_METRICS_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query, variables: { accountTag: env.WORKLOAD_METRICS_ACCOUNT_ID, from: new Date(from).toISOString(),
      to: new Date(to).toISOString(), label: `mb_generation=${telemetryId}` } }),
  });
  if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new Error('metrics_unavailable'); }
  const bytes = await readFileBytes(response.body, MAX_METRIC_RESPONSE_BYTES, boundedSignal);
  return decodeMetrics(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), telemetryId, from, to);
}
