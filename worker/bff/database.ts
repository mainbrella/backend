import { boundedBody } from '../shared/bounded-body.js';
import { BffError, LIMITS, type Project, type QueryResult, type SqlQuery } from './contracts';

export const PROJECT_SCHEMA = `CREATE TABLE IF NOT EXISTS _bff_migrations (
  sequence INTEGER PRIMARY KEY CHECK(sequence > 0),
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL,
  sql TEXT NOT NULL,
  applied_at TEXT NOT NULL
)`;

export function databaseAvailable(env: Env): boolean {
  // Local development must never fall through to real customer databases.
  return env.LOCAL_DEV === 'true'
    ? !!env.BFF_LOCAL_URL && !!env.BFF_LOCAL_TOKEN
    : !!env.BFF_CLOUDFLARE_ACCOUNT_ID && !!env.BFF_CLOUDFLARE_API_TOKEN;
}

export async function reserveBudget(env: Env, projectId: string, kind: 'queries' | 'invocations', amount = 1) {
  const limit = kind === 'queries' ? LIMITS.queriesPerDay : LIMITS.invocationsPerDay;
  const result = await env.DB.prepare(`INSERT INTO bff_daily_usage (project_id,day,${kind}) VALUES (?,?,?)
    ON CONFLICT(project_id,day) DO UPDATE SET ${kind}=${kind}+? WHERE ${kind}+? <= ?`)
    .bind(projectId, new Date().toISOString().slice(0, 10), amount, amount, amount, limit).run();
  if (!result.meta.changes) throw new BffError('daily_budget_exceeded', 429);
}

export class ProjectDatabase {
  constructor(private env: Env, private project: Pick<Project, 'id' | 'database_id'>) {}

  private async api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const local = this.env.LOCAL_DEV === 'true';
    const { BFF_CLOUDFLARE_ACCOUNT_ID: account, BFF_CLOUDFLARE_API_TOKEN: token } = this.env;
    if (!databaseAvailable(this.env) || (!local && !/^[a-f0-9]{32}$/i.test(account ?? ''))) throw new BffError('database_unavailable', 503);
    const base = local ? this.env.BFF_LOCAL_URL : `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database`;
    try {
      const response = await fetch(`${base}${path}`, {
        ...init, redirect: 'manual', signal: AbortSignal.timeout(10_000),
        headers: { authorization: `Bearer ${local ? this.env.BFF_LOCAL_TOKEN : token}`, 'content-type': 'application/json' },
      });
      if (init.method === 'DELETE' && response.status === 404) { await response.body?.cancel(); return null as T; }
      if (response.status >= 300 && response.status < 400) throw new BffError('database_unavailable', 502);
      const bytes = await boundedBody(response.body, 2 * 1024 * 1024);
      const body = JSON.parse(new TextDecoder().decode(bytes)) as { success: boolean; result: T };
      if (!response.ok || !body.success) throw new BffError(init.method === 'POST' && path.endsWith('/query') ? 'database_query_failed' : 'database_unavailable', 502);
      return body.result;
    } catch (error) {
      if (error instanceof BffError) throw error;
      throw new BffError('database_unavailable', 503);
    }
  }

  async remove(): Promise<void> {
    let id = this.project.database_id;
    if (!id) {
      const name = this.databaseName();
      const existing = await this.api<{ uuid: string; name: string }[]>(`?name=${encodeURIComponent(name)}`);
      id = existing.find(database => database.name === name)?.uuid ?? null;
    }
    if (!id) return;
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new BffError('database_unavailable', 502);
    await this.api(`/${id}`, { method: 'DELETE' });
  }

  async provision(): Promise<string> {
    const name = this.databaseName();
    let id = this.project.database_id;
    if (!id) {
      // Deterministic names let retries recover from a lost create response.
      const existing = await this.api<{ uuid: string; name: string }[]>(`?name=${encodeURIComponent(name)}`);
      id = existing.find(database => database.name === name)?.uuid ?? null;
      if (!id) id = (await this.api<{ uuid: string }>('', { method: 'POST', body: JSON.stringify({ name }) })).uuid;
      if (!id || !/^[a-f0-9-]{36}$/i.test(id)) throw new BffError('database_unavailable', 502);
      await this.env.DB.prepare('UPDATE bff_projects SET database_id=? WHERE id=?').bind(id, this.project.id).run();
      this.project.database_id = id;
    }
    await this.query([{ sql: PROJECT_SCHEMA }]);
    return id;
  }

  private databaseName(): string {
    return `bff-${this.env.LOCAL_DEV === 'true' ? 'local' : this.env.DEPLOYMENT_ENVIRONMENT || 'production'}-${this.project.id}`;
  }

  async query(batch: SqlQuery[]): Promise<QueryResult[]> {
    const id = this.project.database_id;
    if (!id || !/^[a-f0-9-]{36}$/i.test(id)) throw new BffError('database_not_ready', 409);
    await reserveBudget(this.env, this.project.id, 'queries', batch.length);
    const results = await this.api<QueryResult[]>(`/${id}/query`, { method: 'POST', body: JSON.stringify({ batch }) });
    if (!Array.isArray(results) || results.length !== batch.length || results.some(result => !result.success)) throw new BffError('database_query_failed', 502);
    return results;
  }
}
