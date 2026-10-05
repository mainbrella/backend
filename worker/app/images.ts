import { authCorsHeaders, authJson, hashToken } from './auth-core';
import { containerUser } from './container-auth';

export const IMAGE_LIMITS = Object.freeze({ maxBuildsPerMonth: 10, maxSavedImages: 3,
  maxContextBytes: 512 * 1024, maxDockerfileBytes: 16 * 1024, maxBuildSeconds: 300 });
const MAX_REQUEST_BYTES = IMAGE_LIMITS.maxContextBytes + IMAGE_LIMITS.maxDockerfileBytes + 8192;
const ACTIVE = "('queued', 'building', 'publishing')";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ACCOUNT_ID = '2b7a9be82bb64187230703b024e25157';
export type ImageRow = { id: string; user_id: string; name: string; status: string;
  dockerfile: string; context_base64: string | null; image_key: string; image_ref: string | null;
  logs: string; created_at: string; updated_at: string; deadline: string };

export function publicImage(row: ImageRow) {
  return { id: row.id, name: row.name, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at };
}

// Restrict this first release to one Mainbrella-based development environment.
// A recipe is still arbitrary code, executed only in a disposable build job.
export function validDockerfile(source: string) {
  if (new TextEncoder().encode(source).length > IMAGE_LIMITS.maxDockerfileBytes || source.includes('\0')) return false;
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const first = lines.find(line => line.trim() && !line.trim().startsWith('#'));
  return /^FROM mainbrella:base\s*$/i.test(first?.trim() || '')
    && lines.filter(line => /^\s*FROM\b/i.test(line)).length === 1
    && !lines.some(line => /^\s*#\s*(syntax|escape)\s*=/i.test(line));
}

export async function expireImageBuilds(env: Env) {
  const now = new Date().toISOString();
  await env.DB.prepare(`UPDATE container_images SET status = 'failed', logs = 'Build timed out. Submit a new build to try again.',
    context_base64 = NULL, updated_at = ? WHERE status IN ${ACTIVE} AND deadline <= ?`).bind(now, now).run();
}

export async function ownedImage(env: Env, userId: string, id: string) {
  if (!UUID.test(id)) return null;
  return env.DB.prepare('SELECT * FROM container_images WHERE id = ? AND user_id = ? AND status != \'deleted\'')
    .bind(id, userId).first<ImageRow>();
}

async function boundedBody(request: Request, maxBytes: number): Promise<ArrayBuffer | null> {
  if (Number(request.headers.get('content-length')) > maxBytes) return null;
  const reader = request.body?.getReader();
  if (!reader) return new ArrayBuffer(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result.buffer;
}

async function dispatchImageWorkflow(env: Env, inputs: Record<string, string>) {
  return fetch('https://api.github.com/repos/mainbrella/backend/actions/workflows/custom-image.yml/dispatches', {
    method: 'POST', headers: { Authorization: `Bearer ${env.IMAGE_BUILD_GITHUB_TOKEN}`, 'Content-Type': 'application/json',
      Accept: 'application/vnd.github+json', 'User-Agent': 'Mainbrella', 'X-GitHub-Api-Version': '2022-11-28' },
    body: JSON.stringify({ ref: 'main', inputs }), signal: AbortSignal.timeout(10_000),
  });
}

async function createImage(request: Request, env: Env, userId: string, cors: Record<string, string>) {
  if (!env.IMAGE_BUILD_GITHUB_TOKEN || !env.IMAGE_BUILD_SECRET) return authJson({ error: 'image_builds_unavailable' }, 503, cors);
  const body = await boundedBody(request, MAX_REQUEST_BYTES);
  if (!body) return authJson({ error: 'image_source_too_large' }, 413, cors);
  let form: FormData;
  try { form = await new Response(body, { headers: { 'content-type': request.headers.get('content-type') || '' } }).formData(); }
  catch { return authJson({ error: 'invalid_image_source' }, 400, cors); }
  const name = form.get('name');
  const dockerfile = form.get('dockerfile');
  const context = form.get('context');
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 80
    || typeof dockerfile !== 'string' || !validDockerfile(dockerfile)
    || [...form.keys()].some(key => !['name', 'dockerfile', 'context'].includes(key))
    || ['name', 'dockerfile', 'context'].some(key => form.getAll(key).length > 1)) {
    return authJson({ error: 'invalid_image_source' }, 400, cors);
  }
  let contextBase64: string | null = null;
  if (context !== null) {
    if (typeof context === 'string' || !context.name.endsWith('.tar.gz') || context.size > IMAGE_LIMITS.maxContextBytes) {
      return authJson({ error: 'invalid_image_context' }, 400, cors);
    }
    const bytes = new Uint8Array(await context.arrayBuffer());
    if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return authJson({ error: 'invalid_image_context' }, 400, cors);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    contextBase64 = btoa(binary);
  }
  await expireImageBuilds(env);
  const id = crypto.randomUUID();
  const now = new Date();
  const imageKey = `custom_${id.replaceAll('-', '')}`;
  try {
    await env.DB.prepare(`INSERT INTO container_images
      (id, user_id, name, status, dockerfile, context_base64, image_key, created_at, updated_at, deadline, month)
      VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`).bind(id, userId, name.trim(), dockerfile,
      contextBase64, imageKey, now.toISOString(), now.toISOString(), new Date(now.getTime() + 30 * 60_000).toISOString(), now.toISOString().slice(0, 7)).run();
  } catch (error) {
    const message = String(error);
    for (const code of ['image_build_in_progress', 'image_build_quota_exceeded', 'image_storage_limit', 'image_service_capacity']) {
      if (message.includes(code)) return authJson({ error: code }, code === 'image_build_in_progress' ? 409 : 429, cors);
    }
    throw error;
  }
  // Explicit client rejections cannot have scheduled a build. Network failures
  // and server errors remain charged because dispatch delivery is ambiguous.
  let rejected = false;
  try {
    const response = await dispatchImageWorkflow(env, { build_id: id });
    rejected = [400, 401, 403, 404, 422].includes(response.status);
    if (!response.ok) throw new Error('dispatch_failed');
  } catch {
    const failed = env.DB.prepare("UPDATE container_images SET status = 'failed', logs = 'Could not schedule the build. Submit a new build to try again.', context_base64 = NULL WHERE id = ? AND status = 'queued'").bind(id);
    if (rejected) {
      await env.DB.batch([
        env.DB.prepare(`UPDATE container_image_usage SET builds = MAX(0, builds - 1) WHERE user_id = ? AND month = ?
          AND EXISTS (SELECT 1 FROM container_images WHERE id = ? AND status = 'queued')`)
          .bind(userId, now.toISOString().slice(0, 7), id), failed,
      ]);
    } else { await failed.run(); }
    return authJson({ error: 'image_builds_unavailable' }, 503, cors);
  }
  return authJson({ image: { id, name: name.trim(), status: 'queued', createdAt: now.toISOString(), updatedAt: now.toISOString() } }, 202, cors);
}

export async function handleImagesRequest(request: Request, env: Env) {
  const cors = authCorsHeaders(request);
  if (cors === null) return authJson({ error: 'origin_not_allowed' }, 403, {});
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const path = new URL(request.url).pathname;
  const match = path.match(/^\/images\/([a-f0-9-]+)(\/logs)?$/);
  if (path !== '/images' && (!match || !UUID.test(match[1]))) return authJson({ error: 'not_found' }, 404, cors);
  const allowed = path === '/images' ? ['GET', 'POST'] : match?.[2] ? ['GET'] : ['GET', 'DELETE'];
  if (!allowed.includes(request.method)) return authJson({ error: 'method_not_allowed' }, 405, cors);
  if (request.method !== 'GET' && !request.headers.get('Origin') && !request.headers.has('Authorization')) {
    return authJson({ error: 'origin_required' }, 403, cors);
  }
  try {
    const user = await containerUser(env, request);
    if (!user) return authJson({ error: 'not_authenticated' }, 401, cors);
    if (path === '/images' && request.method === 'POST') return await createImage(request, env, user.id, cors);
    await expireImageBuilds(env);
    if (path === '/images') {
      const rows = await env.DB.prepare("SELECT * FROM container_images WHERE user_id = ? AND status != 'deleted' ORDER BY created_at DESC LIMIT 50")
        .bind(user.id).all<ImageRow>();
      const month = new Date().toISOString().slice(0, 7);
      const usage = await env.DB.prepare('SELECT builds FROM container_image_usage WHERE user_id = ? AND month = ?').bind(user.id, month).first<{ builds: number }>();
      return authJson({ images: rows.results.map(publicImage), limits: IMAGE_LIMITS, usage: { month, builds: usage?.builds || 0 },
        buildsEnabled: Boolean(env.IMAGE_BUILD_GITHUB_TOKEN && env.IMAGE_BUILD_SECRET) }, 200, cors);
    }
    const image = await ownedImage(env, user.id, match![1]);
    if (!image) return authJson({ error: 'not_found' }, 404, cors);
    if (request.method === 'DELETE') {
      if (['queued', 'building', 'publishing'].includes(image.status)) return authJson({ error: 'image_build_in_progress' }, 409, cors);
      await env.DB.prepare("UPDATE container_images SET status = 'deleted', context_base64 = NULL, dockerfile = '', logs = '', updated_at = ? WHERE id = ? AND user_id = ?")
        .bind(new Date().toISOString(), image.id, user.id).run();
      // A scheduled reconciliation also repairs dispatch/deployment failures.
      // D1 is authoritative; a later deployment excludes the tombstoned image.
      try {
        await dispatchImageWorkflow(env, { operation: 'reconcile' });
      } catch { /* The hourly reconciliation retries removal. */ }
      return authJson({ deleted: true }, 200, cors);
    }
    return authJson(match![2] ? { logs: image.logs, status: image.status } : { image: publicImage(image) }, 200, cors);
  } catch {
    return authJson({ error: 'image_builds_unavailable' }, 503, cors);
  }
}

async function buildAuthenticated(request: Request, env: Env) {
  if (!env.IMAGE_BUILD_SECRET || env.IMAGE_BUILD_SECRET.length < 32) return false;
  const token = request.headers.get('Authorization')?.match(/^Bearer (.{32,256})$/)?.[1];
  if (!token) return false;
  const [actual, expected] = await Promise.all([hashToken(token), hashToken(env.IMAGE_BUILD_SECRET)]);
  let difference = 0;
  for (let i = 0; i < actual.length; i++) difference |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return difference === 0;
}

// Trusted preparation/publishing jobs only; never called from the untrusted build.
export async function handleImageBuildRequest(request: Request, env: Env) {
  try {
    if (!await buildAuthenticated(request, env)) return authJson({ error: 'not_authenticated' }, 401, {});
    const path = new URL(request.url).pathname;
    if (path === '/internal/image-builds/deployment-lock') {
      if (!['POST', 'DELETE'].includes(request.method)) return authJson({ error: 'method_not_allowed' }, 405, {});
      const bytes = await boundedBody(request, 1024);
      if (!bytes) return authJson({ error: 'invalid_request' }, 400, {});
      let token: unknown;
      try { token = JSON.parse(new TextDecoder().decode(bytes)).token; } catch {}
      if (typeof token !== 'string' || !UUID.test(token)) return authJson({ error: 'invalid_request' }, 400, {});
      if (request.method === 'DELETE') {
        await env.DB.prepare('DELETE FROM container_image_deployment_lock WHERE id = 1 AND token = ?').bind(token).run();
        return authJson({ released: true }, 200, {});
      }
      const now = new Date();
      const saved = await env.DB.prepare(`INSERT INTO container_image_deployment_lock (id, token, expires_at) VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at
        WHERE container_image_deployment_lock.expires_at <= ?`)
        .bind(token, new Date(now.getTime() + 12 * 60_000).toISOString(), now.toISOString()).run();
      return authJson(saved.meta.changes ? { acquired: true } : { error: 'image_deployment_busy' }, saved.meta.changes ? 200 : 409, {});
    }
    if (path === '/internal/image-builds/manifest' && request.method === 'GET') {
      await expireImageBuilds(env);
      const rows = await env.DB.prepare("SELECT image_key, image_ref FROM container_images WHERE status IN ('ready', 'publishing') AND image_ref IS NOT NULL ORDER BY image_key")
        .all<{ image_key: string; image_ref: string }>();
      return authJson({ images: Object.fromEntries(rows.results.map(row => [row.image_key, { image: row.image_ref }])) }, 200, {});
    }
    const match = path.match(/^\/internal\/image-builds\/([a-f0-9-]+)\/(source|status)$/);
    if (!match || !UUID.test(match[1])) return authJson({ error: 'not_found' }, 404, {});
    await expireImageBuilds(env);
    const id = match[1];
    const now = new Date().toISOString();
    if (match[2] === 'source' && request.method === 'POST') {
      const result = await env.DB.prepare("UPDATE container_images SET status = 'building', updated_at = ? WHERE id = ? AND status = 'queued' AND deadline > ?")
        .bind(now, id, now).run();
      if (!result.meta.changes) return authJson({ error: 'build_not_available' }, 409, {});
      const image = await env.DB.prepare('SELECT * FROM container_images WHERE id = ?').bind(id).first<ImageRow>();
      return authJson({ dockerfile: image!.dockerfile, contextBase64: image!.context_base64 }, 200, {});
    }
    if (match[2] !== 'status' || request.method !== 'POST') return authJson({ error: 'method_not_allowed' }, 405, {});
    const bytes = await boundedBody(request, 80 * 1024);
    if (!bytes) return authJson({ error: 'invalid_request' }, 400, {});
    let body: { status?: string; image?: string; logs?: string };
    try { body = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { return authJson({ error: 'invalid_request' }, 400, {}); }
    if (!body || !['failed', 'publishing', 'ready'].includes(body.status || '') || (body.logs !== undefined && typeof body.logs !== 'string')) {
      return authJson({ error: 'invalid_request' }, 400, {});
    }
    const image = await env.DB.prepare('SELECT * FROM container_images WHERE id = ?').bind(id).first<ImageRow>();
    if (!image) return authJson({ error: 'not_found' }, 404, {});
    if (body.status === 'publishing' && (typeof body.image !== 'string'
      || !new RegExp(`^registry\\.cloudflare\\.com/${ACCOUNT_ID}/mainbrella-custom-${id}@sha256:[a-f0-9]{64}$`).test(body.image))) {
      return authJson({ error: 'invalid_image_reference' }, 400, {});
    }
    const previous = body.status === 'publishing' ? ['building'] : body.status === 'ready' ? ['publishing'] : ['queued', 'building', 'publishing'];
    if (!previous.includes(image.status)) return authJson({ error: 'invalid_build_transition' }, 409, {});
    const logs = (body.logs ?? image.logs).slice(-64 * 1024);
    const saved = await env.DB.prepare(`UPDATE container_images SET status = ?, image_ref = ?, logs = ?, updated_at = ?, context_base64 = NULL
      WHERE id = ? AND status = ? AND deadline > ?
      ${body.status === 'publishing' ? "AND NOT EXISTS (SELECT 1 FROM container_images WHERE status = 'publishing')" : ''}`).bind(body.status, body.status === 'publishing' ? body.image : image.image_ref,
      logs, now, id, image.status, now).run();
    return authJson(saved.meta.changes ? { updated: true } : { error: body.status === 'publishing' ? 'image_publication_busy' : 'invalid_build_transition' }, saved.meta.changes ? 200 : 409, {});
  } catch { return authJson({ error: 'image_builds_unavailable' }, 503, {}); }
}
