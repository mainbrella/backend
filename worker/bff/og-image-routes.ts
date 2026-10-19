import { authCorsHeaders, authJson, currentUser } from '../app/auth-core';
import { apiKeyIdentity, apiKeyUser, recordApiKeyUse } from '../app/api-keys';
import { BffError, checksum, parse, type Project } from './contracts';
import { FETCH_LIMITS } from './fetch';
import { body, enabled, readyProject } from './http';
import { getOgImage, ogImageInput } from './og-image';

export async function handleOgImageRequest(request: Request, env: Env): Promise<Response> {
  const cors: Record<string, string> = { vary: 'Origin' };
  const reply = (data: unknown, status = 200) => authJson(data, status, cors);
  try {
    const origin = request.headers.get('origin');
    const ownerCors = authCorsHeaders(request, env);
    if (request.method === 'OPTIONS') {
      if (!ownerCors && origin) {
        // Preflights have no key. POST rechecks its own live key and session.
        const allowed = await env.DB.prepare(`SELECT 1 FROM api_keys k
          JOIN bff_api_key_grants g ON g.api_key_id=k.id
          JOIN bff_projects p ON p.id=g.project_id AND p.user_id=k.user_id
          WHERE k.prefix GLOB 'bff_pk_*' AND EXISTS(SELECT 1 FROM json_each(g.origins) WHERE value=?) LIMIT 1`)
          .bind(origin).first();
        if (!allowed) throw new BffError('origin_not_allowed', 403);
        cors['access-control-allow-origin'] = origin;
      } else Object.assign(cors, ownerCors);
      const method = request.headers.get('access-control-request-method');
      const headers = (request.headers.get('access-control-request-headers') || '').toLowerCase().split(',').map(value => value.trim()).filter(Boolean);
      const allowedHeaders = ['apikey', 'authorization', 'content-type', ...(ownerCors ? ['idempotency-key'] : [])];
      if ((method && method !== 'POST') || headers.some(header => !allowedHeaders.includes(header))) throw new BffError('origin_not_allowed', 403);
      return new Response(null, { status: 204, headers: { ...cors, 'cache-control': 'no-store',
        'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': allowedHeaders.join(', '),
        'access-control-max-age': '600' } });
    }
    const authorization = request.headers.get('authorization');
    const apiKey = request.headers.get('apikey');
    // Any explicit scoped credential selects project auth; never fall back to
    // an owner cookie after an invalid key, missing session, or revoked session.
    if (apiKey !== null || authorization?.startsWith('Bearer bff_us_')) {
      const sessionToken = /^Bearer (bff_us_[a-f0-9]{64})$/.exec(authorization || '')?.[1];
      if (!sessionToken || !/^bff_pk_[a-f0-9]{64}$/.test(apiKey || '')) throw new BffError('unauthorized', 401);
      const identity = await apiKeyIdentity(env, apiKey!);
      if (!identity?.prefix.startsWith('bff_pk_')) throw new BffError('unauthorized', 401);
      const project = await env.DB.prepare(`SELECT p.*,g.origins FROM bff_projects p
        JOIN bff_api_key_grants g ON g.project_id=p.id WHERE g.api_key_id=? AND p.user_id=?`)
        .bind(identity.key_id, identity.id).first<Project & { origins: string }>();
      if (!project) throw new BffError('unauthorized', 401);
      if (origin && !(JSON.parse(project.origins) as string[]).includes(origin)) throw new BffError('origin_not_allowed', 403);
      if (origin) cors['access-control-allow-origin'] = origin;
      readyProject(env, project);
      const session = await env.DB.prepare('SELECT id FROM bff_user_sessions WHERE project_id=? AND token_hash=? AND expires_at>?')
        .bind(project.id, await checksum(sessionToken), new Date().toISOString()).first();
      if (!session) throw new BffError('unauthorized', 401);
      await recordApiKeyUse(env, identity.key_id);
    } else {
      if (!ownerCors) throw new BffError('origin_not_allowed', 403);
      Object.assign(cors, ownerCors);
      const token = authorization?.match(/^Bearer (mb_[a-f0-9]{64})$/i)?.[1];
      const user = authorization !== null ? (token ? await apiKeyUser(env, token) : null) : await currentUser(env, request);
      if (!user) throw new BffError('unauthorized', 401);
    }
    if (request.method !== 'POST') throw new BffError('method_not_allowed', 405);
    enabled(env);
    const input = parse(ogImageInput, await body(request, FETCH_LIMITS.requestBytes));
    return reply({ image: await getOgImage(input.url, request.signal) });
  } catch (error) {
    if (error instanceof BffError) return reply({ error: error.code }, error.status);
    console.error('bff_og_image_failed');
    return reply({ error: 'bff_unavailable' }, 503);
  }
}
