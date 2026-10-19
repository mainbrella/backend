import { BffError, filterInput, LIMITS, parse, tableReadInput, type SqlQuery } from './contracts';
import { identifier } from './sql';

function values(value: unknown) {
  if (new TextEncoder().encode(JSON.stringify(value)).length > LIMITS.inputBytes) throw new BffError('database_input_too_large', 413);
  return Object.entries(parse(filterInput, value)).map(([key, item]) => [identifier(key), item] as const);
}
function where(value: unknown, required = false) {
  const entries = values(value);
  if (required && !entries.length) throw new BffError('filter_required');
  return { sql: entries.length ? ` WHERE ${entries.map(([key]) => `${key} IS ?`).join(' AND ')}` : '', params: entries.map(([, item]) => item) };
}
type Ownership = { column: string; value: string };
function ownedWhere(value: unknown, ownership?: Ownership) {
  const filter = where(value, true);
  return ownership ? { sql: `${filter.sql} AND ${identifier(ownership.column)} IS ?`, params: [...filter.params, ownership.value] } : filter;
}

export function selectQuery(table: string, filters: unknown = {}, limit = 100, offset = 0, select = '*', order?: string): SqlQuery {
  const input = parse(tableReadInput, { select, limit, offset, order });
  const columns = input.select === '*' ? '*' : input.select.split(',').map(identifier).join(',');
  if (input.select !== '*' && input.select.split(',').length > 50) throw new BffError('invalid_request');
  let ordering = '';
  if (input.order) {
    const match = /^([a-zA-Z][a-zA-Z0-9_]{0,62})\.(asc|desc)$/.exec(input.order);
    if (!match) throw new BffError('invalid_request');
    ordering = ` ORDER BY ${identifier(match[1])} ${match[2].toUpperCase()}`;
  }
  const filter = where(filters);
  return { sql: `SELECT ${columns} FROM ${identifier(table)}${filter.sql}${ordering} LIMIT ? OFFSET ?`, params: [...filter.params, input.limit, input.offset] };
}
export function insertQuery(table: string, row: unknown): SqlQuery {
  const entries = values(row);
  if (!entries.length) throw new BffError('row_required');
  // Override schema-level REPLACE rules, which can delete another user's row
  // without going through its ownership predicate or delete permission.
  return { sql: `INSERT OR ABORT INTO ${identifier(table)} (${entries.map(([key]) => key).join(',')}) VALUES (${entries.map(() => '?').join(',')}) RETURNING *`, params: entries.map(([, item]) => item) };
}
export function updateQuery(table: string, filters: unknown, row: unknown, ownership?: Ownership): SqlQuery {
  const filter = ownedWhere(filters, ownership), entries = values(row);
  if (!entries.length) throw new BffError('row_required');
  return { sql: `UPDATE OR ABORT ${identifier(table)} SET ${entries.map(([key]) => `${key}=?`).join(',')}${filter.sql} RETURNING *`, params: [...entries.map(([, item]) => item), ...filter.params] };
}
export function deleteQuery(table: string, filters: unknown, ownership?: Ownership): SqlQuery {
  const filter = ownedWhere(filters, ownership);
  return { sql: `DELETE FROM ${identifier(table)}${filter.sql}`, params: filter.params };
}

// A deliberately small PostgREST-style surface: column=eq.value or is.null.
// Filters are ANDed. Values never become SQL text, and duplicate keys are rejected.
export function tableParameters(search: URLSearchParams, read: boolean) {
  const options: Record<string, string> = {}, filters: Record<string, string | null> = Object.create(null);
  const seen = new Set<string>();
  for (const [key, value] of search) {
    if (seen.has(key)) throw new BffError('invalid_request');
    seen.add(key);
    if (read && ['select', 'limit', 'offset', 'order'].includes(key)) { options[key] = value; continue; }
    identifier(key);
    if (value === 'is.null') filters[key] = null;
    else if (value.startsWith('eq.')) filters[key] = value.slice(3);
    else throw new BffError('invalid_filter');
  }
  return { filters, ...parse(tableReadInput, options) };
}
