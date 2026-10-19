import { z } from 'zod';
import { authJson } from '../app/auth-core';
import { hashPassword, verifyPassword } from '../app/auth-email';
import { recordApiKeyUse } from '../app/api-keys';
import { BffError, checksum, parse, type Project } from './contracts';
import { ProjectDatabase } from './database';
import { body, readyProject } from './http';
import { issueUserSession } from './sessions';

export const emailLoginInput = z.object({
  email: z.string().trim().toLowerCase().max(254).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/),
  password: z.string().min(1).max(128),
}).strict();

type EmailAccount = { email: string; user_id: string; password_hash: string; provisioned: number };
const publicUser = (account: Pick<EmailAccount, 'user_id' | 'email'>) => ({ id: account.user_id, email: account.email });

// Message-board applications use real project users and standard bff_us_ tokens.
// Mainbrella owner cookies and the Alice/Bob demo cannot authenticate these routes.
export async function handleEmailAuthRequest(request: Request, env: Env): Promise<Response> {
  const cors: Record<string, string> = { vary: 'Origin' };
  const reply = (data: unknown, status = 200) => authJson(data, status, cors);
  try {
    const url = new URL(request.url);
    const match = /^\/bff\/data\/([a-f0-9-]{36})\/auth\/(email|session)$/.exec(url.pathname);
    if (!match) throw new BffError('not_found', 404);
    if (url.search) throw new BffError('invalid_request');
    const [, projectId, resource] = match;
    const methods = resource === 'email' ? ['POST'] : ['GET', 'DELETE'];
    const preflight = request.method === 'OPTIONS';
    const token = request.headers.get('apikey');
    if (!preflight && !/^bff_pk_[a-f0-9]{64}$/.test(token || '')) throw new BffError('unauthorized', 401);
    const origin = request.headers.get('origin');
    // Preflight has no credentials. Actual requests recheck the exact live key,
    // project ownership, and that key's own origins, just like the Data API.
    const keys = await env.DB.prepare(`SELECT k.id,g.origins FROM api_keys k
      JOIN bff_api_key_grants g ON g.api_key_id=k.id
      JOIN bff_projects p ON p.id=g.project_id AND p.user_id=k.user_id
      WHERE g.project_id=? AND k.prefix GLOB 'bff_pk_*'${preflight ? '' : ' AND k.token_hash=?'}`)
      .bind(projectId, ...(preflight ? [] : [await checksum(token!)])).all<{ id: string; origins: string }>();
    if (!keys.results.length) throw new BffError('unauthorized', 401);
    const key = keys.results.find(key => !origin || (JSON.parse(key.origins) as string[]).includes(origin));
    if (!key) throw new BffError('origin_not_allowed', 403);
    if (origin) cors['access-control-allow-origin'] = origin;
    const project = await env.DB.prepare('SELECT * FROM bff_projects WHERE id=?').bind(projectId).first<Project>();
    if (!project || project.template !== 'message_board') throw new BffError('not_found', 404);
    if (preflight) {
      const method = request.headers.get('access-control-request-method');
      const headers = (request.headers.get('access-control-request-headers') || '').toLowerCase().split(',').map(value => value.trim()).filter(Boolean);
      if ((method && !methods.includes(method)) || headers.some(header => !['apikey', 'authorization', 'content-type'].includes(header))) throw new BffError('origin_not_allowed', 403);
      return new Response(null, { status: 204, headers: { ...cors, 'cache-control': 'no-store',
        'access-control-allow-methods': [...methods, 'OPTIONS'].join(', '),
        'access-control-allow-headers': 'apikey, authorization, content-type', 'access-control-max-age': '600' } });
    }
    if (!methods.includes(request.method)) throw new BffError('method_not_allowed', 405);
    if (resource === 'email') {
      if (request.headers.has('authorization')) throw new BffError('unauthorized', 401);
      readyProject(env, project);
      const address = request.headers.get('CF-Connecting-IP');
      if (!address || !env.EMAIL_AUTH_LIMIT) throw new BffError('auth_unavailable', 503);
      const limited = await env.EMAIL_AUTH_LIMIT.limit({ key: `bff-email:${projectId}:${address}` });
      if (!limited.success) throw new BffError('rate_limited', 429);
      const { email, password } = parse(emailLoginInput, await body(request, 2048));
      const readAccount = () => env.DB.prepare('SELECT email,user_id,password_hash,provisioned FROM bff_email_accounts WHERE project_id=? AND email=?')
        .bind(projectId, email).first<EmailAccount>();
      let account = await readAccount();
      let created = false;
      if (account) {
        if (!await verifyPassword(password, account.password_hash)) throw new BffError('invalid_credentials', 401);
      } else {
        if (password.length < 8) throw new BffError('weak_password');
        const userId = crypto.randomUUID();
        const hash = await hashPassword(password);
        await env.DB.prepare(`INSERT INTO bff_email_accounts(project_id,email,user_id,password_hash,created_at)
          VALUES(?,?,?,?,?) ON CONFLICT(project_id,email) DO NOTHING`)
          .bind(projectId, email, userId, hash, new Date().toISOString()).run();
        account = await readAccount();
        if (!account) throw new BffError('auth_unavailable', 503);
        created = account.user_id === userId;
        // A concurrent signup must authenticate the winning password.
        if (!created && !await verifyPassword(password, account.password_hash)) throw new BffError('invalid_credentials', 401);
      }
      if (!account.provisioned) {
        // Recoverable across the two databases: retry only this idempotent insert
        // after a provider failure. Never recreate a deliberately deleted user.
        await new ProjectDatabase(env, project).query([{
          sql: 'INSERT INTO users(id,name) VALUES(?,?) ON CONFLICT(id) DO NOTHING',
          params: [account.user_id, email.split('@')[0].slice(0, 80)],
        }]);
        await env.DB.prepare('UPDATE bff_email_accounts SET provisioned=1 WHERE project_id=? AND email=?')
          .bind(projectId, email).run();
      }
      const result = await issueUserSession(env, project, account.user_id);
      await recordApiKeyUse(env, key.id);
      return reply({ ...result.data, user: publicUser(account), created }, result.status);
    }
    const sessionToken = /^Bearer (bff_us_[a-f0-9]{64})$/.exec(request.headers.get('authorization') || '')?.[1];
    if (!sessionToken) throw new BffError('unauthorized', 401);
    const hash = await checksum(sessionToken);
    if (request.method === 'DELETE') {
      // Revocation remains available while paused/disabled and is idempotent.
      await env.DB.prepare('DELETE FROM bff_user_sessions WHERE project_id=? AND token_hash=?').bind(projectId, hash).run();
      return reply({ revoked: true });
    }
    readyProject(env, project);
    const session = await env.DB.prepare('SELECT id,user_id,expires_at,created_at FROM bff_user_sessions WHERE project_id=? AND token_hash=? AND expires_at>?')
      .bind(projectId, hash, new Date().toISOString()).first<{ id: string; user_id: string; expires_at: string; created_at: string }>();
    if (!session) throw new BffError('unauthorized', 401);
    const account = await env.DB.prepare('SELECT email,user_id FROM bff_email_accounts WHERE project_id=? AND user_id=? AND provisioned=1')
      .bind(projectId, session.user_id).first<Pick<EmailAccount, 'email' | 'user_id'>>();
    if (!account) throw new BffError('unauthorized', 401);
    const [users] = await new ProjectDatabase(env, project).query([{ sql: 'SELECT id FROM users WHERE id=?', params: [account.user_id] }]);
    if (!users.results.length) throw new BffError('unauthorized', 401);
    return reply({ session, user: publicUser(account) });
  } catch (error) {
    if (error instanceof BffError) return reply({ error: error.code }, error.status);
    console.error('bff_email_auth_failed');
    return reply({ error: 'auth_unavailable' }, 503);
  }
}
