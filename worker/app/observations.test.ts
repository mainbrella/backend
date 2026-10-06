import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from './router';
import { decodeMetrics } from '../lib/workload-metrics';
import { paidContainerFixture, USER_ONE, SESSION_ONE, SESSION_TWO, GENERATION_ONE } from './paid-container-test-helpers';
const now = Date.parse('2026-10-05T12:35:00.000Z'), telemetryId = 'd688d42a-25ef-4c13-9b28-21a0fde6e163';
const request = (path: string, extra = '', headers = {}) => new Request(`https://api.mainbrella.com/containers/${path}?id=small&createdAt=${GENERATION_ONE}${extra}`,
  { headers: { Cookie: `mainbrella_session=${SESSION_ONE}`, ...headers } });
const metricData = (rows: object[]) => ({ data: { viewer: { accounts: [{ containersMetricsAdaptiveGroups: rows }] } }, errors: null });
const row = { dimensions: { datetimeMinute: '2026-10-05T12:01:00Z', generation: telemetryId }, count: 3, sum: { cpuTimeSec: 0.75 }, max: { memory: 1048576, diskUsage: 123 } };
async function fixture(t: Parameters<typeof paidContainerFixture>[0]) {
  t.mock.method(Date, 'now', () => now);
  const f = await paidContainerFixture(t); t.after(() => f.close());
  f.env.WORKLOAD_METRICS_ENABLED = 'true'; f.env.WORKLOAD_METRICS_ACCOUNT_ID = 'a'.repeat(32); f.env.WORKLOAD_METRICS_TOKEN = 'private-analytics-token';
  const calls: Request[] = [];
  f.env.USER_CONTAINER = { idFromName(name: string) { f.machineNames.push(name); return name; }, get(name: string) { return { async fetch(req: Request) {
    calls.push(req);
    if (name !== 'user:' + USER_ONE || req.headers.get('x-exec-created-at') !== GENERATION_ONE) return Response.json({ error: 'generation_not_found' }, { status: 404 });
    if (new URL(req.url).pathname.endsWith('/identity')) return Response.json({ createdAt: GENERATION_ONE, telemetryId, endsAt: now });
    return Response.json({ events: [{ id: crypto.randomUUID(), sequence: 1, createdAt: GENERATION_ONE, type: 'started' }], nextCursor: 1, hasMore: false, historyTruncated: false, retainForMs: 604800000 });
  } }; } } as unknown as DurableObjectNamespace;
  return { ...f, calls };
}

test('owned lifecycle reads remain available during billing outages and strip untrusted forwarding', async t => {
  const f = await fixture(t); f.setBillingMode('failure');
  const response = await handleRequest(request('events', '&cursor=0&limit=1', { 'x-exec-created-at': 'victim', 'x-user-id': 'victim' }), f.env);
  assert.equal(response.status, 200); assert.equal((await response.json() as { events: unknown[] }).events.length, 1);
  assert.equal(f.calls[0].headers.get('x-exec-created-at'), GENERATION_ONE); assert.equal(f.calls[0].headers.get('cookie'), null);
  assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(f.accountCalls.length, 0);
  assert.equal((await handleRequest(request('events', '', { Cookie: `mainbrella_session=${SESSION_TWO}` }), f.env)).status, 404);
  assert.equal((await handleRequest(request('events', '', { Cookie: '' }), f.env)).status, 401);
  for (const suffix of ['&cursor=-1', '&limit=101', '&cursor=1&cursor=2', '&unknown=x']) assert.equal((await handleRequest(request('events', suffix), f.env)).status, 400);
  assert.equal((await handleRequest(new Request(request('events'), { method: 'POST' }), f.env)).status, 405);
});

test('metric queries filter provider identity, bound generation/time and never expose control-plane credentials', async t => {
  const f = await fixture(t); let queries = 0;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, options?: RequestInit) => {
    queries++; assert.equal(String(input), 'https://api.cloudflare.com/client/v4/graphql');
    assert.equal((options?.headers as Record<string, string>).Authorization, 'Bearer private-analytics-token'); assert.equal(options?.redirect, 'manual');
    const body = JSON.parse(options!.body as string); assert.equal(body.variables.label, `mb_generation=${telemetryId}`);
    assert.equal(body.variables.from, GENERATION_ONE); assert.equal(body.variables.to, new Date(now).toISOString());
    assert.match(body.query, /datetime_lt/); return Response.json(metricData([row]));
  });
  const response = await handleRequest(request('metrics'), f.env); assert.equal(response.status, 200);
  const value = await response.json() as { state: string; buckets: object[] };
  assert.equal(value.state, 'observed'); assert.deepEqual(value.buckets, [{ at: '2026-10-05T12:01:00.000Z', samples: 3, cpuSeconds: 0.75, memoryPeakBytes: 1048576, diskUsagePeak: 123 }]);
  assert.ok(!JSON.stringify(value).includes(telemetryId)); assert.ok(!JSON.stringify(value).includes('private')); assert.equal(queries, 1);
  for (const suffix of ['&from=2026-10-05T11%3A00%3A00.000Z', '&to=2099-01-01T00%3A00%3A00.000Z', '&from=bad', '&from=2026-10-05T12%3A00%3A00.000Z&from=x']) assert.equal((await handleRequest(request('metrics', suffix), f.env)).status, 400);
  assert.equal(queries, 1);
  f.env.WORKLOAD_METRICS_ENABLED = 'false'; assert.equal((await handleRequest(request('metrics'), f.env)).status, 503); assert.equal(queries, 1);
});

test('empty and legacy metric evidence stays unobserved; malformed, cross-generation and partial results fail closed', async t => {
  const f = await fixture(t);
  let result: unknown = metricData([]);
  t.mock.method(globalThis, 'fetch', async () => Response.json(result));
  assert.equal((await (await handleRequest(request('metrics'), f.env)).json() as { state: string }).state, 'unobserved');
  for (const data of [metricData([{ ...row, dimensions: { ...row.dimensions, generation: 'foreign' } }]), metricData([{ ...row, count: 0 }]),
    metricData([{ ...row, sum: { cpuTimeSec: -1 } }]), metricData([row, row]), { ...metricData([row]), errors: [{ message: 'private' }] },
    { data: { viewer: { accounts: [] } } }, metricData([{ ...row, dimensions: { ...row.dimensions, datetimeMinute: '2099-01-01T00:00:00Z' } }])]) {
    result = data; const response = await handleRequest(request('metrics'), f.env); assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'metrics_unavailable' });
  }
  assert.deepEqual(decodeMetrics(metricData([{ ...row, sum: {}, max: {} }]), telemetryId, Date.parse(GENERATION_ONE), now)[0],
    { at: '2026-10-05T12:01:00.000Z', samples: 3, cpuSeconds: null, memoryPeakBytes: null, diskUsagePeak: null });
  f.env.USER_CONTAINER = { idFromName() { return 'owned'; }, get() { return { fetch: async () => Response.json({ createdAt: GENERATION_ONE, endsAt: now }) }; } } as unknown as DurableObjectNamespace;
  let calls = 0; t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({}); });
  const response = await handleRequest(request('metrics'), f.env); assert.equal(response.status, 200); assert.equal(calls, 0);
  assert.equal((await response.json() as { state: string }).state, 'unobserved');
});

test('provider redirects fail closed without sending the analytics credential to another destination', async t => {
  const f = await fixture(t); let calls = 0;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, options?: RequestInit) => {
    calls++; assert.equal(String(input), 'https://api.cloudflare.com/client/v4/graphql');
    assert.equal(options?.redirect, 'manual');
    return new Response(null, { status: 302, headers: { Location: 'https://foreign.example/collect' } });
  });
  const response = await handleRequest(request('metrics'), f.env);
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'metrics_unavailable' }); assert.equal(calls, 1);
});
