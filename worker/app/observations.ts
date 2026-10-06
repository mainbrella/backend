import { authCorsHeaders, authJson } from './auth-core';
import { containerUser } from './container-auth';
import { machineName, validContainerId } from '../../containers/container-account-core.js';
import { MAX_EVENT_PAGE, OBSERVATION_RETENTION_MS } from '../../containers/observations.js';
import { MAX_METRIC_RANGE_MS, METRIC_BUCKET_MS, metricsConfigured, queryMetrics } from '../lib/workload-metrics';
import { readFileBytes } from '../../containers/file-contract.js';

const iso = (value: string | null) => Boolean(value && value.length <= 32 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
export async function handleObservationRequest(request: Request, env: Env): Promise<Response> {
  const cors = authCorsHeaders(request);
  if (cors === null) return authJson({ error: 'origin_not_allowed' }, 403, {});
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'GET') return authJson({ error: 'method_not_allowed' }, 405, { ...cors, allow: 'GET, OPTIONS' });
  const url = new URL(request.url), metrics = url.pathname === '/containers/metrics';
  if (!metrics && url.pathname !== '/containers/events') return authJson({ error: 'not_found' }, 404, cors);
  const allowed = metrics ? ['id', 'createdAt', 'from', 'to'] : ['id', 'createdAt', 'cursor', 'limit'];
  const id = url.searchParams.get('id'), createdAt = url.searchParams.get('createdAt');
  if ([...url.searchParams.keys()].some(key => !allowed.includes(key) || url.searchParams.getAll(key).length !== 1)
    || !id || !validContainerId(id)) return authJson({ error: 'invalid_request' }, 400, cors);
  if (!iso(createdAt)) return authJson({ error: 'invalid_generation' }, 400, cors);
  const cursor = url.searchParams.get('cursor') ?? '0', limit = url.searchParams.get('limit') ?? '100';
  if (!metrics && (!/^\d+$/.test(cursor) || !Number.isSafeInteger(Number(cursor)) || !/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > MAX_EVENT_PAGE)) return authJson({ error: 'invalid_request' }, 400, cors);
  for (const key of ['from', 'to']) if (metrics && url.searchParams.has(key) && !iso(url.searchParams.get(key))) return authJson({ error: 'invalid_request' }, 400, cors);
  try {
    const user = await containerUser(env, request);
    if (!user) return authJson({ error: 'not_authenticated' }, 401, cors);
    if (!env.USER_CONTAINER || metrics && !metricsConfigured(env)) return authJson({ error: metrics ? 'metrics_not_configured' : 'events_unavailable' }, 503, cors);
    const internal = new URL(`https://internal/observations/${metrics ? 'identity' : 'events'}`);
    if (!metrics) { internal.searchParams.set('cursor', cursor); internal.searchParams.set('limit', limit); }
    const stub = env.USER_CONTAINER.get(env.USER_CONTAINER.idFromName(machineName(user.id, id)));
    const response = await stub.fetch(new Request(internal, { headers: { 'x-exec-created-at': createdAt! }, signal: request.signal }));
    const bytes = await readFileBytes(response.body, 128 * 1024, request.signal);
    const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!response.ok) {
      if ([400, 404].includes(response.status) && ['generation_not_found', 'invalid_cursor', 'invalid_request'].includes(data?.error)) return authJson({ error: data.error }, response.status, cors);
      throw new Error('observations_unavailable');
    }
    if (!metrics) return authJson(data, 200, cors);
    if (data.createdAt !== createdAt || !Number.isSafeInteger(data.endsAt)) throw new Error('metrics_unavailable');
    const now = Date.now();
    const to = url.searchParams.has('to') ? Date.parse(url.searchParams.get('to')!) : Math.min(now, data.endsAt);
    const from = url.searchParams.has('from') ? Date.parse(url.searchParams.get('from')!) : Math.max(Date.parse(createdAt!), to - 3600_000);
    if (from < Date.parse(createdAt!) || from < now - OBSERVATION_RETENTION_MS || to > now || to > data.endsAt
      || to < from || to - from > MAX_METRIC_RANGE_MS) return authJson({ error: 'invalid_metric_range' }, 400, cors);
    const available = typeof data.telemetryId === 'string' && /^[a-f0-9-]{36}$/.test(data.telemetryId);
    const buckets = available && to > from ? await queryMetrics(env, data.telemetryId, from, to, request.signal) : [];
    return authJson({ id, createdAt, from: new Date(from).toISOString(), to: new Date(to).toISOString(), bucketMs: METRIC_BUCKET_MS,
      source: 'cloudflare-workload-analytics', state: buckets.length ? 'observed' : 'unobserved', buckets }, 200, cors);
  } catch { return authJson({ error: metrics ? 'metrics_unavailable' : 'events_unavailable' }, 503, cors); }
}
