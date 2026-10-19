import { Buffer } from 'node:buffer';
import { egressTarget, publicAddress } from '../../containers/security-contract.js';
import { publicApiOrigin } from '../lib/deployment-environment';
import { deleteStoredObjects, getStoredObject, putStoredObject, storagePrefix, type StorageOwner } from '../lib/r2-storage';
import { boundedBody } from '../shared/bounded-body.js';
import { BffError, checksum, type Project } from './contracts';
import { enabled } from './http';
import { getPagePreview } from './og-image';

export const PREVIEW_LIMITS = { cacheMs: 14 * 86400_000, failureMs: 6 * 3600_000, leaseMs: 120_000, timeoutMs: 25_000, imageBytes: 5 * 1024 * 1024, jobsPerDay: 100, projectJobs: 1000 } as const;
type Preview = {
  id: string; project_id: string; user_id: string; url_hash: string; url: string; favicon: string | null;
  state: 'pending' | 'processing' | 'ready' | 'failed'; object_key: string | null; error: string | null;
  lease: string | null; lease_until: number; expires_at: number; created_at: number;
};
const ownerOf = (row: Preview): StorageOwner => ({ product: 'bff', userId: row.user_id, appId: row.project_id });
const objectKey = (row: Preview) => row.object_key ?? `${storagePrefix(ownerOf(row))}previews/${row.url_hash}/${row.id}.jpg`;
const imagePath = (id: string) => `/bff/preview-images/${id}.jpg`;
const statusPath = (row: Preview) => `/bff/projects/${row.project_id}/previews/${row.id}`;

export async function previewProject(env: Env, projectId: string, userId: string) {
  enabled(env);
  const project = await env.DB.prepare('SELECT * FROM bff_projects WHERE id=? AND user_id=?').bind(projectId, userId).first<Project>();
  if (!project) throw new BffError('not_found', 404);
  if (project.blocked) throw new BffError('project_blocked', 403);
  if (project.suspended) throw new BffError('project_paused', 403);
  return project;
}

function result(env: Env, row: Preview) {
  const ready = row.state === 'ready';
  return {
    image: ready ? `${publicApiOrigin(env)}${imagePath(row.id)}` : row.favicon,
    source: ready ? 'screenshot' as const : row.favicon ? 'favicon' as const : 'placeholder' as const,
    status: ready ? 'ready' as const : row.state === 'failed' ? 'failed' as const : 'pending' as const,
    previewId: row.id, statusUrl: `${publicApiOrigin(env)}${statusPath(row)}`,
  };
}

async function dispatch(env: Env, row: Preview) {
  try { await env.BFF_PREVIEW_QUEUE.send({ id: row.id }); }
  catch {
    // A lost send acknowledgement may still deliver. The same job can safely be
    // dispatched again; the consumer claims it with an expiring lease.
    await env.DB.prepare("UPDATE bff_previews SET lease_until=0 WHERE id=? AND state='pending'").bind(row.id).run();
    throw new BffError('preview_queue_unavailable', 503);
  }
}

async function recoverDispatch(env: Env, row: Preview) {
  if (!['pending', 'processing'].includes(row.state) || row.lease_until > Date.now()) return;
  if (!env.BFF_PREVIEW_QUEUE) throw new BffError('preview_queue_unavailable', 503);
  const claimed = await env.DB.prepare("UPDATE bff_previews SET state='pending',lease=NULL,lease_until=? WHERE id=? AND lease_until<=? AND state IN ('pending','processing') RETURNING id")
    .bind(Date.now() + PREVIEW_LIMITS.leaseMs, row.id, Date.now()).first();
  if (claimed) await dispatch(env, row);
}

export async function requestPreview(env: Env, projectId: string, userId: string, url: string, signal?: AbortSignal) {
  await previewProject(env, projectId, userId);
  let metadata;
  try { metadata = await getPagePreview(url, signal); }
  catch (error) {
    if (!(error instanceof BffError) || ![502, 504].includes(error.status)) throw error;
    // Browser rendering can still succeed when a plain HTTP fetch fails.
    metadata = { image: null, source: null, favicon: null, url };
  }
  if (metadata.image) return { data: { image: metadata.image, source: metadata.source, status: 'ready' as const }, status: 200 };
  if (!env.BROWSER || !env.BFF_PREVIEW_QUEUE || !env.BUCKET) throw new BffError('preview_unavailable', 503);
  const hash = await checksum(new URL(url).href), now = Date.now();
  let row = await env.DB.prepare('SELECT * FROM bff_previews WHERE project_id=? AND url_hash=?').bind(projectId, hash).first<Preview>();
  if (row && row.expires_at <= now) {
    // Include a put whose acknowledgement was lost before the ready state saved.
    await deleteStoredObjects(env, ownerOf(row), [objectKey(row)]);
    await env.DB.prepare('DELETE FROM bff_previews WHERE id=? AND expires_at<=?').bind(row.id, now).run();
    row = null;
  }
  if (!row) {
    const id = crypto.randomUUID(), day = new Date(now).toISOString().slice(0, 10);
    const [inserted] = await env.DB.batch([
      env.DB.prepare(`INSERT INTO bff_previews(id,project_id,user_id,url_hash,url,favicon,state,lease_until,expires_at,created_at)
        SELECT ?,?,?,?,?,?,'pending',?,?,? WHERE COALESCE((SELECT previews FROM bff_daily_usage WHERE project_id=? AND day=?),0)<?
          AND (SELECT COUNT(*) FROM bff_previews WHERE project_id=?)<? ON CONFLICT(project_id,url_hash) DO NOTHING`)
        .bind(id, projectId, userId, hash, metadata.url, metadata.favicon, now + PREVIEW_LIMITS.leaseMs, now + PREVIEW_LIMITS.cacheMs, now,
          projectId, day, PREVIEW_LIMITS.jobsPerDay, projectId, PREVIEW_LIMITS.projectJobs),
      env.DB.prepare(`INSERT INTO bff_daily_usage(project_id,day,previews) SELECT ?,?,1 WHERE EXISTS(SELECT 1 FROM bff_previews WHERE id=?)
        ON CONFLICT(project_id,day) DO UPDATE SET previews=previews+1`).bind(projectId, day, id),
    ]);
    row = await env.DB.prepare('SELECT * FROM bff_previews WHERE project_id=? AND url_hash=?').bind(projectId, hash).first<Preview>();
    if (!row) throw new BffError('preview_limit', 429);
    if (inserted.meta.changes) await dispatch(env, row);
  } else await recoverDispatch(env, row);
  return { data: result(env, row), status: row.state === 'ready' || row.state === 'failed' ? 200 : 202 };
}

export async function previewStatus(env: Env, projectId: string, userId: string, id: string) {
  await previewProject(env, projectId, userId);
  const row = await env.DB.prepare('SELECT * FROM bff_previews WHERE id=? AND project_id=? AND expires_at>?').bind(id, projectId, Date.now()).first<Preview>();
  if (!row) throw new BffError('not_found', 404);
  await recoverDispatch(env, row);
  return { data: result(env, row), status: ['pending', 'processing'].includes(row.state) ? 202 : 200 };
}

export async function previewImage(request: Request, env: Env, id: string) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
  if (env.BFF_ENABLED !== 'true' || !env.BUCKET) return new Response(null, { status: 404 });
  const row = await env.DB.prepare(`SELECT v.* FROM bff_previews v JOIN bff_projects p ON p.id=v.project_id AND p.user_id=v.user_id
    WHERE v.id=? AND v.state='ready' AND v.expires_at>? AND p.suspended=0 AND p.blocked=0`).bind(id, Date.now()).first<Preview>();
  if (!row?.object_key) return new Response(null, { status: 404 });
  const object = await getStoredObject(env, ownerOf(row), row.object_key);
  if (!object) return new Response(null, { status: 404 });
  return new Response(request.method === 'HEAD' ? null : object.body, { headers: {
    'content-type': 'image/jpeg', 'content-length': String(object.size), etag: object.httpEtag,
    'cache-control': `public, max-age=${Math.max(0, Math.min(3600, Math.floor((row.expires_at - Date.now()) / 1000)))}`,
    'x-content-type-options': 'nosniff', 'access-control-allow-origin': '*',
  } });
}

// Match public DNS names only: no credentials, IP literals, custom ports or local
// suffixes. Browser subresources and redirects use this same request filter.
export const BROWSER_PUBLIC_PATTERN = '^https?://(?!(?:[^/]+\\.)?(?:localhost|local|internal|invalid|test|example|onion)(?:[/:]|$))(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\\.)+[a-zA-Z][a-zA-Z0-9-]*(?:/|$)';

async function publicDns(url: string, signal: AbortSignal) {
  const target = egressTarget(url);
  if (!target) throw new Error('preview_url_not_allowed');
  // Browser network patterns intentionally deny all IP-literal requests.
  if (publicAddress(target.hostname)) throw new Error('preview_url_not_allowed');
  const addresses = await Promise.all(['A', 'AAAA'].map(async type => {
    const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(target.hostname)}&type=${type}`, {
      headers: { accept: 'application/dns-json' }, redirect: 'manual', signal,
    });
    if (!response.ok) throw new Error('preview_dns_failed');
    const data = JSON.parse(new TextDecoder().decode(await boundedBody(response.body, 16_384, signal))) as { Status: number; Answer?: { type: number; data: string }[] };
    if (data.Status !== 0) throw new Error('preview_dns_failed');
    return (data.Answer ?? []).filter(answer => answer.type === 1 || answer.type === 28).map(answer => answer.data);
  }));
  if (!addresses.flat().length || addresses.flat().some(address => !publicAddress(address))) throw new Error('preview_url_not_allowed');
}

export function usablePreview(content: string, meta: { status: number; title: string }) {
  if (meta.status < 200 || meta.status >= 300) return false;
  if (/just a moment|checking your browser|verify (?:you are|you're) human|access denied|captcha|page not found|^\s*(?:error|404|403|log[ -]?in|sign[ -]?in)\b/i.test(meta.title)) return false;
  if (/(?:id|class)\s*=\s*["'][^"']*(?:cf-chl-|g-recaptcha|h-captcha|onetrust-banner-sdk|CybotCookiebotDialog|cookie-consent-banner)/i.test(content)) return false;
  const body = content.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  const visible = (/<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(body)?.[1] ?? body).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return visible.length >= 40 || /<(?:img|svg|canvas)\b/i.test(body);
}

async function renderPreview(env: Env, row: Preview) {
  const signal = AbortSignal.timeout(PREVIEW_LIMITS.timeoutMs);
  await publicDns(row.url, signal);
  const pending = env.BROWSER.quickAction('snapshot', {
    url: row.url, formats: ['content', 'screenshot'], viewport: { width: 1200, height: 630 },
    screenshotOptions: { type: 'jpeg', quality: 80, fullPage: false },
    gotoOptions: { timeout: 10_000, waitUntil: 'networkidle2' }, actionTimeout: 10_000, waitForTimeout: 1000,
    allowRequestPattern: [BROWSER_PUBLIC_PATTERN], rejectResourceTypes: ['media', 'websocket'], cacheTTL: 0,
  }).then(response => {
    if (signal.aborted) void response.body?.cancel().catch(() => {});
    return response;
  });
  let abort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error('preview_timeout'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    const response = await Promise.race([pending, aborted]);
    if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new Error('preview_browser_failed'); }
    const snapshot = JSON.parse(new TextDecoder().decode(await boundedBody(response.body, 12 * 1024 * 1024, signal))) as BrowserRunSnapshotSuccessResponse;
    if (!snapshot.success || !snapshot.result?.content || !snapshot.result.screenshot || !snapshot.meta
      || !usablePreview(snapshot.result.content, snapshot.meta)) throw new Error('preview_unusable');
    if (snapshot.meta.finalUrl) await publicDns(snapshot.meta.finalUrl, signal);
    if (snapshot.meta.redirectChain?.some(hop => !egressTarget(hop.url))) throw new Error('preview_url_not_allowed');
    const bytes = Buffer.from(snapshot.result.screenshot, 'base64');
    if (bytes.length < 1000 || bytes.length > PREVIEW_LIMITS.imageBytes || bytes[0] !== 0xff || bytes[1] !== 0xd8
      || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) throw new Error('preview_invalid_image');
    return bytes;
  } finally { signal.removeEventListener('abort', abort); }
}

export async function consumePreviews(batch: MessageBatch<unknown>, env: Env) {
  for (const message of batch.messages) {
    const payload = message.body;
    const id = payload && typeof payload === 'object' && 'id' in payload ? payload.id : null;
    if (typeof id !== 'string') { message.ack(); continue; }
    const lease = crypto.randomUUID(), now = Date.now();
    try {
      const row = await env.DB.prepare(`UPDATE bff_previews SET state='processing',lease=?,lease_until=?
        WHERE id=? AND expires_at>? AND (state='pending' OR (state='processing' AND lease_until<=?)) RETURNING *`)
        .bind(lease, now + PREVIEW_LIMITS.leaseMs, id, now, now).first<Preview>();
      if (!row) { message.ack(); continue; }
      try {
        await previewProject(env, row.project_id, row.user_id);
        const bytes = await renderPreview(env, row);
        const key = objectKey(row);
        const assertWritable = async () => {
          await previewProject(env, row.project_id, row.user_id);
          const active = await env.DB.prepare("SELECT id FROM bff_previews WHERE id=? AND lease=? AND state='processing'").bind(id, lease).first();
          if (!active) throw new Error('preview_lease_lost');
        };
        await assertWritable();
        await putStoredObject(env, ownerOf(row), key, bytes, 'assets', {
          onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'image/jpeg' },
        }, assertWritable);
        const saved = await env.DB.prepare("UPDATE bff_previews SET state='ready',object_key=?,expires_at=?,lease=NULL,lease_until=0 WHERE id=? AND lease=?")
          .bind(key, Date.now() + PREVIEW_LIMITS.cacheMs, id, lease).run();
        if (!saved.meta.changes) await deleteStoredObjects(env, ownerOf(row), [key]);
        message.ack();
      } catch (error) {
        const code = error instanceof BffError ? error.code : error instanceof Error && /^preview_[a-z_]+$/.test(error.message) ? error.message : 'preview_failed';
        await env.DB.prepare("UPDATE bff_previews SET state='failed',error=?,expires_at=?,lease=NULL,lease_until=0 WHERE id=? AND lease=?")
          .bind(code, Date.now() + PREVIEW_LIMITS.failureMs, id, lease).run();
        message.ack();
      }
    } catch { message.retry({ delaySeconds: 60 }); }
  }
}

export async function cleanupPreviews(env: Env) {
  if (!env.BUCKET) return;
  const rows = await env.DB.prepare(`SELECT v.* FROM bff_previews v LEFT JOIN bff_projects p ON p.id=v.project_id AND p.user_id=v.user_id
    WHERE (v.expires_at<=? OR p.id IS NULL) AND v.lease_until<=? LIMIT 50`).bind(Date.now(), Date.now()).all<Preview>();
  for (const row of rows.results) {
    await deleteStoredObjects(env, ownerOf(row), [objectKey(row)]);
    await env.DB.prepare('DELETE FROM bff_previews WHERE id=? AND lease_until<=?').bind(row.id, Date.now()).run();
  }
}
