import { z } from 'zod';
import { authJson } from '../app/auth-core';
import { recordApiKeyUse } from '../app/api-keys';
import { demoConfig, demoUsers, localDemoConfig } from './demo-config';
import { BffError, checksum, parse, type Project } from './contracts';
import { body } from './http';
import { issueUserSession } from './sessions';

export const demoSessionInput = z.object({ userId: z.enum(demoUsers) }).strict();

// Deliberate public-login exception for this single example. General BFF
// sessions remain owner-only, and data requests still enforce grants and RLS.
export async function handleDemoSessionRequest(request: Request, env: Env): Promise<Response> {
  const config = env.LOCAL_DEV === 'true' ? localDemoConfig : demoConfig;
  const cors: Record<string, string> = { vary: 'Origin' };
  const reply = (data: unknown, status = 200) => authJson(data, status, cors);
  try {
    if (new URL(request.url).search) throw new BffError('invalid_request');
    const preflight = request.method === 'OPTIONS';
    if (!preflight && request.headers.get('apikey') !== config.publicKey) throw new BffError('unauthorized', 401);
    // Resolve the current shared record and grant even for preflight. A revoked
    // key, a grant moved to another project, or changed ownership disables login.
    const key = await env.DB.prepare(`SELECT k.id,g.origins FROM api_keys k
      JOIN bff_api_key_grants g ON g.api_key_id=k.id
      JOIN bff_projects p ON p.id=g.project_id AND p.user_id=k.user_id
      WHERE k.token_hash=? AND k.prefix GLOB 'bff_pk_*' AND g.project_id=?`)
      .bind(await checksum(config.publicKey), config.projectId).first<{ id: string; origins: string }>();
    if (!key) throw new BffError('unauthorized', 401);
    const project = await env.DB.prepare('SELECT * FROM bff_projects WHERE id=?').bind(config.projectId).first<Project>();
    if (!project || project.template !== 'message_board') throw new BffError('not_found', 404);
    const origin = request.headers.get('origin');
    if (origin && !(JSON.parse(key.origins) as string[]).includes(origin)) throw new BffError('origin_not_allowed', 403);
    if (origin) cors['access-control-allow-origin'] = origin;
    if (preflight) {
      const method = request.headers.get('access-control-request-method');
      const headers = (request.headers.get('access-control-request-headers') || '').toLowerCase().split(',').map(value => value.trim()).filter(Boolean);
      if ((method && !['POST', 'DELETE'].includes(method)) || headers.some(header => !['apikey', 'authorization', 'content-type'].includes(header))) throw new BffError('origin_not_allowed', 403);
      return new Response(null, { status: 204, headers: { ...cors, 'cache-control': 'no-store',
        'access-control-allow-methods': 'POST, DELETE, OPTIONS',
        'access-control-allow-headers': 'apikey, authorization, content-type', 'access-control-max-age': '600' } });
    }
    if (request.method === 'POST') {
      if (request.headers.has('authorization')) throw new BffError('unauthorized', 401);
      const { userId } = parse(demoSessionInput, await body(request, 1024));
      const result = await issueUserSession(env, project, userId);
      await recordApiKeyUse(env, key.id);
      return reply(result.data, result.status);
    }
    if (request.method === 'DELETE') {
      const token = /^Bearer (bff_us_[a-f0-9]{64})$/.exec(request.headers.get('authorization') || '')?.[1];
      if (!token) throw new BffError('unauthorized', 401);
      // Idempotent and available while paused/disabled, like owner revocation.
      await env.DB.prepare('DELETE FROM bff_user_sessions WHERE project_id=? AND token_hash=?')
        .bind(config.projectId, await checksum(token)).run();
      await recordApiKeyUse(env, key.id);
      return reply({ revoked: true });
    }
    throw new BffError('method_not_allowed', 405);
  } catch (error) {
    if (error instanceof BffError) return reply({ error: error.code }, error.status);
    console.error('bff_demo_session_failed');
    return reply({ error: 'bff_unavailable' }, 503);
  }
}
