import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from './router';
import { otlpLogs, otlpMetrics } from './telemetry';
import { paidContainerFixture, USER_ONE, SESSION_ONE, SESSION_TWO, GENERATION_ONE } from './paid-container-test-helpers';

test('OTLP uses nanosecond strings, stable event IDs and ERROR severity for failures', () => {
  const payload = otlpLogs('small', GENERATION_ONE, [{ id: 'event', sequence: 7, occurredAt: GENERATION_ONE, type: 'failed', reason: 'startup_failed', size: 'lite' }]);
  const record = payload.resourceLogs[0].scopeLogs[0].logRecords[0];
  assert.equal(record.timeUnixNano, (BigInt(Date.parse(GENERATION_ONE)) * 1000000n).toString());
  assert.equal(record.severityNumber, 17);
  assert.ok(record.attributes.some(a => a.key === 'event.id' && 'stringValue' in a.value && a.value.stringValue === 'event'));
});

test('OTLP metrics preserve missing values, sampled delta intervals and omit unqualified disk units', () => {
  const data = { id: 'small', createdAt: GENERATION_ONE, from: '2026-10-05T12:00:30.000Z', to: '2026-10-05T12:01:30.000Z', bucketMs: 60000,
    buckets: [{ at: '2026-10-05T12:00:00.000Z', samples: 2, cpuSeconds: 0.5, memoryPeakBytes: null, diskUsagePeak: 12 },
      { at: '2026-10-05T12:01:00.000Z', samples: 3, cpuSeconds: null, memoryPeakBytes: 123, diskUsagePeak: 19 }] };
  const metrics = otlpMetrics(data).resourceMetrics[0].scopeMetrics[0].metrics;
  assert.equal(metrics.length, 2);
  const cpu = metrics[0].sum!; assert.equal(cpu.aggregationTemporality, 1); assert.equal(cpu.dataPoints.length, 1);
  assert.equal(cpu.dataPoints[0].startTimeUnixNano, (BigInt(Date.parse(data.from)) * 1000000n).toString());
  assert.equal(metrics[1].gauge!.dataPoints[0].timeUnixNano, (BigInt(Date.parse(data.to)) * 1000000n).toString());
  assert.deepEqual(otlpMetrics({ ...data, buckets: [] }).resourceMetrics[0].scopeMetrics[0].metrics, []);
});

test('OTLP exports reuse owner authorization, generation checks, pagination and metrics gate', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  f.setBillingMode('failure');
  f.env.USER_CONTAINER = { idFromName(name: string) { return name; }, get(name: string) { return { async fetch(req: Request) {
    if (name !== `user:${USER_ONE}` || req.headers.get('x-exec-created-at') !== GENERATION_ONE) return Response.json({ error: 'generation_not_found' }, { status: 404 });
    return Response.json({ events: [{ id: 'event', sequence: 3, occurredAt: GENERATION_ONE, type: 'started', size: 'lite' }], nextCursor: 3, hasMore: true, historyTruncated: true });
  } }; } } as unknown as DurableObjectNamespace;
  const request = (signal = 'logs', session = SESSION_ONE, extra = '') => new Request(`https://api.mainbrella.com/containers/telemetry/${signal}?id=small&createdAt=${GENERATION_ONE}${extra}`, { headers: { Cookie: `mainbrella_session=${session}` } });
  const result = await handleRequest(request(), f.env);
  assert.equal(result.status, 200); assert.equal(result.headers.get('Mainbrella-Next-Cursor'), '3');
  assert.equal(result.headers.get('Mainbrella-History-Truncated'), 'true'); assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.ok((await result.json() as any).resourceLogs);
  assert.equal((await handleRequest(request('logs', SESSION_TWO), f.env)).status, 404);
  assert.equal((await handleRequest(request('logs', ''), f.env)).status, 401);
  assert.equal((await handleRequest(request('logs', SESSION_ONE, '&cursor=1&cursor=2'), f.env)).status, 400);
  assert.equal((await handleRequest(request('metrics'), f.env)).status, 503);
  assert.equal((await handleRequest(new Request(request(), { method: 'POST' }), f.env)).status, 405);
});
