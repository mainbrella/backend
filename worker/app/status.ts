import { z } from 'zod';
import { authCorsHeaders, authJson, hashToken } from './auth-core';
import { readCommandBody } from '../../containers/command-contract.js';

export const STATUS_COMPONENTS = ['website', 'api', 'auth', 'provisioning', 'ssh', 'images', 'billing'] as const;
export const STATUS_STALE_MS = 15 * 60_000;
export const observationInput = z.object({ component: z.enum(STATUS_COMPONENTS), state: z.enum(['operational', 'degraded', 'outage', 'unknown']),
  scope: z.enum(['reachability', 'control_plane', 'synthetic']), latencyMs: z.number().int().min(0).max(300_000).optional() }).strict();
export const incidentInput = z.object({ id: z.uuid(), component: z.enum(STATUS_COMPONENTS), title: z.string().trim().min(1).max(160),
  state: z.enum(['investigating', 'identified', 'monitoring', 'resolved']), message: z.string().trim().min(1).max(2000) }).strict();
type ObservationRow = { id: number; component: string; state: string; scope: string; latency_ms: number | null; checked_at: string };
const publicObservation = (row: ObservationRow) => ({ id: row.id, component: row.component, state: row.state, scope: row.scope,
  latencyMs: row.latency_ms, checkedAt: row.checked_at });
type Observation = z.infer<typeof observationInput>;

export async function recordObservations(env: Env, observations: Observation[], now = new Date()) {
  await env.DB.batch(observations.map(item => env.DB.prepare(
    'INSERT INTO status_observations (component, state, scope, latency_ms, checked_at) VALUES (?, ?, ?, ?, ?)')
    .bind(item.component, item.state, item.scope, item.latencyMs ?? null, now.toISOString())));
}

export async function handleStatusRequest(request: Request, env: Env): Promise<Response> {
  const cors = authCorsHeaders(request);
  if (cors === null) return authJson({ error: 'origin_not_allowed' }, 403, {});
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const url = new URL(request.url), internal = url.pathname.startsWith('/internal/status/');
  if (request.method !== (internal ? 'POST' : 'GET')) return authJson({ error: 'method_not_allowed' }, 405, { ...cors, allow: internal ? 'POST, OPTIONS' : 'GET, OPTIONS' });
  if (internal && (!env.MONITORING_SECRET || await hashToken(request.headers.get('Authorization') ?? '') !== await hashToken(`Bearer ${env.MONITORING_SECRET}`))) {
    return authJson({ error: 'not_authenticated' }, 401, cors);
  }
  const allowed = url.pathname === '/status/history' ? ['before', 'beforeId', 'component'] : [];
  if ([...url.searchParams.keys()].some(key => !allowed.includes(key) || url.searchParams.getAll(key).length !== 1)) return authJson({ error: 'invalid_request' }, 400, cors);
  try {
    if (!env.DB) throw new Error('database_unavailable');
    const now = new Date();
    if (url.pathname === '/internal/status/observations') {
      const parsed = z.object({ observations: z.array(observationInput).min(1).max(7) }).strict().safeParse(await readCommandBody(request).catch(() => null));
      if (!parsed.success || new Set(parsed.data.observations.map(o => o.component)).size !== parsed.data.observations.length) return authJson({ error: 'invalid_request' }, 400, cors);
      await recordObservations(env, parsed.data.observations, now);
      return authJson({ ok: true, checkedAt: now.toISOString() }, 200, cors);
    }
    if (url.pathname === '/internal/status/incidents') {
      const parsed = incidentInput.safeParse(await readCommandBody(request).catch(() => null));
      if (!parsed.success) return authJson({ error: 'invalid_request' }, 400, cors);
      const incident = parsed.data;
      const existing = await env.DB.prepare('SELECT component, state FROM status_incidents WHERE id = ?').bind(incident.id).first<{ component: string; state: string }>();
      if (existing && (existing.component !== incident.component || existing.state === 'resolved' && incident.state !== 'resolved')) return authJson({ error: 'incident_conflict' }, 409, cors);
      const saved = await env.DB.prepare(`INSERT INTO status_incidents (id, component, title, state, message, started_at, updated_at, resolved_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, state = excluded.state,
        message = excluded.message, updated_at = excluded.updated_at, resolved_at = COALESCE(status_incidents.resolved_at, excluded.resolved_at)
        WHERE status_incidents.component = excluded.component AND (status_incidents.state != 'resolved' OR excluded.state = 'resolved')`)
        .bind(incident.id, incident.component, incident.title, incident.state, incident.message, now.toISOString(), now.toISOString(), incident.state === 'resolved' ? now.toISOString() : null).run();
      if (!saved.meta.changes) return authJson({ error: 'incident_conflict' }, 409, cors);
      return authJson({ ok: true, id: incident.id }, 200, cors);
    }
    if (url.pathname === '/status/history') {
      const before = url.searchParams.get('before'), component = url.searchParams.get('component'), beforeId = url.searchParams.get('beforeId');
      if (before !== null && (!Number.isFinite(Date.parse(before)) || new Date(before).toISOString() !== before)
        || beforeId !== null && (!before || !/^[1-9]\d*$/.test(beforeId) || !Number.isSafeInteger(Number(beforeId)))
        || component !== null && !STATUS_COMPONENTS.includes(component as typeof STATUS_COMPONENTS[number])) return authJson({ error: 'invalid_request' }, 400, cors);
      const upper = before ?? new Date(now.getTime() + 1).toISOString();
      const rows = await env.DB.prepare(`SELECT * FROM status_observations WHERE
        (checked_at < ? OR (checked_at = ? AND id < ?)) ${component ? 'AND component = ?' : ''}
        ORDER BY checked_at DESC, id DESC LIMIT 100`).bind(upper, upper, beforeId ? Number(beforeId) : 0, ...(component ? [component] : [])).all<ObservationRow>();
      const last = rows.results.at(-1);
      return authJson({ observations: rows.results.map(publicObservation), retentionDays: 31,
        next: rows.results.length === 100 && last ? { before: last.checked_at, beforeId: last.id } : null }, 200, cors);
    }
    if (url.pathname !== '/status') return authJson({ error: 'not_found' }, 404, cors);
    const rows = await env.DB.prepare(`SELECT * FROM status_observations WHERE id IN
      (SELECT MAX(id) FROM status_observations GROUP BY component)`).all<ObservationRow>();
    const incidents = await env.DB.prepare('SELECT * FROM status_incidents ORDER BY updated_at DESC LIMIT 50').all();
    const components = STATUS_COMPONENTS.map(component => {
      const row = rows.results.find(item => item.component === component);
      const stale = !row || now.getTime() - Date.parse(row.checked_at) >= STATUS_STALE_MS;
      return { component, state: stale ? 'unknown' : row.state, stale, scope: row?.scope ?? null,
        latencyMs: row?.latency_ms ?? null, checkedAt: row?.checked_at ?? null };
    });
    const active = incidents.results.filter(incident => incident.state !== 'resolved');
    const overall = components.some(c => c.state === 'outage') ? 'outage' : active.length || components.some(c => c.state === 'degraded') ? 'degraded'
      : components.some(c => c.state === 'unknown') ? 'unknown' : 'operational';
    return authJson({ state: overall, generatedAt: now.toISOString(), staleAfterMs: STATUS_STALE_MS, components, incidents: incidents.results }, 200, cors);
  } catch (error) {
    if (internal && error instanceof Error && ['invalid_request', 'request_too_large'].includes(error.message)) return authJson({ error: 'invalid_request' }, 400, cors);
    return authJson({ error: 'status_unavailable' }, 503, cors);
  }
}

// These inexpensive checks do not establish provisioning/SSH/build health. Those
// components remain unknown until an operator or bounded synthetic probe reports.
export async function collectStatus(env: Env, fetcher: typeof fetch = fetch) {
  const observations: Observation[] = [];
  for (const [component, target] of [['website', 'https://mainbrella.com/'], ['api', 'https://api.mainbrella.com/health']] as const) {
    const start = Date.now();
    let state: Observation['state'] = 'outage';
    try {
      const response = await fetcher(target, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
      if (component === 'api') { if (response.ok && (await response.json() as { ok?: boolean }).ok === true) state = 'operational'; }
      else { if (response.ok) state = 'operational'; await response.body?.cancel(); }
    } catch {}
    observations.push({ component, state, scope: 'reachability', latencyMs: Date.now() - start });
  }
  const start = Date.now();
  try {
    await env.DB.prepare('SELECT 1 AS ok').first();
    observations.push({ component: 'auth', state: 'operational', scope: 'control_plane', latencyMs: Date.now() - start });
  } catch { observations.push({ component: 'auth', state: 'outage', scope: 'control_plane', latencyMs: Date.now() - start }); }
  await recordObservations(env, observations);
  await env.DB.prepare('DELETE FROM status_observations WHERE checked_at < ?').bind(new Date(Date.now() - 31 * 86_400_000).toISOString()).run();
}
