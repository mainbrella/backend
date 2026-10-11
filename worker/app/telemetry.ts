import { handleObservationRequest } from './observations';
import type { MetricBucket } from '../lib/workload-metrics';

const nanos = (iso: string) => (BigInt(Date.parse(iso)) * 1_000_000n).toString();
const attribute = (key: string, value: string) => ({ key, value: { stringValue: value } });
const resource = (id: string, createdAt: string) => ({ attributes: [
  attribute('service.name', 'mainbrella.sandbox'), attribute('container.id', id),
  attribute('mainbrella.container.created_at', createdAt),
] });
const scope = { name: 'com.mainbrella.lifecycle', version: '1' };
type LifecycleEvent = { id: string; sequence: number; occurredAt: string; type: string; reason?: string; size: string };

export function otlpLogs(id: string, createdAt: string, events: LifecycleEvent[]) {
  return { resourceLogs: [{ resource: resource(id, createdAt), scopeLogs: [{ scope, logRecords: events.map(event => ({
    timeUnixNano: nanos(event.occurredAt), severityNumber: event.type === 'failed' ? 17 : 9,
    severityText: event.type === 'failed' ? 'ERROR' : 'INFO', body: { stringValue: `container.${event.type}` },
    attributes: [attribute('event.name', `container.${event.type}`), attribute('event.id', event.id),
      { key: 'mainbrella.event.sequence', value: { intValue: String(event.sequence) } }, attribute('mainbrella.container.size', event.size),
      ...(event.reason ? [attribute('mainbrella.event.reason', event.reason)] : [])],
  })) }] }] };
}

export function otlpMetrics(data: { id: string; createdAt: string; from: string; to: string; bucketMs: number; buckets: MetricBucket[] }) {
  const point = (bucket: MetricBucket, value: number) => ({
    startTimeUnixNano: nanos(new Date(Math.max(Date.parse(data.from), Date.parse(bucket.at))).toISOString()),
    timeUnixNano: nanos(new Date(Math.min(Date.parse(data.to), Date.parse(bucket.at) + data.bucketMs)).toISOString()),
    // Adaptive sample counts are metadata, not a time-series identity.
    asDouble: value, attributes: [],
  });
  // Missing samples stay missing. Do not export diskUsagePeak with an invented unit.
  const cpu = data.buckets.filter(b => b.cpuSeconds !== null).map(b => point(b, b.cpuSeconds!));
  const memory = data.buckets.filter(b => b.memoryPeakBytes !== null).map(b => point(b, b.memoryPeakBytes!));
  return { resourceMetrics: [{ resource: resource(data.id, data.createdAt), scopeMetrics: [{
    scope: { name: 'com.mainbrella.workload', version: '1' }, metrics: [
      ...(cpu.length ? [{ name: 'mainbrella.container.cpu.time', unit: 's', description: 'Sampled CPU time per bucket',
        sum: { aggregationTemporality: 1, isMonotonic: true, dataPoints: cpu } }] : []),
      ...(memory.length ? [{ name: 'mainbrella.container.memory.peak', unit: 'By', description: 'Sampled memory peak per bucket',
        gauge: { dataPoints: memory } }] : []),
    ],
  }] }] };
}

export async function handleTelemetryRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url), logs = url.pathname === '/containers/telemetry/logs';
  url.pathname = logs ? '/containers/events' : '/containers/metrics';
  // Reuse the complete ownership, generation, CORS, range and availability checks.
  const response = await handleObservationRequest(new Request(url, request), env);
  if (!response.ok || request.method !== 'GET') return response;
  const headers = new Headers(response.headers);
  try {
    const data = await response.json() as any;
    if (logs) {
      headers.set('Mainbrella-Next-Cursor', String(data.nextCursor));
      headers.set('Mainbrella-Has-More', String(data.hasMore));
      headers.set('Mainbrella-History-Truncated', String(data.historyTruncated));
      headers.set('Access-Control-Expose-Headers', 'Mainbrella-Next-Cursor, Mainbrella-Has-More, Mainbrella-History-Truncated');
    } else {
      headers.set('Mainbrella-Metrics-State', data.state);
      headers.set('Access-Control-Expose-Headers', 'Mainbrella-Metrics-State');
    }
    return Response.json(logs ? otlpLogs(url.searchParams.get('id')!, url.searchParams.get('createdAt')!, data.events) : otlpMetrics(data), { headers });
  } catch { return Response.json({ error: 'telemetry_unavailable' }, { status: 503, headers }); }
}
