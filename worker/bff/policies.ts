import { BffError, filterInput, LIMITS, parse, tableNameInput, tablePolicyInput, type DatabasePrincipal, type Project, type TablePolicy } from './contracts';
import { ProjectDatabase } from './database';
import { body, readyProject } from './http';
import { identifier } from './sql';
import { deleteQuery, insertQuery, selectQuery, updateQuery } from './table-queries';

const policyColumns = 'table_name AS "table",select_access AS "select",insert_access AS "insert",update_access AS "update",delete_access AS "delete",owner_column AS ownerColumn,updated_at';

// The principal is constructed by the trusted gateway, never from function input
// or caller-supplied row filters. Every anonymous database operation uses this gate.
export async function authorizeTable(env: Env, project: Project, principal: DatabasePrincipal, table: string, operation: 'select' | 'insert' | 'update' | 'delete') {
  identifier(table);
  if (principal.role === 'owner') return;
  const grant = await env.DB.prepare(`SELECT g.tables,p.select_access,p.insert_access,p.update_access,p.delete_access,p.owner_column
    FROM bff_api_key_grants g JOIN api_keys k ON k.id=g.api_key_id
    LEFT JOIN bff_table_policies p ON p.project_id=g.project_id AND p.table_name=?
    WHERE g.api_key_id=? AND g.project_id=? AND k.user_id=?`)
    .bind(table, principal.keyId, project.id, project.user_id).first<{
      tables: string; select_access: string | null; insert_access: string | null; update_access: string | null; delete_access: string | null; owner_column: string | null;
    }>();
  if (!grant) throw new BffError('permission_denied', 403);
  const tables = JSON.parse(grant.tables) as Record<string, string[]>;
  if (!Object.hasOwn(tables, table) || !tables[table].includes(operation)) throw new BffError('permission_denied', 403);
  if (principal.role === 'user') {
    const session = await env.DB.prepare('SELECT id FROM bff_user_sessions WHERE id=? AND project_id=? AND user_id=? AND expires_at>?')
      .bind(principal.sessionId, project.id, principal.userId, new Date().toISOString()).first();
    if (!session) throw new BffError('unauthorized', 401);
    // Deleting a project-local user invalidates its sessions as well.
    const [users] = await new ProjectDatabase(env, project).query([{ sql: 'SELECT id FROM users WHERE id=?', params: [principal.userId] }]);
    if (!users.results.length) throw new BffError('unauthorized', 401);
  }
  if (operation === 'select' && grant.select_access === 'public') return;
  if (operation !== 'select' && principal.role === 'user' && grant[`${operation}_access`] === 'own' && grant.owner_column) {
    identifier(grant.owner_column);
    return { column: grant.owner_column, value: principal.userId };
  }
  throw new BffError('permission_denied', 403);
}

// Both direct requests and isolated functions compile through this path. The
// ownership predicate is part of the UPDATE/DELETE, avoiding a check/write race.
export async function authorizedQuery(env: Env, project: Project, principal: DatabasePrincipal, table: string,
  operation: 'select' | 'insert' | 'update' | 'delete', input: { filters?: unknown; row?: unknown; limit?: number; offset?: number; select?: string; order?: string }) {
  const ownership = await authorizeTable(env, project, principal, table, operation);
  if (operation === 'select') return selectQuery(table, input.filters, input.limit, input.offset, input.select, input.order);
  if (operation === 'delete') return deleteQuery(table, input.filters, ownership);
  let row = input.row;
  if (ownership) {
    const values = parse(filterInput, row);
    // SQLite column names are case-insensitive. Check every alias so duplicate
    // spellings cannot bypass the proposed-row ownership check on UPDATE/INSERT.
    for (const [column, value] of Object.entries(values)) {
      // A rowid alias can also write an INTEGER PRIMARY KEY owner column.
      // Reserve these fields for own-row writes, including after schema changes.
      if (/^(?:rowid|oid|_rowid_)$/i.test(column)) throw new BffError('permission_denied', 403);
      if (column.toLowerCase() === ownership.column.toLowerCase() && value !== ownership.value) throw new BffError('permission_denied', 403);
    }
    row = operation === 'insert' ? { ...values, [ownership.column]: ownership.value } : values;
  }
  return operation === 'insert' ? insertQuery(table, row) : updateQuery(table, input.filters, row, ownership);
}

export async function managePolicies(request: Request, env: Env, project: Project, table?: string) {
  if (!table) {
    if (request.method !== 'GET') throw new BffError('method_not_allowed', 405);
    const rows = await env.DB.prepare(`SELECT ${policyColumns} FROM bff_table_policies WHERE project_id=? ORDER BY table_name`)
      .bind(project.id).all<TablePolicy>();
    return { policies: rows.results };
  }
  parse(tableNameInput, table);
  if (request.method === 'DELETE') {
    await env.DB.prepare('DELETE FROM bff_table_policies WHERE project_id=? AND table_name=?').bind(project.id, table).run();
    return { revoked: true };
  }
  if (request.method !== 'PUT') throw new BffError('method_not_allowed', 405);
  readyProject(env, project);
  const input = parse(tablePolicyInput, await body(request));
  if (input.ownerColumn) identifier(input.ownerColumn);
  const [schema] = await new ProjectDatabase(env, project).query([{ sql: "SELECT name FROM sqlite_schema WHERE type='table' AND name=?", params: [table] }]);
  if (!schema.results.length) throw new BffError('table_not_found', 404);
  if (input.ownerColumn) {
    const [columns] = await new ProjectDatabase(env, project).query([{ sql: 'SELECT name FROM pragma_table_info(?) WHERE name=?', params: [table, input.ownerColumn] }]);
    if (!columns.results.length) throw new BffError('column_not_found', 404);
  }
  const policy: TablePolicy = { table, ...input, updated_at: new Date().toISOString() };
  const result = await env.DB.prepare(`INSERT INTO bff_table_policies(project_id,table_name,select_access,insert_access,update_access,delete_access,owner_column,updated_at)
    SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM bff_table_policies WHERE project_id=? AND table_name=?)
      OR (SELECT COUNT(*) FROM bff_table_policies WHERE project_id=?) < ?
    ON CONFLICT(project_id,table_name) DO UPDATE SET select_access=excluded.select_access,insert_access=excluded.insert_access,
      update_access=excluded.update_access,delete_access=excluded.delete_access,owner_column=excluded.owner_column,updated_at=excluded.updated_at`)
    .bind(project.id, table, policy.select, policy.insert, policy.update, policy.delete, policy.ownerColumn, policy.updated_at, project.id, table, project.id, LIMITS.tablePolicies).run();
  if (!result.meta.changes) throw new BffError('table_policy_limit', 429);
  return { policy };
}
