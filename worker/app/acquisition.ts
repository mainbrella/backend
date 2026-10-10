import { z } from 'zod';
import { authCorsHeaders, authJson, currentUser, hashToken } from './auth-core';
import { ADMIN_EMAIL } from './admin';
import { acquisitionEventTypes } from '../lib/acquisition';
import { verifyPublicRepo, repoName, LaunchError } from '../lib/repo-launch';

const slug = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/i);
const clickId = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
const attributionSchema = z.object({
  entryPage: z.string().max(300).regex(/^\/(?!\/)[A-Za-z0-9/_-]*$/),
  variant: slug.default('try_v1'),
  utm_source: slug.optional(), utm_medium: slug.optional(), utm_campaign: slug.optional(),
  utm_content: slug.optional(), utm_term: slug.optional(), creator: slug.optional(),
  gclid: clickId.optional(), fbclid: clickId.optional(), msclkid: clickId.optional(), ttclid: clickId.optional(),
}).strict();
const submissionSchema = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/), repo: repoName, attribution: attributionSchema }).strict();
const tokenSchema = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

async function boundedJson(request: Request, limit: number): Promise<unknown> {
  if (Number(request.headers.get('content-length')) > limit) throw new Error('too_large');
  if (!request.body) throw new Error('invalid_json');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) { await reader.cancel(); throw new Error('too_large'); }
    chunks.push(value);
  }
  try {
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { throw new Error('invalid_json'); }
}

function cors(request: Request): Record<string, string> | null {
  if (!request.headers.get('Origin')) return null;
  return authCorsHeaders(request);
}
const normalizedRepo = (repo: string) => repo.toLowerCase();
const uuid = () => crypto.randomUUID();

export async function handleAcquisitionRequest(request: Request, env: Env): Promise<Response> {
  const headers = cors(request);
  if (headers === null) return authJson({ error: 'origin_required_or_not_allowed' }, 403, {});
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (env.ACQUISITION_ENABLED !== 'true') return authJson({ error: 'not_found' }, 404, headers);
  if (!env.DB) return authJson({ error: 'database_unavailable' }, 503, headers);
  const path = new URL(request.url).pathname;
  if (path === '/acquisition/repositories') return submitRepository(request, env, headers);
  if (path === '/acquisition/link') return linkLead(request, env, headers);
  if (path === '/admin/acquisition/leads' || path === '/admin/acquisition/events') return readAdmin(request, env, headers, path);
  return authJson({ error: 'not_found' }, 404, headers);
}

async function submitRepository(request: Request, env: Env, headers: Record<string, string>): Promise<Response> {
  if (request.method !== 'POST') return authJson({ error: 'method_not_allowed' }, 405, { ...headers, allow: 'POST, OPTIONS' });
  if (!env.ACQUISITION_SUBMISSION_LIMIT && env.LOCAL_DEV !== 'true') return authJson({ error: 'rate_limit_unavailable' }, 503, headers);
  try {
    const input = submissionSchema.parse(await boundedJson(request, 4096));
    if (env.ACQUISITION_SUBMISSION_LIMIT) {
      const ip = request.headers.get('CF-Connecting-IP');
      if (!ip) return authJson({ error: 'rate_limit_unavailable' }, 503, headers);
      if (!(await env.ACQUISITION_SUBMISSION_LIMIT.limit({ key: `repo:${ip}` })).success) return authJson({ error: 'rate_limited' }, 429, headers);
    }
    const tokenHash = await hashToken(input.token);
    const prior = await env.DB!.prepare('SELECT id,repo FROM acquisition_leads WHERE token_hash=?').bind(tokenHash).first<{ id: string; repo: string }>();
    if (prior) {
      if (normalizedRepo(prior.repo) !== normalizedRepo(input.repo)) return authJson({ error: 'submission_conflict' }, 409, headers);
      return authJson({ leadId: prior.id, repo: prior.repo }, 200, headers);
    }
    const canonical = await verifyPublicRepo(input.repo, env.REPO_RUN_GITHUB_TOKEN);
    const id = uuid();
    const now = Date.now();
    try {
      await env.DB!.batch([
        env.DB!.prepare('INSERT INTO acquisition_leads(id,token_hash,repo,attribution_json,created_at) VALUES(?,?,?,?,?)')
          .bind(id, tokenHash, canonical, JSON.stringify(input.attribution), now),
        env.DB!.prepare(`INSERT INTO acquisition_events(event_key,event_type,lead_id,occurred_at,recorded_at,payload)
          VALUES(?, 'repo.submitted', ?, ?, ?, ?)`)
          .bind(`repo.submitted:${id}`, id, now, now, JSON.stringify({ repo: canonical })),
      ]);
    } catch (error) {
      const raced = await env.DB!.prepare('SELECT id,repo FROM acquisition_leads WHERE token_hash=?').bind(tokenHash).first<{ id: string; repo: string }>();
      if (raced) return normalizedRepo(raced.repo) === normalizedRepo(canonical)
        ? authJson({ leadId: raced.id, repo: raced.repo }, 200, headers)
        : authJson({ error: 'submission_conflict' }, 409, headers);
      throw error;
    }
    return authJson({ leadId: id, repo: canonical }, 201, headers);
  } catch (error) {
    if (error instanceof z.ZodError) return authJson({ error: 'invalid_request' }, 400, headers);
    if (error instanceof Error && error.message === 'too_large') return authJson({ error: 'request_too_large' }, 413, headers);
    if (error instanceof Error && error.message === 'invalid_json') return authJson({ error: 'invalid_json' }, 400, headers);
    if (error instanceof LaunchError) return authJson({ error: error.message }, error.status, headers);
    console.error('acquisition_submission_failed');
    return authJson({ error: 'acquisition_unavailable' }, 503, headers);
  }
}

async function linkLead(request: Request, env: Env, headers: Record<string, string>): Promise<Response> {
  if (request.method !== 'POST') return authJson({ error: 'method_not_allowed' }, 405, { ...headers, allow: 'POST, OPTIONS' });
  const user = await currentUser(env, request);
  if (!user) return authJson({ error: 'unauthorized' }, 401, headers);
  if (!user.email?.trim()) return authJson({ error: 'contact_required' }, 400, headers);
  try {
    const input = tokenSchema.parse(await boundedJson(request, 1024));
    const tokenHash = await hashToken(input.token);
    const lead = await env.DB!.prepare('SELECT id,user_id,created_at FROM acquisition_leads WHERE token_hash=?').bind(tokenHash)
      .first<{ id: string; user_id: string | null; created_at: number }>();
    if (!lead || lead.created_at < Date.now() - 30 * 24 * 60 * 60 * 1000) return authJson({ error: 'lead_not_found' }, 404, headers);
    if (lead.user_id && lead.user_id !== user.id) return authJson({ error: 'lead_already_linked' }, 409, headers);
    const now = Date.now();
    await env.DB!.batch([
      env.DB!.prepare(`UPDATE acquisition_leads SET user_id=?,contact_email=?,captured_at=? WHERE id=? AND user_id IS NULL`)
        .bind(user.id, user.email.trim(), now, lead.id),
      env.DB!.prepare(`INSERT INTO acquisition_accounts(user_id,lead_id,created_at)
        SELECT ?,id,? FROM acquisition_leads WHERE id=? AND user_id=? AND captured_at IS NOT NULL
        ON CONFLICT(user_id) DO NOTHING`).bind(user.id, now, lead.id, user.id),
      env.DB!.prepare(`INSERT INTO acquisition_events(event_key,event_type,user_id,lead_id,occurred_at,recorded_at,payload)
      SELECT ?, 'lead.captured', ?, id, captured_at, ?, json_object('repo',repo) FROM acquisition_leads
        WHERE id=? AND user_id=? AND captured_at IS NOT NULL ON CONFLICT(event_key) DO NOTHING`)
        .bind(`lead.captured:${lead.id}`, user.id, now, lead.id, user.id),
    ]);
    const linked = await env.DB!.prepare('SELECT user_id FROM acquisition_leads WHERE id=?').bind(lead.id).first<{ user_id: string }>();
    if (linked?.user_id !== user.id) return authJson({ error: 'lead_already_linked' }, 409, headers);
    return authJson({ linked: true }, 200, headers);
  } catch (error) {
    if (error instanceof z.ZodError) return authJson({ error: 'invalid_request' }, 400, headers);
    if (error instanceof Error && error.message === 'too_large') return authJson({ error: 'request_too_large' }, 413, headers);
    if (error instanceof Error && error.message === 'invalid_json') return authJson({ error: 'invalid_json' }, 400, headers);
    console.error('acquisition_link_failed');
    return authJson({ error: 'acquisition_unavailable' }, 503, headers);
  }
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
