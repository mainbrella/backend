import { BffError, checksum, parse, sessionInput, type Project } from './contracts';
import { ProjectDatabase } from './database';
import { body, readyProject } from './http';

export async function manageSessions(request: Request, env: Env, project: Project, id?: string) {
  if (id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new BffError('not_found', 404);
    if (request.method !== 'DELETE') throw new BffError('method_not_allowed', 405);
    await env.DB.prepare('DELETE FROM bff_user_sessions WHERE project_id=? AND id=?').bind(project.id, id).run();
    return { data: { revoked: true }, status: 200 };
  }
  if (request.method === 'GET') {
    const sessions = await env.DB.prepare('SELECT id,user_id,expires_at,created_at FROM bff_user_sessions WHERE project_id=? AND expires_at>? ORDER BY created_at DESC')
      .bind(project.id, new Date().toISOString()).all();
    return { data: { sessions: sessions.results }, status: 200 };
  }
  if (request.method !== 'POST') throw new BffError('method_not_allowed', 405);
  readyProject(env, project);
  const { userId } = parse(sessionInput, await body(request));
  return issueUserSession(env, project, userId);
}

export async function issueUserSession(env: Env, project: Project, userId: string, maxAgeMs = 3_600_000) {
  readyProject(env, project);
  const [users] = await new ProjectDatabase(env, project).query([{ sql: 'SELECT id FROM users WHERE id=?', params: [userId] }]);
  if (!users.results.length) throw new BffError('user_not_found', 404);
  const now = Date.now();
  const created = new Date(now).toISOString(), expires = new Date(now + maxAgeMs).toISOString();
  await env.DB.prepare('DELETE FROM bff_user_sessions WHERE project_id=? AND expires_at<=?').bind(project.id, created).run();
  const sessionId = crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = `bff_us_${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`;
  const inserted = await env.DB.prepare(`INSERT INTO bff_user_sessions(id,project_id,user_id,token_hash,expires_at,created_at)
    SELECT ?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM bff_user_sessions WHERE project_id=?) < 100`)
    .bind(sessionId, project.id, userId, await checksum(token), expires, created, project.id).run();
  if (!inserted.meta.changes) throw new BffError('session_limit', 429);
  return { data: { session: { id: sessionId, user_id: userId, expires_at: expires, created_at: created }, token }, status: 201 };
}
