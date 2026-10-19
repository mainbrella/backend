import { BffError, LIMITS, type DatabasePrincipal, type FunctionVersion, type Project } from './contracts';
import { reserveBudget } from './database';
import { executeFunction } from './runtime';

export async function invokeFunction(env: Env, project: Project, fn: FunctionVersion, input: unknown, principal: DatabasePrincipal) {
  if (!env.BFF_LOADER) throw new BffError('function_runtime_unavailable', 503);
  await reserveBudget(env, project.id, 'invocations');
  const id = crypto.randomUUID(), started = Date.now();
  const running = await env.DB.prepare(`INSERT INTO bff_executions (id,project_id,function_name,version,status,expires_at,created_at)
    SELECT ?,?,?,?,'running',?,? WHERE (SELECT COUNT(*) FROM bff_executions WHERE project_id=? AND status='running' AND expires_at>?) < ?`)
    .bind(id, project.id, fn.name, fn.version, started + LIMITS.wallMs, new Date(started).toISOString(), project.id, started, LIMITS.concurrentInvocations).run();
  if (!running.meta.changes) throw new BffError('concurrency_limit', 429);
  let status = 'error', errorCode: string | null = null;
  try {
    const result = await executeFunction(env, project, fn, input, principal);
    status = result.ok ? 'success' : 'error'; errorCode = result.ok ? null : 'function_error';
    return { id, version: fn.version, ...result };
  } catch (error) {
    errorCode = error instanceof BffError ? error.code : 'function_failed';
    status = errorCode === 'function_timeout' ? 'timeout' : 'error';
    throw error;
  } finally {
    await env.DB.prepare('UPDATE bff_executions SET status=?,error=?,duration_ms=? WHERE id=?').bind(status, errorCode, Date.now() - started, id).run();
  }
}
