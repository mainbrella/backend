import { authCorsHeaders, authJson, currentUser } from './auth-core';
import { ADMIN_EMAIL } from '../shared/admin';
import { acquisitionEventTypes } from '../lib/acquisition';

export async function handleAdminAcquisitionRequest(request: Request, env: Env): Promise<Response> {
  const headers = request.headers.get('Origin') ? authCorsHeaders(request, env) : null;
  if (headers === null) return authJson({ error: 'origin_required_or_not_allowed' }, 403, {});
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (env.ACQUISITION_ENABLED !== 'true') return authJson({ error: 'not_found' }, 404, headers);
  if (!env.DB) return authJson({ error: 'database_unavailable' }, 503, headers);
  const path = new URL(request.url).pathname;
  if (path !== '/admin/acquisition/leads' && path !== '/admin/acquisition/events') return authJson({ error: 'not_found' }, 404, headers);
  return readAdmin(request, env, headers, path);
}

async function readAdmin(request: Request, env: Env, headers: Record<string, string>, path: string): Promise<Response> {
  if (request.method !== 'GET') return authJson({ error: 'method_not_allowed' }, 405, { ...headers, allow: 'GET, OPTIONS' });
  const user = await currentUser(env, request);
  if (!user) return authJson({ error: 'unauthorized' }, 401, headers);
  if (user.email?.trim().toLowerCase() !== ADMIN_EMAIL) return authJson({ error: 'forbidden' }, 403, headers);
  try {
    const url = new URL(request.url);
    const limitText = url.searchParams.get('limit') ?? '50';
    const limit = Number(limitText);
    if (!/^\d+$/.test(limitText) || !Number.isInteger(limit) || limit < 1 || limit > 100) return authJson({ error: 'invalid_limit' }, 400, headers);
    const allowed = new Set(path.endsWith('/leads') ? ['limit','after','userId','leadId'] : ['limit','after','userId','leadId','event']);
    for (const key of url.searchParams.keys()) if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) return authJson({ error: 'invalid_filter' }, 400, headers);
    const userId = url.searchParams.get('userId');
    const leadId = url.searchParams.get('leadId');
    if (path.endsWith('/leads')) {
      const after = url.searchParams.get('after');
      const rows = await env.DB!.prepare(`SELECT id,repo,attribution_json,created_at,user_id,contact_email,captured_at
        FROM acquisition_leads WHERE (? IS NULL OR user_id=?) AND (? IS NULL OR id=?)
        AND (? IS NULL OR (created_at,id)<(SELECT created_at,id FROM acquisition_leads WHERE id=?))
        ORDER BY created_at DESC,id DESC LIMIT ?`).bind(userId,userId,leadId,leadId,after,after,limit).all<any>();
      return authJson({ leads: (rows.results ?? []).map(row => ({ id: row.id, repo: row.repo,
        attribution: JSON.parse(row.attribution_json), createdAt: row.created_at, userId: row.user_id,
        contactEmail: row.contact_email, capturedAt: row.captured_at })), next: rows.results?.at(-1)?.id ?? null, limit }, 200, headers);
    }
    const afterText = url.searchParams.get('after') ?? '0';
    const after = Number(afterText);
    const type = url.searchParams.get('event');
    if (!/^\d+$/.test(afterText) || !Number.isSafeInteger(after) || after < 0 || (type && !acquisitionEventTypes.includes(type as any))) return authJson({ error: 'invalid_filter' }, 400, headers);
    const rows = await env.DB!.prepare(`SELECT e.sequence,e.event_key,e.event_type,e.user_id,e.lead_id,e.occurred_at,e.recorded_at,e.payload,
        COALESCE(e.user_id,l.user_id) AS effective_user_id,COALESCE(e.lead_id,a.lead_id) AS effective_lead_id,
        l.repo AS lead_repo,l.attribution_json
      FROM acquisition_events e LEFT JOIN acquisition_accounts a ON a.user_id=e.user_id
      LEFT JOIN acquisition_leads l ON l.id=COALESCE(e.lead_id,a.lead_id)
      WHERE e.sequence>? AND (? IS NULL OR COALESCE(e.user_id,l.user_id)=?)
        AND (? IS NULL OR COALESCE(e.lead_id,a.lead_id)=?) AND (? IS NULL OR e.event_type=?)
      ORDER BY e.sequence LIMIT ?`).bind(after,userId,userId,leadId,leadId,type,type,limit).all<any>();
    const events = rows.results ?? [];
    return authJson({ events: events.map(row => ({ sequence: row.sequence, key: row.event_key, type: row.event_type,
      userId: row.effective_user_id, leadId: row.effective_lead_id, occurredAt: row.occurred_at,
      recordedAt: row.recorded_at, data: JSON.parse(row.payload), repo: row.lead_repo ?? null,
      attribution: row.attribution_json ? JSON.parse(row.attribution_json) : null })),
      next: events.at(-1)?.sequence ?? null, limit }, 200, headers);
  } catch {
    console.error('admin_acquisition_read_failed');
    return authJson({ error: 'acquisition_unavailable' }, 503, headers);
  }
}
