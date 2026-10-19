import { RpcTarget } from 'cloudflare:workers';
import { BffError, LIMITS, type DatabasePrincipal, type Project } from './contracts';
import { ProjectDatabase } from './database';
import { authorizedQuery } from './policies';

// This object crosses the isolate boundary via RPC. Its private fields, parent
// environment, credentials and database ID do not. No raw SQL method is exposed.
export class DatabaseCapability extends RpcTarget {
  #remaining = LIMITS.databaseCalls as number;
  #closed = false;
  #expires = Date.now() + LIMITS.wallMs;
  #env: Env;
  #project: Project;
  #access: 'read' | 'write';
  #principal: DatabasePrincipal;
  constructor(env: Env, project: Project, access: 'read' | 'write', principal: DatabasePrincipal) {
    super(); this.#env = env; this.#project = project; this.#access = access; this.#principal = principal;
  }
  // Only the parent owns this setter; exposing close can only revoke access.
  close() { this.#closed = true; }

  async #query(table: string, operation: 'select' | 'insert' | 'update' | 'delete', input: Parameters<typeof authorizedQuery>[5]) {
    if (this.#closed || Date.now() >= this.#expires) throw new BffError('execution_expired');
    if (this.#remaining-- <= 0) throw new BffError('database_call_limit');
    if (operation !== 'select' && this.#access !== 'write') throw new BffError('database_write_denied');
    const project = await this.#env.DB.prepare('SELECT suspended,blocked,state FROM bff_projects WHERE id=?').bind(this.#project.id).first<Project>();
    if (!project || project.blocked || project.suspended || project.state !== 'ready' || this.#env.BFF_ENABLED !== 'true') throw new BffError('project_unavailable');
    const query = await authorizedQuery(this.#env, this.#project, this.#principal, table, operation, input);
    if (this.#closed || Date.now() >= this.#expires) throw new BffError('execution_expired');
    const [result] = await new ProjectDatabase(this.#env, this.#project).query([query]);
    const output = JSON.stringify(result);
    if (new TextEncoder().encode(output).length > LIMITS.outputBytes) throw new BffError('database_result_too_large');
    return result;
  }

  async select(table: string, where: unknown = {}, limit = 100) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new BffError('invalid_limit');
    return this.#query(table, 'select', { filters: where, limit });
  }
  async insert(table: string, row: unknown) {
    return this.#query(table, 'insert', { row });
  }
  async update(table: string, where: unknown, row: unknown) {
    return this.#query(table, 'update', { filters: where, row });
  }
  async remove(table: string, where: unknown) {
    return this.#query(table, 'delete', { filters: where });
  }
}
